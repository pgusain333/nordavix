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
import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
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


def _d(v) -> Decimal | None:
    return Decimal(str(v)) if v is not None else None


# ── Settings ──────────────────────────────────────────────────────────────────

class SettingsBody(BaseModel):
    method: str | None = None                 # books_records | afs
    has_afs: bool | None = None
    inventory_account_id: str | None = None
    inventory_account_name: str | None = None
    fiscal_year_end: str | None = None        # "MM-DD"
    gross_receipts_threshold: float | None = None
    notes: str | None = None


def _serialize_settings(cfg) -> dict:
    return {
        "method": cfg.method,
        "has_afs": cfg.has_afs,
        "inventory_method": cfg.inventory_method,
        "inventory_account_id": cfg.inventory_account_id,
        "inventory_account_name": cfg.inventory_account_name,
        "fiscal_year_end": cfg.fiscal_year_end,
        "gross_receipts_threshold": (
            str(cfg.gross_receipts_threshold) if cfg.gross_receipts_threshold is not None else None
        ),
        "election_attested_at": cfg.election_attested_at.isoformat() if cfg.election_attested_at else None,
        "notes": cfg.notes,
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

    cfg = await get_or_create_settings(db, tenant_id)
    for field in (
        "method", "has_afs", "inventory_account_id", "inventory_account_name",
        "fiscal_year_end", "notes",
    ):
        value = getattr(body, field)
        if value is not None:
            setattr(cfg, field, value)
    if body.gross_receipts_threshold is not None:
        cfg.gross_receipts_threshold = _d(body.gross_receipts_threshold)

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
    sort_order: int = 0
    notes: str | None = None


def _validate_pool(b: PoolBody) -> None:
    """Mirror the DB CHECK constraints with a readable message.

    The constraints are the real guarantee; this exists so the user gets
    "a blended pool needs weights that sum to 100" instead of a driver error.
    """
    if b.treatment not in ("direct", "allocated", "excluded"):
        raise HTTPException(status_code=422, detail="treatment must be direct, allocated or excluded.")
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
        fixed_pct=_d(body.fixed_pct), sort_order=body.sort_order, notes=body.notes,
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


# ── Employees ─────────────────────────────────────────────────────────────────

class EmployeeBody(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    function: str
    production_pct: float = 0
    external_id: str | None = None
    qbo_employee_id: str | None = None
    effective_from: date | None = None


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


class PayrollImportBody(BaseModel):
    period_start: date
    period_end: date
    rows: list[PayrollRowBody]


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

    existing = {
        (p.employee_id): p for p in (await db.execute(
            select(AllocPayrollEntry).where(
                AllocPayrollEntry.period_start == body.period_start,
                AllocPayrollEntry.period_end == body.period_end,
            )
        )).scalars().all()
    }

    imported = 0
    unmatched: list[str] = []
    batch = uuid.uuid4().hex[:16]

    for row in body.rows:
        emp = None
        if row.external_id:
            emp = by_ext.get(row.external_id)
        if emp is None and row.name:
            emp = by_name.get(row.name.strip().lower())
        if emp is None:
            unmatched.append(row.name or row.external_id or "(unnamed)")
            continue

        entry = existing.get(emp.id)
        if entry is None:
            entry = AllocPayrollEntry(
                id=uuid.uuid4(), tenant_id=tenant_id, employee_id=emp.id,
                period_start=body.period_start, period_end=body.period_end,
            )
            db.add(entry)
        entry.gross_wages = _d(row.gross_wages)
        entry.employer_taxes = _d(row.employer_taxes)
        entry.benefits = _d(row.benefits)
        entry.source = "import"
        entry.import_batch = batch
        imported += 1

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.payroll_imported", entity_type="alloc_payroll_entry", entity_id=None,
        metadata={"summary": (
            f"Imported {imported} payroll rows for {body.period_end.isoformat()}"
            + (f"; {len(unmatched)} unmatched" if unmatched else "")
        )},
    )
    await db.commit()
    return {
        "imported": imported,
        "unmatched": unmatched,
        "period_end": body.period_end.isoformat(),
    }


# ── Readiness ─────────────────────────────────────────────────────────────────

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
