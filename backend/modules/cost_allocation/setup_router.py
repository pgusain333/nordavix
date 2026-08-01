"""Nordavix Allocate — setup endpoints (the three registries + settings).

    GET/PUT  /settings
    GET/POST /pools · PUT/DELETE /pools/{id} · POST /pools/seed-defaults
    GET      /accounts            QBO expense accounts + mapping + suggestions
    PUT      /accounts/{qbo_id}   point an account at a pool
    GET/POST /spaces    · PUT/DELETE /spaces/{id}
    GET/POST /employees · PUT/DELETE /employees/{id}
    POST     /payroll/import
    GET      /readiness           can this client be run, and if not why

Mounted under the same /api/allocation prefix as the run endpoints.

Writes require `preparer`; changing the method election requires `reviewer`,
since it's the tax position rather than bookkeeping.
"""
import logging
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_role
from core.db.session import get_db
from models.cost_allocation import (
    AllocEmployee,
    AllocPayrollEntry,
    AllocPool,
    AllocSpace,
)
from models.qbo_connection import QboConnection
from models.user import User
from modules.cost_allocation.payroll_parser import match_rows, parse_payroll_file
from modules.cost_allocation.service import fetch_expense_chart
from modules.cost_allocation.setup_service import (
    MAP_EPOCH,
    compute_readiness,
    get_or_create_settings,
    seed_default_pools,
    serialize_employee,
    serialize_pool,
    serialize_space,
    set_account_pool,
)
from modules.cost_allocation.templates import suggest_mapping

router = APIRouter()
logger = logging.getLogger(__name__)


def _d(v) -> Decimal | None:
    return Decimal(str(v)) if v is not None else None


# ── Settings ──────────────────────────────────────────────────────────────────

class SettingsBody(BaseModel):
    method: str | None = None                 # books_records | afs
    has_afs: bool | None = None
    inventory_account_id: str | None = None
    inventory_account_name: str | None = None
    fiscal_year_end: str | None = None        # "MM-DD"
    allocation_frequency: str | None = None   # monthly | annual
    gross_receipts_threshold: float | None = None
    notes: str | None = None

    # Form 1125-A line 9 — the declarations half of the form.
    inv_valuation_method: str | None = None   # 9a
    inv_valuation_other: str | None = None
    inv_writedown_subnormal: bool | None = None   # 9b
    lifo_adopted: bool | None = None              # 9c
    lifo_closing_pct: float | None = None         # 9d
    sec263a_applies: bool | None = None           # 9e
    method_change_this_year: bool | None = None   # 9f
    method_change_note: str | None = None
    form_3115_filed: bool | None = None
    sec481a_adjustment: float | None = None


def _serialize_settings(cfg) -> dict:
    return {
        "method": cfg.method,
        "has_afs": cfg.has_afs,
        "inventory_method": cfg.inventory_method,
        "inventory_account_id": cfg.inventory_account_id,
        "inventory_account_name": cfg.inventory_account_name,
        "fiscal_year_end": cfg.fiscal_year_end,
        "allocation_frequency": cfg.allocation_frequency or "monthly",
        "gross_receipts_threshold": (
            str(cfg.gross_receipts_threshold) if cfg.gross_receipts_threshold is not None else None
        ),
        "election_attested_at": cfg.election_attested_at.isoformat() if cfg.election_attested_at else None,
        "notes": cfg.notes,
        # Form 1125-A line 9
        "inv_valuation_method": cfg.inv_valuation_method or "cost",
        "inv_valuation_other": cfg.inv_valuation_other,
        "inv_writedown_subnormal": bool(cfg.inv_writedown_subnormal),
        "lifo_adopted": bool(cfg.lifo_adopted),
        "lifo_closing_pct": (
            str(cfg.lifo_closing_pct) if cfg.lifo_closing_pct is not None else None
        ),
        "sec263a_applies": bool(cfg.sec263a_applies),
        "method_change_this_year": bool(cfg.method_change_this_year),
        "method_change_note": cfg.method_change_note,
        "form_3115_filed": bool(cfg.form_3115_filed),
        "sec481a_adjustment": (
            str(cfg.sec481a_adjustment) if cfg.sec481a_adjustment is not None else None
        ),
    }


@router.get("/settings")
async def get_settings(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    cfg = await get_or_create_settings(db, tenant_id)
    await db.commit()
    return _serialize_settings(cfg)


@router.put("/settings")
async def update_settings(
    body: SettingsBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Reviewer+ — the method election is the tax position, not bookkeeping."""
    if body.method is not None and body.method not in ("books_records", "afs"):
        raise HTTPException(status_code=422, detail="method must be 'books_records' or 'afs'.")
    if body.allocation_frequency is not None and body.allocation_frequency not in ("monthly", "annual"):
        raise HTTPException(
            status_code=422, detail="allocation_frequency must be 'monthly' or 'annual'.",
        )

    if body.inv_valuation_method is not None and body.inv_valuation_method not in (
        "cost", "lower_of_cost_or_market", "other"
    ):
        raise HTTPException(
            status_code=422,
            detail="inv_valuation_method must be cost, lower_of_cost_or_market or other.",
        )

    cfg = await get_or_create_settings(db, tenant_id)
    for field in (
        "method", "has_afs", "inventory_account_id", "inventory_account_name",
        "fiscal_year_end", "allocation_frequency", "notes",
        # Form 1125-A line 9
        "inv_valuation_method", "inv_valuation_other", "inv_writedown_subnormal",
        "lifo_adopted", "sec263a_applies", "method_change_this_year",
        "method_change_note", "form_3115_filed",
    ):
        value = getattr(body, field)
        if value is not None:
            setattr(cfg, field, value)
    if body.gross_receipts_threshold is not None:
        cfg.gross_receipts_threshold = _d(body.gross_receipts_threshold)
    if body.lifo_closing_pct is not None:
        cfg.lifo_closing_pct = _d(body.lifo_closing_pct)
    if body.sec481a_adjustment is not None:
        cfg.sec481a_adjustment = _d(body.sec481a_adjustment)

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.settings_updated", entity_type="alloc_settings", entity_id=cfg.id,
        metadata={"summary": f"Updated §471(c) settings (method: {cfg.method})"},
    )
    await db.commit()
    await db.refresh(cfg)
    return _serialize_settings(cfg)


# ── Pools ─────────────────────────────────────────────────────────────────────

class PoolBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    treatment: str
    driver: str | None = None
    blend_payroll_wt: float | None = None
    blend_occupancy_wt: float | None = None
    fixed_pct: float | None = None
    # Form 1125-A line at year end: 'labor' (line 3) or 'other' (line 5).
    form_1125a_line: str = "other"
    sort_order: int = 0
    notes: str | None = None


def _validate_pool(b: PoolBody) -> None:
    """Mirror the DB CHECK constraints with a readable message.

    The constraints are the real guarantee; this exists so the user gets
    "a blended pool needs weights that sum to 100" instead of a driver error.
    """
    if b.treatment not in ("direct", "allocated", "excluded"):
        raise HTTPException(status_code=422, detail="treatment must be direct, allocated or excluded.")
    if b.form_1125a_line not in ("labor", "other"):
        raise HTTPException(
            status_code=422,
            detail="form_1125a_line must be labor (Form 1125-A line 3) or other (line 5).",
        )
    if b.treatment == "allocated":
        if b.driver not in ("payroll", "occupancy", "blended", "fixed"):
            raise HTTPException(
                status_code=422,
                detail="An allocated pool needs a driver: payroll, occupancy, blended or fixed.",
            )
        if b.driver == "blended":
            wp, wo = b.blend_payroll_wt, b.blend_occupancy_wt
            if wp is None or wo is None or _d(wp) + _d(wo) != Decimal("100"):
                raise HTTPException(
                    status_code=422,
                    detail="A blended pool needs payroll and occupancy weights summing to 100.",
                )
        if b.driver == "fixed" and b.fixed_pct is None:
            raise HTTPException(status_code=422, detail="A fixed pool needs a rate.")
    elif b.driver is not None:
        raise HTTPException(
            status_code=422,
            detail="Only an allocated pool can have a driver; direct and excluded pools must not.",
        )


@router.get("/pools")
async def list_pools(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    pools = (await db.execute(
        select(AllocPool).order_by(AllocPool.sort_order, AllocPool.name)
    )).scalars().all()
    return [serialize_pool(p) for p in pools]


@router.post("/pools/seed-defaults", status_code=status.HTTP_201_CREATED)
async def seed_pools(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Seed the cannabis template's pools. Idempotent — never duplicates or
    overwrites a pool the preparer has tuned."""
    await seed_default_pools(db, tenant_id)
    await db.commit()
    pools = (await db.execute(
        select(AllocPool).order_by(AllocPool.sort_order, AllocPool.name)
    )).scalars().all()
    return [serialize_pool(p) for p in pools]


@router.post("/pools", status_code=status.HTTP_201_CREATED)
async def create_pool(
    body: PoolBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _validate_pool(body)
    pool = AllocPool(
        id=uuid.uuid4(), tenant_id=tenant_id, name=body.name.strip(),
        treatment=body.treatment, driver=body.driver,
        blend_payroll_wt=_d(body.blend_payroll_wt),
        blend_occupancy_wt=_d(body.blend_occupancy_wt),
        fixed_pct=_d(body.fixed_pct), form_1125a_line=body.form_1125a_line,
        sort_order=body.sort_order, notes=body.notes,
    )
    db.add(pool)
    await db.commit()
    await db.refresh(pool)
    return serialize_pool(pool)


@router.put("/pools/{pool_id}")
async def update_pool(
    pool_id: uuid.UUID,
    body: PoolBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _validate_pool(body)
    pool = (await db.execute(select(AllocPool).where(AllocPool.id == pool_id))).scalar_one_or_none()
    if pool is None:
        raise HTTPException(status_code=404, detail="Pool not found.")

    pool.name = body.name.strip()
    pool.treatment = body.treatment
    pool.driver = body.driver
    pool.blend_payroll_wt = _d(body.blend_payroll_wt)
    pool.blend_occupancy_wt = _d(body.blend_occupancy_wt)
    pool.fixed_pct = _d(body.fixed_pct)
    pool.form_1125a_line = body.form_1125a_line
    pool.sort_order = body.sort_order
    pool.notes = body.notes
    await db.commit()
    await db.refresh(pool)
    return serialize_pool(pool)


@router.delete("/pools/{pool_id}", status_code=status.HTTP_200_OK)
async def deactivate_pool(
    pool_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Deactivate rather than delete — historical runs reference this pool by
    name, and the account map holds a RESTRICT foreign key to it."""
    pool = (await db.execute(select(AllocPool).where(AllocPool.id == pool_id))).scalar_one_or_none()
    if pool is None:
        raise HTTPException(status_code=404, detail="Pool not found.")
    pool.active = False
    await db.commit()
    return {"id": str(pool_id), "active": False}


# ── Account map ───────────────────────────────────────────────────────────────

class AccountMapBody(BaseModel):
    pool_id: uuid.UUID
    account_number: str | None = None
    account_name: str | None = None
    effective_from: date | None = None


@router.get("/accounts")
async def list_accounts(
    tenant_id: CurrentTenantId,
    period_start: date = Query(...),
    period_end: date = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The client's expense accounts, their current pool, and a suggestion for
    the unmapped ones.

    Needs a period because the expense universe comes from the QBO P&L for that
    range. Suggestions are never applied automatically — see templates.py on why
    "unsure" defaults to disallowed.
    """
    from modules.cost_allocation.service import load_config

    conn = (await db.execute(select(QboConnection))).scalars().first()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected for this client.")

    pools, account_map_rows, _spaces, _employees = await load_config(db, period_end)
    pool_name_by_id = {p.id: p.name for p in pools}
    mapped = {m.qbo_account_id: m for m in account_map_rows}

    try:
        # The whole expense chart, not just what moved this month — an
        # account with no activity in the viewed period still needs a pool.
        expenses, accounts_meta = await fetch_expense_chart(conn, db, period_start, period_end)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Could not read accounts from QuickBooks: {exc}"
        ) from exc

    rows: list[dict] = []
    unmapped_payload: list[dict] = []
    for e in expenses:
        m = mapped.get(e.qbo_account_id)
        row = {
            "qbo_account_id": e.qbo_account_id,
            "account_number": e.account_number,
            "account_name": e.account_name,
            "account_type": str((accounts_meta.get(e.qbo_account_id) or {}).get("AccountType") or ""),
            "period_amount": str(e.amount),
            "pool_id": str(m.pool_id) if m else None,
            "pool_name": pool_name_by_id.get(m.pool_id) if m else None,
        }
        if m is None:
            unmapped_payload.append(row)
        rows.append(row)

    suggestions = {s["qbo_account_id"]: s for s in suggest_mapping(unmapped_payload)}
    for row in rows:
        s = suggestions.get(row["qbo_account_id"])
        row["suggested_pool"] = s["suggested_pool"] if s else None
        row["confidence"] = s["confidence"] if s else None
        row["reason"] = s["reason"] if s else None

    rows.sort(key=lambda r: (r["account_number"] or "", r["qbo_account_id"]))
    return {
        "accounts": rows,
        "unmapped_count": len(unmapped_payload),
        "pools": [serialize_pool(p) for p in pools],
    }


@router.put("/accounts/{qbo_account_id}")
async def map_account(
    qbo_account_id: str,
    body: AccountMapBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    pool = (await db.execute(select(AllocPool).where(AllocPool.id == body.pool_id))).scalar_one_or_none()
    if pool is None:
        raise HTTPException(status_code=404, detail="Pool not found.")

    row = await set_account_pool(
        db, tenant_id=tenant_id, qbo_account_id=qbo_account_id, pool_id=body.pool_id,
        account_number=body.account_number, account_name=body.account_name,
        effective_from=body.effective_from or date.today(),
    )
    await db.commit()
    return {
        "qbo_account_id": row.qbo_account_id,
        "pool_id": str(row.pool_id),
        "pool_name": pool.name,
        "effective_from": row.effective_from.isoformat(),
    }


# ── Spaces ────────────────────────────────────────────────────────────────────

class SpaceBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    function: str
    square_feet: float
    production_pct: float | None = None
    effective_from: date | None = None
    notes: str | None = None


@router.get("/spaces")
async def list_spaces(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(select(AllocSpace).order_by(AllocSpace.name))).scalars().all()
    return [serialize_space(s) for s in rows]


@router.post("/spaces", status_code=status.HTTP_201_CREATED)
async def create_space(
    body: SpaceBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if body.square_feet < 0:
        raise HTTPException(status_code=422, detail="Square feet cannot be negative.")
    if body.production_pct is not None and not (0 <= body.production_pct <= 100):
        raise HTTPException(status_code=422, detail="Production % must be between 0 and 100.")

    space = AllocSpace(
        id=uuid.uuid4(), tenant_id=tenant_id, name=body.name.strip(),
        function=body.function, square_feet=_d(body.square_feet),
        production_pct=_d(body.production_pct),
        # MAP_EPOCH, not today — see setup_service. A space stamped with
        # today's date is invisible to the (already closed) month being set up.
        effective_from=body.effective_from or MAP_EPOCH, notes=body.notes,
    )
    db.add(space)
    await db.commit()
    await db.refresh(space)
    return serialize_space(space)


@router.put("/spaces/{space_id}")
async def update_space(
    space_id: uuid.UUID,
    body: SpaceBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    space = (await db.execute(select(AllocSpace).where(AllocSpace.id == space_id))).scalar_one_or_none()
    if space is None:
        raise HTTPException(status_code=404, detail="Space not found.")
    space.name = body.name.strip()
    space.function = body.function
    space.square_feet = _d(body.square_feet)
    space.production_pct = _d(body.production_pct)
    space.notes = body.notes
    await db.commit()
    await db.refresh(space)
    return serialize_space(space)


@router.delete("/spaces/{space_id}")
async def retire_space(
    space_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Close the row rather than delete it, so prior periods still compute the
    square footage that was actually in use."""
    space = (await db.execute(select(AllocSpace).where(AllocSpace.id == space_id))).scalar_one_or_none()
    if space is None:
        raise HTTPException(status_code=404, detail="Space not found.")
    space.effective_to = date.today()
    await db.commit()
    return {"id": str(space_id), "effective_to": space.effective_to.isoformat()}


# ── Square-footage source documents ───────────────────────────────────────────
#
# What's in the Spaces registry is a transcription. This is what it was
# transcribed FROM — the floor plan, surveyor's schedule or lease exhibit the
# client supplied. On examination the question is not what was entered but what
# it was entered from.

_MAX_SPACE_MAP_BYTES = 25 * 1024 * 1024   # floor plans are often large scans
_ALLOWED_SPACE_MAP_EXTS = {
    "pdf", "png", "jpg", "jpeg", "webp", "gif",
    "xlsx", "xls", "csv", "dwg", "docx",
}


def _serialize_space_map(m) -> dict:
    return {
        "id": str(m.id),
        "file_name": m.file_name,
        "file_size": m.file_size,
        "mime_type": m.mime_type,
        "label": m.label,
        "as_of": m.as_of.isoformat() if m.as_of else None,
        "notes": m.notes,
        "uploaded_at": m.uploaded_at.isoformat() if m.uploaded_at else None,
    }


@router.get("/space-maps")
async def list_space_maps(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Every square-footage document on file, newest first.

    Superseded plans are kept: a facility re-measured in June is new evidence
    from June, not a correction that invalidates the March allocation.
    """
    from models.alloc_space_map import AllocSpaceMap

    rows = (await db.execute(
        select(AllocSpaceMap).order_by(
            AllocSpaceMap.as_of.desc().nullslast(), AllocSpaceMap.uploaded_at.desc(),
        )
    )).scalars().all()
    return [_serialize_space_map(m) for m in rows]


@router.post("/space-maps", status_code=status.HTTP_201_CREATED)
async def upload_space_map(
    tenant_id: CurrentTenantId,
    file: UploadFile = File(...),
    label: str | None = Query(default=None),
    as_of: str | None = Query(default=None),
    notes: str | None = Query(default=None),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Attach the square-footage document the client supplied."""
    import io

    from core.storage import r2 as r2_storage
    from models.alloc_space_map import AllocSpaceMap

    name = file.filename or "space-map"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in _ALLOWED_SPACE_MAP_EXTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"File type .{ext} isn't accepted. Use one of: "
                f"{', '.join(sorted(_ALLOWED_SPACE_MAP_EXTS))}."
            ),
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="That file is empty.")
    if len(raw) > _MAX_SPACE_MAP_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large (max {_MAX_SPACE_MAP_BYTES // (1024 * 1024)} MB).",
        )

    parsed_as_of = None
    if as_of:
        try:
            parsed_as_of = date.fromisoformat(as_of)
        except ValueError:
            raise HTTPException(status_code=422, detail="as_of must be YYYY-MM-DD.") from None

    mime = file.content_type or "application/octet-stream"
    safe_name = name.replace("/", "_").replace("\\", "_")
    key = r2_storage.tenant_key(tenant_id, "alloc-space-map", f"{uuid.uuid4()}_{safe_name}")
    r2_storage.upload_file(key, io.BytesIO(raw), content_type=mime)

    row = AllocSpaceMap(
        id=uuid.uuid4(), tenant_id=tenant_id,
        file_name=safe_name, file_size=len(raw), mime_type=mime, r2_key=key,
        label=(label or "").strip() or None,
        as_of=parsed_as_of,
        notes=(notes or "").strip() or None,
        uploaded_by=user.id,
    )
    db.add(row)

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.space_map_uploaded", entity_type="alloc_space_map", entity_id=row.id,
        metadata={"summary": (
            f"Attached square-footage source document '{safe_name}'"
            + (f" as at {parsed_as_of.isoformat()}" if parsed_as_of else "")
        )},
    )
    await db.commit()
    await db.refresh(row)
    return _serialize_space_map(row)


@router.get("/space-maps/{map_id}/download")
async def download_space_map(
    map_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """A short-lived signed URL for the document.

    Anything not on the shared inline-safe allowlist is served as an ATTACHMENT.
    A floor plan uploaded as SVG or HTML would otherwise run as script from the
    storage origin.
    """
    from core.storage import r2 as r2_storage
    from models.alloc_space_map import AllocSpaceMap

    row = (await db.execute(
        select(AllocSpaceMap).where(AllocSpaceMap.id == map_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    ext = row.file_name.rsplit(".", 1)[-1].lower() if "." in row.file_name else ""
    safe_ctype = r2_storage.INLINE_SAFE_TYPES.get(ext)
    if safe_ctype:
        disposition, content_type = "inline", safe_ctype
    else:
        disposition, content_type = "attachment", row.mime_type

    url = r2_storage.generate_presigned_download_url(
        row.r2_key, disposition=disposition,
        filename=row.file_name, content_type=content_type,
    )
    return {"url": url, "file_name": row.file_name, "inline": disposition == "inline"}


@router.delete("/space-maps/{map_id}")
async def delete_space_map(
    map_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Remove a document. Deletes the stored file too — an orphan in R2 that no
    row points at is a copy of a client's premises nobody can find or audit."""
    from core.storage import r2 as r2_storage
    from models.alloc_space_map import AllocSpaceMap

    row = (await db.execute(
        select(AllocSpaceMap).where(AllocSpaceMap.id == map_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    key, name = row.r2_key, row.file_name
    await db.delete(row)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.space_map_deleted", entity_type="alloc_space_map", entity_id=map_id,
        metadata={"summary": f"Removed square-footage source document '{name}'"},
    )
    await db.commit()
    try:
        r2_storage.delete_file(key)
    except Exception:   # noqa: BLE001 — the row is gone; a stale object is not worth a 500
        logger.warning("Could not delete space map object %s from R2", key)
    return {"id": str(map_id), "deleted": True}


# ── Employees ─────────────────────────────────────────────────────────────────

class EmployeeBody(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    function: str
    production_pct: float = 0
    # Why a partial percentage is what it is. Only meaningful for a split.
    split_basis: str | None = None
    external_id: str | None = None
    qbo_employee_id: str | None = None
    effective_from: date | None = None


def _basis(v: str | None) -> str | None:
    """Blank is not a basis — store NULL so readiness can tell them apart."""
    return (v or "").strip() or None


@router.get("/employees")
async def list_employees(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(select(AllocEmployee).order_by(AllocEmployee.name))).scalars().all()
    return [serialize_employee(e) for e in rows]


@router.post("/employees", status_code=status.HTTP_201_CREATED)
async def create_employee(
    body: EmployeeBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not (0 <= body.production_pct <= 100):
        raise HTTPException(status_code=422, detail="Production % must be between 0 and 100.")
    emp = AllocEmployee(
        id=uuid.uuid4(), tenant_id=tenant_id, name=body.name.strip(),
        external_id=body.external_id, qbo_employee_id=body.qbo_employee_id,
        function=body.function, production_pct=_d(body.production_pct),
        split_basis=_basis(body.split_basis),
        effective_from=body.effective_from or MAP_EPOCH, active=True,
    )
    db.add(emp)
    await db.commit()
    await db.refresh(emp)
    return serialize_employee(emp)


@router.put("/employees/{employee_id}")
async def update_employee(
    employee_id: uuid.UUID,
    body: EmployeeBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not (0 <= body.production_pct <= 100):
        raise HTTPException(status_code=422, detail="Production % must be between 0 and 100.")
    emp = (await db.execute(
        select(AllocEmployee).where(AllocEmployee.id == employee_id)
    )).scalar_one_or_none()
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found.")
    emp.name = body.name.strip()
    emp.function = body.function
    emp.production_pct = _d(body.production_pct)
    # A percentage that's no longer a split has nothing left to justify, so the
    # stale basis is cleared rather than left describing a decision that changed.
    emp.split_basis = (
        _basis(body.split_basis) if 0 < body.production_pct < 100 else None
    )
    emp.external_id = body.external_id
    await db.commit()
    await db.refresh(emp)
    return serialize_employee(emp)


@router.delete("/employees/{employee_id}")
async def retire_employee(
    employee_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    emp = (await db.execute(
        select(AllocEmployee).where(AllocEmployee.id == employee_id)
    )).scalar_one_or_none()
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found.")
    emp.active = False
    emp.effective_to = date.today()
    await db.commit()
    return {"id": str(employee_id), "active": False}


# ── Payroll import ────────────────────────────────────────────────────────────

class PayrollRowBody(BaseModel):
    external_id: str | None = None
    name: str | None = None
    gross_wages: float = 0
    employer_taxes: float = 0
    benefits: float = 0
    # Carried from the register so a newly created employee arrives already
    # classified, with the client's own labels as the evidence for it.
    department: str | None = None
    job_title: str | None = None
    function: str | None = None
    production_pct: float | None = None


class PayrollImportBody(BaseModel):
    period_start: date
    period_end: date
    rows: list[PayrollRowBody]
    # Create an unclassified employee for any row that didn't match, so a first
    # import doesn't require hand-entering the whole roster. They land at 0%
    # production — wrong in the conservative direction, and visible on the
    # Employees tab for the preparer to classify.
    create_missing: bool = False


@router.get("/payroll")
async def get_payroll(
    tenant_id: CurrentTenantId,
    period_end: date = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """What's already imported for this period.

    Exists because the import used to leave no trace: the preview cleared, the
    panel returned to its empty state, and there was no way to tell a successful
    import from one that never happened. This is read on every visit so the
    screen always states the truth.

    Also returns the resulting payroll factor, computed the same way the engine
    does — production-weighted labor cost over total labor cost — so the number
    that drives capitalization is visible where it's created.
    """
    # Computed through the SAME loaders the run uses, so the factor on this
    # screen is provably the factor that will be applied. Previously this
    # endpoint counted every payroll row against every employee row, while the
    # run filtered both to those active and effective for the period — so a
    # retired employee dragged the displayed factor down without affecting the
    # real one. Two different truths for the same number.
    from modules.cost_allocation.engine import compute_payroll_factor
    from modules.cost_allocation.service import load_config, load_payroll

    period_start = period_end.replace(day=1)
    _pools, _map, _spaces, employees = await load_config(db, period_end)
    rows = await load_payroll(db, employees, period_start, period_end)

    empty = {
        "imported": False, "people": 0,
        "total_labor": "0.00", "production_labor": "0.00",
        "payroll_factor": None, "imported_at": None, "rows": [],
    }
    if not rows:
        return empty

    try:
        factor, basis = compute_payroll_factor(rows)
    except Exception:
        # Zero wages: imported, but nothing to weight. Report it rather than 500.
        return {**empty, "imported": True, "people": len(rows)}

    total = Decimal(basis["total_wages"])
    production = Decimal(basis["production_wages"])

    # When the register was last touched, for the "last updated" line.
    stamps = (await db.execute(
        select(AllocPayrollEntry.updated_at).where(
            AllocPayrollEntry.period_start >= period_start,
            AllocPayrollEntry.period_end <= period_end,
        )
    )).scalars().all()
    latest = max((s for s in stamps if s), default=None)

    detail = sorted(
        (
            {
                "name": r.employee,
                "function": r.function,
                "production_pct": str(r.production_pct if r.production_pct is not None else 0),
                "labor_cost": f"{r.wages:.2f}",
                # What this person actually contributes to the numerator.
                "production_labor": f"{r.wages * (r.production_pct or Decimal(0)) / Decimal(100):.2f}",
            }
            for r in rows
        ),
        key=lambda d: Decimal(d["labor_cost"]), reverse=True,
    )

    return {
        "imported": True,
        "people": len(rows),
        "total_labor": f"{total:.2f}",
        "production_labor": f"{production:.2f}",
        "payroll_factor": f"{factor:.6f}",
        "imported_at": latest.isoformat() if latest else None,
        "rows": detail,
    }


@router.delete("/payroll")
async def clear_payroll(
    tenant_id: CurrentTenantId,
    period_end: date = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Remove this period's register so a corrected one can replace it cleanly."""
    from sqlalchemy import delete as sa_delete

    period_start = period_end.replace(day=1)
    await db.execute(
        sa_delete(AllocPayrollEntry).where(
            AllocPayrollEntry.tenant_id == tenant_id,
            AllocPayrollEntry.period_start >= period_start,
            AllocPayrollEntry.period_end <= period_end,
        )
    )
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.payroll_cleared", entity_type="alloc_payroll_entry", entity_id=None,
        metadata={"summary": f"Cleared the payroll register for {period_end.isoformat()}"},
    )
    await db.commit()
    return {"cleared": True, "period_end": period_end.isoformat()}


@router.post("/payroll/preview")
async def preview_payroll(
    tenant_id: CurrentTenantId,
    file: UploadFile = File(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Parse an uploaded register and show what WOULD be imported.

    Nothing is written. The response carries the detected column mapping, the
    parsed rows, and which employee each row matched — so the preparer confirms
    the guess before any wage lands in a factor.
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=422, detail="That file is empty.")
    try:
        headers, mapping, rows = parse_payroll_file(raw, file.filename or "register.csv")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Could not read that payroll register: {exc}",
        ) from exc

    if not rows:
        raise HTTPException(
            status_code=422,
            detail=(
                "No employee rows found. Check that the file has a header row "
                "with an employee name and a gross pay column."
            ),
        )

    employees = (await db.execute(select(AllocEmployee))).scalars().all()
    matched = match_rows(rows, list(employees))
    return {
        "headers": headers,
        "mapping": mapping,
        "rows": matched,
        "matched_count": sum(1 for r in matched if r["matched_employee_id"]),
        "unmatched_count": sum(1 for r in matched if not r["matched_employee_id"]),
    }


@router.post("/payroll/import", status_code=status.HTTP_201_CREATED)
async def import_payroll(
    body: PayrollImportBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Load a payroll register for the period.

    Rows match an existing employee by external_id, else by exact name. An
    unmatched row is REPORTED rather than guessed at — a misattributed wage
    silently shifts the payroll factor, and therefore the tax position.

    Re-importing the same register updates in place rather than double-counting.
    """
    employees = (await db.execute(select(AllocEmployee))).scalars().all()
    by_ext = {e.external_id: e for e in employees if e.external_id}
    by_name = {e.name.strip().lower(): e for e in employees}

    # Keyed by employee so a person can only ever have ONE entry per period.
    # alloc_payroll_entry is UNIQUE on (tenant, employee, period): this dict is
    # updated as we go, so a register listing somebody twice (semi-monthly runs,
    # or a row per earnings code) accumulates onto the same entry instead of
    # attempting a second insert — which used to raise IntegrityError and
    # surface in the browser as an unexplained "Network Error".
    entries: dict[uuid.UUID, AllocPayrollEntry] = {
        p.employee_id: p for p in (await db.execute(
            select(AllocPayrollEntry).where(
                AllocPayrollEntry.period_start == body.period_start,
                AllocPayrollEntry.period_end == body.period_end,
            )
        )).scalars().all()
    }
    # Which entries this import has already written to, so the first row for a
    # person REPLACES the prior month's figure and later rows ADD to it.
    touched: set[uuid.UUID] = set()

    imported = 0
    unmatched: list[str] = []
    created: list[str] = []
    batch = uuid.uuid4().hex[:16]

    for row in body.rows:
        emp = None
        if row.external_id:
            emp = by_ext.get(row.external_id)
        if emp is None and row.name:
            emp = by_name.get(row.name.strip().lower())

        if emp is None and body.create_missing and row.name:
            # The register's own department/title drive the suggested function.
            # When nothing is recognizable this lands on "shared" at 0%: the
            # wage counts in the DENOMINATOR of the payroll factor but not the
            # numerator, so an unreviewed roster understates capitalization
            # rather than overstating it.
            function = row.function or "shared"
            pct = row.production_pct if row.production_pct is not None else 0
            emp = AllocEmployee(
                id=uuid.uuid4(), tenant_id=tenant_id, name=row.name.strip(),
                external_id=row.external_id,
                department=(row.department or None), job_title=(row.job_title or None),
                function=function, production_pct=_d(pct),
                effective_from=MAP_EPOCH, active=True,
            )
            db.add(emp)
            await db.flush()
            by_name[emp.name.strip().lower()] = emp
            if emp.external_id:
                by_ext[emp.external_id] = emp
            created.append(emp.name)
        elif emp is not None and (row.department or row.job_title):
            # Keep the source labels current on someone already on file — it's
            # the evidence behind their classification.
            emp.department = row.department or emp.department
            emp.job_title = row.job_title or emp.job_title

        if emp is None:
            unmatched.append(row.name or row.external_id or "(unnamed)")
            continue

        entry = entries.get(emp.id)
        if entry is None:
            entry = AllocPayrollEntry(
                id=uuid.uuid4(), tenant_id=tenant_id, employee_id=emp.id,
                period_start=body.period_start, period_end=body.period_end,
            )
            db.add(entry)
            entries[emp.id] = entry

        if emp.id in touched:
            # Same person again in this file — accumulate.
            entry.gross_wages    = (entry.gross_wages or _d(0)) + _d(row.gross_wages)
            entry.employer_taxes = (entry.employer_taxes or _d(0)) + _d(row.employer_taxes)
            entry.benefits       = (entry.benefits or _d(0)) + _d(row.benefits)
        else:
            # First sight this import — replace whatever was there before, so
            # re-importing a corrected register doesn't double-count.
            entry.gross_wages    = _d(row.gross_wages)
            entry.employer_taxes = _d(row.employer_taxes)
            entry.benefits       = _d(row.benefits)
            touched.add(emp.id)
            imported += 1

        entry.source = "import"
        entry.import_batch = batch

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.payroll_imported", entity_type="alloc_payroll_entry", entity_id=None,
        metadata={"summary": (
            f"Imported {imported} payroll rows for {body.period_end.isoformat()}"
            + (f"; created {len(created)} employees" if created else "")
            + (f"; {len(unmatched)} unmatched" if unmatched else "")
        )},
    )

    # An unhandled exception here returns a 500 that never passes through the
    # CORS middleware, so the browser reports it as "Network Error" with nothing
    # to act on. Commit failures become a real message instead.
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.exception(
            "allocation payroll import failed for tenant %s period %s",
            tenant_id, body.period_end,
        )
        raise HTTPException(
            status_code=409,
            detail=(
                "Could not save the payroll register. This usually means the file "
                "lists the same employee under two different identities. Check the "
                f"preview for duplicates and try again. ({type(exc).__name__})"
            ),
        ) from exc
    return {
        "imported": imported,
        "unmatched": unmatched,
        "created": created,
        "period_end": body.period_end.isoformat(),
    }


# ── Readiness ─────────────────────────────────────────────────────────────────

class TxnOverrideBody(BaseModel):
    production_pct: float
    amount: float
    txn_date: date | None = None
    txn_type: str | None = None
    txn_number: str | None = None
    memo: str | None = None
    entity_name: str | None = None
    note: str | None = None


@router.get("/accounts/{qbo_account_id}/transactions")
async def list_account_transactions(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_start: date = Query(...),
    period_end: date = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The GL entries behind one account, with any hand-set allocations.

    The pool driver is an estimate applied to the whole account. This is where a
    preparer can do better: read the actual ledger and say which specific
    charges were production. §471(c) is a books-and-records method, so specific
    evidence beats a defensible estimate every time.

    Returns the resulting effective rate so the consequence of the review is
    visible while it's being done, not discovered in the run.
    """
    from core.qbo_gl import pull_gl_transactions
    from models.cost_allocation import AllocTxnOverride

    conn = (await db.execute(select(QboConnection))).scalars().first()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected for this client.")

    txns = await pull_gl_transactions(conn, db, qbo_account_id, period_start, period_end)

    overrides = {
        o.qbo_txn_id: o for o in (await db.execute(
            select(AllocTxnOverride).where(
                AllocTxnOverride.qbo_account_id == qbo_account_id,
                AllocTxnOverride.period_end == period_end,
            )
        )).scalars().all()
    }

    rows: list[dict] = []
    gross = Decimal("0.00")
    reviewed_amount = Decimal("0.00")
    reviewed_capitalized = Decimal("0.00")
    for t in txns:
        amount = Decimal(str(t.get("amount") or 0))
        gross += amount
        o = overrides.get(str(t.get("qbo_txn_id") or ""))
        if o is not None:
            reviewed_amount += o.amount
            reviewed_capitalized += o.amount * o.production_pct / Decimal(100)
        rows.append({
            "qbo_txn_id": str(t.get("qbo_txn_id") or ""),
            "txn_type":   t.get("txn_type"),
            "txn_number": t.get("txn_number"),
            "txn_date":   t["txn_date"].isoformat() if t.get("txn_date") else None,
            "amount":     str(amount),
            "memo":       t.get("memo"),
            "entity_name": t.get("entity_name"),
            "production_pct": str(o.production_pct) if o else None,
            "note": o.note if o else None,
        })

    return {
        "qbo_account_id": qbo_account_id,
        "transactions": rows,
        "gross": f"{gross:.2f}",
        "reviewed_count": len(overrides),
        "reviewed_amount": f"{reviewed_amount:.2f}",
        "reviewed_capitalized": f"{reviewed_capitalized:.2f}",
        # What's left for the pool driver to estimate.
        "unreviewed_amount": f"{gross - reviewed_amount:.2f}",
    }


@router.put("/accounts/{qbo_account_id}/transactions/{qbo_txn_id}")
async def set_transaction_allocation(
    qbo_account_id: str,
    qbo_txn_id: str,
    body: TxnOverrideBody,
    tenant_id: CurrentTenantId,
    period_end: date = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Record the production share of one transaction, for this period."""
    from models.cost_allocation import AllocTxnOverride

    if not (0 <= body.production_pct <= 100):
        raise HTTPException(status_code=422, detail="Production % must be between 0 and 100.")

    row = (await db.execute(
        select(AllocTxnOverride).where(
            AllocTxnOverride.qbo_txn_id == qbo_txn_id,
            AllocTxnOverride.period_end == period_end,
        )
    )).scalars().first()

    if row is None:
        row = AllocTxnOverride(
            id=uuid.uuid4(), tenant_id=tenant_id, qbo_account_id=qbo_account_id,
            qbo_txn_id=qbo_txn_id, period_end=period_end, created_by=user.id,
            production_pct=_d(body.production_pct), amount=_d(body.amount),
        )
        db.add(row)
    row.production_pct = _d(body.production_pct)
    row.amount = _d(body.amount)
    # Snapshot the transaction so the workpaper still reads correctly if it's
    # later edited in QuickBooks.
    row.txn_date = body.txn_date
    row.txn_type = body.txn_type
    row.txn_number = body.txn_number
    row.memo = (body.memo or None)
    row.entity_name = (body.entity_name or None)
    row.note = (body.note or None)

    await db.commit()
    return {"qbo_txn_id": qbo_txn_id, "production_pct": str(row.production_pct)}


@router.delete("/accounts/{qbo_account_id}/transactions/{qbo_txn_id}")
async def clear_transaction_allocation(
    qbo_account_id: str,
    qbo_txn_id: str,
    tenant_id: CurrentTenantId,
    period_end: date = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Drop a hand-set allocation so the transaction falls back to the driver."""
    from sqlalchemy import delete as sa_delete

    from models.cost_allocation import AllocTxnOverride

    await db.execute(
        sa_delete(AllocTxnOverride).where(
            AllocTxnOverride.tenant_id == tenant_id,
            AllocTxnOverride.qbo_txn_id == qbo_txn_id,
            AllocTxnOverride.period_end == period_end,
        )
    )
    await db.commit()
    return {"cleared": True, "qbo_txn_id": qbo_txn_id}


class EligibilityEntity(BaseModel):
    entity: str
    year: int
    amount: float
    source: str = "manual"


class EligibilityBody(BaseModel):
    tax_year: int
    entities: list[EligibilityEntity]
    has_afs: bool = False
    threshold: float | None = None
    aggregation_note: str | None = None


def _serialize_eligibility(row) -> dict:
    from modules.cost_allocation.engine import threshold_for_year

    default_threshold, confirmed = threshold_for_year(row.tax_year)
    return {
        "tested": True,
        "tax_year": row.tax_year,
        "threshold": str(row.threshold),
        "default_threshold": str(default_threshold),
        "threshold_confirmed": confirmed,
        "entities": row.entities,
        "three_year_avg": str(row.three_year_avg),
        "eligible": row.eligible,
        "has_afs": row.has_afs,
        "method_available": row.method_available,
        "reason": row.reason,
        "aggregation_note": row.aggregation_note,
        "status": row.status,
        "tested_by": str(row.tested_by) if row.tested_by else None,
        "tested_at": row.tested_at.isoformat() if row.tested_at else None,
        "approved_at": row.approved_at.isoformat() if row.approved_at else None,
    }


@router.get("/eligibility")
async def get_eligibility(
    tenant_id: CurrentTenantId,
    tax_year: int = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The §448(c) conclusion on file for a tax year, if one has been reached."""
    from models.cost_allocation import AllocEligibility
    from modules.cost_allocation.engine import threshold_for_year

    row = (await db.execute(
        select(AllocEligibility).where(AllocEligibility.tax_year == tax_year)
    )).scalars().first()

    if row is None:
        default_threshold, confirmed = threshold_for_year(tax_year)
        return {
            "tested": False, "tax_year": tax_year,
            "default_threshold": str(default_threshold),
            "threshold_confirmed": confirmed,
            "entities": [], "eligible": None, "status": None,
        }
    return {
        **_serialize_eligibility(row),
        # Who tested it, so the UI can tell a reviewer they can't approve their
        # own work BEFORE they click rather than after a 403.
        "can_self_approve": False,
    }


@router.get("/eligibility/suggest-receipts")
async def suggest_receipts(
    tenant_id: CurrentTenantId,
    tax_year: int = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """This client's own gross receipts for the three prior years, from QBO.

    A starting point only — receipts for AFFILIATED entities have to be added by
    the preparer, because Nordavix can only see the books it's connected to and
    the §448(c) test is about the whole controlled group.
    """
    from modules.cost_allocation.conformity import fetch_annual_gross_receipts

    conn = (await db.execute(select(QboConnection))).scalars().first()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected for this client.")

    out: list[dict] = []
    for year in (tax_year - 3, tax_year - 2, tax_year - 1):
        amount = await fetch_annual_gross_receipts(conn, db, year)
        out.append({
            "year": year,
            "amount": str(amount) if amount is not None else None,
            "source": "quickbooks" if amount is not None else "unavailable",
        })
    return {"tax_year": tax_year, "years": out}


@router.post("/eligibility", status_code=status.HTTP_201_CREATED)
async def record_eligibility(
    body: EligibilityBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Record the §448(c) conclusion and freeze the basis. Needs approving after.

    Maker-checker, like a run. The preparer gathers the receipts, identifies the
    affiliates and performs the aggregation — so the preparer records it, and it
    lands as a DRAFT. A reviewer then signs it off, and never their own work.
    Requiring a reviewer to type it in put the person doing the work outside
    their own task.

    Re-recording an approved conclusion returns it to draft: the basis changed,
    so the sign-off no longer covers what's on file.

    Receipts AGGREGATE across commonly controlled entities (§448(c)(2) →
    §52(a)/(b), §414(m)/(o)), which is why the request takes a list of entities
    rather than one client's numbers.
    """
    from models.cost_allocation import AllocEligibility
    from modules.cost_allocation.engine import (
        aggregate_gross_receipts,
        evaluate_eligibility,
        threshold_for_year,
    )

    rows = [e.model_dump() for e in body.entities]
    if not rows:
        raise HTTPException(
            status_code=422,
            detail="Add at least one entity and year of gross receipts to test.",
        )

    years = aggregate_gross_receipts(rows, body.tax_year)
    if not years:
        raise HTTPException(
            status_code=422,
            detail=(
                f"No receipts fall in the three years before {body.tax_year} "
                f"({body.tax_year - 3}–{body.tax_year - 1})."
            ),
        )

    default_threshold, _confirmed = threshold_for_year(body.tax_year)
    threshold = _d(body.threshold) if body.threshold is not None else default_threshold

    result = evaluate_eligibility(years, threshold, has_afs=body.has_afs)

    row = (await db.execute(
        select(AllocEligibility).where(AllocEligibility.tax_year == body.tax_year)
    )).scalars().first()
    if row is None:
        row = AllocEligibility(
            id=uuid.uuid4(), tenant_id=tenant_id, tax_year=body.tax_year,
        )
        db.add(row)

    row.threshold = threshold
    row.entities = rows
    row.three_year_avg = result.gross_receipts_3yr_avg
    row.eligible = result.eligible
    row.has_afs = body.has_afs
    row.method_available = result.method
    row.reason = result.reason
    row.aggregation_note = body.aggregation_note
    row.tested_by = user.id
    row.tested_at = datetime.now(UTC)
    # Any re-record reopens it — the basis moved, so an earlier sign-off no
    # longer describes what's on file.
    row.status = "draft"
    row.approved_by = None
    row.approved_at = None

    # Keep the elected method consistent with what the test says is available.
    cfg = await get_or_create_settings(db, tenant_id)
    cfg.has_afs = body.has_afs
    if result.method:
        cfg.method = result.method

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.eligibility_tested", entity_type="alloc_eligibility", entity_id=row.id,
        metadata={"summary": (
            f"§448(c) test for {body.tax_year}: "
            f"{'eligible' if result.eligible else 'NOT eligible'} "
            f"(3-year average {result.gross_receipts_3yr_avg} vs {threshold}, "
            f"{len({r['entity'] for r in rows})} entities)"
        )},
    )
    await db.commit()
    await db.refresh(row)

    return {
        "tested": True,
        "tax_year": row.tax_year,
        "threshold": str(row.threshold),
        "three_year_avg": str(row.three_year_avg),
        "eligible": row.eligible,
        "method_available": row.method_available,
        "reason": row.reason,
        "status": row.status,
        "entity_count": len({r["entity"] for r in rows}),
    }


@router.post("/eligibility/{tax_year}/approve")
async def approve_eligibility(
    tax_year: int,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Sign off the §448(c) conclusion. Reviewer+, and never your own work.

    This is the gate the whole method stands on, so it gets the same
    maker-checker treatment as an allocation run: whoever performed the test
    cannot be the one who approves it.
    """
    from models.cost_allocation import AllocEligibility

    row = (await db.execute(
        select(AllocEligibility).where(AllocEligibility.tax_year == tax_year)
    )).scalars().first()
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"No §448(c) conclusion on file for {tax_year}.",
        )
    if row.status == "approved":
        return _serialize_eligibility(row)
    if row.tested_by is not None and row.tested_by == user.id:
        raise HTTPException(
            status_code=403,
            detail=(
                "The §448(c) test must be approved by someone other than the person "
                "who performed it."
            ),
        )

    row.status = "approved"
    row.approved_by = user.id
    row.approved_at = datetime.now(UTC)

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.eligibility_approved",
        entity_type="alloc_eligibility", entity_id=row.id,
        metadata={"summary": (
            f"Approved the §448(c) conclusion for {row.tax_year}: "
            f"{'eligible' if row.eligible else 'NOT eligible'}"
        )},
    )
    await db.commit()
    await db.refresh(row)
    return _serialize_eligibility(row)


@router.get("/inventory-accounts")
async def list_inventory_accounts(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Balance-sheet accounts the reclass entry could debit.

    Exists so the inventory account is PICKED from the client's real chart
    rather than typed as an id — a typo there produces a journal entry that
    posts to the wrong account.
    """
    from modules.cost_allocation.service import _fetch_account_types

    conn = (await db.execute(select(QboConnection))).scalars().first()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected for this client.")

    try:
        accounts = await _fetch_account_types(conn, db)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Could not read accounts from QuickBooks: {exc}"
        ) from exc

    wanted = {"Other Current Asset", "Current Asset", "Inventory", "Fixed Asset", "Other Asset"}
    out = [
        {
            "qbo_account_id": aid,
            "account_number": str(a.get("AcctNum") or "") or None,
            "account_name": str(a.get("Name") or ""),
            "account_type": str(a.get("AccountType") or ""),
        }
        for aid, a in accounts.items()
        if str(a.get("AccountType") or "") in wanted
    ]
    out.sort(key=lambda r: (r["account_number"] or "", r["account_name"]))
    return out


@router.get("/readiness")
async def readiness(
    tenant_id: CurrentTenantId,
    period_end: date = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Can this client be allocated for this period — and if not, what's missing?"""
    return await compute_readiness(db, period_end)
