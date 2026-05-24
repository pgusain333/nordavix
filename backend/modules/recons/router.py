"""
Reconciliations API.

  GET    /reconciliations                       list (with optional ?type=AR filter)
  POST   /reconciliations                       create + start QBO sync
  GET    /reconciliations/dashboard             KPIs + activity + insights
  GET    /reconciliations/{id}                  detail (recon + items + txns + notes)
  POST   /reconciliations/{id}/sync             re-pull from QBO + recompute
  POST   /reconciliations/{id}/approve          mark approved
  POST   /reconciliations/{id}/assign           assign to user (or null to clear)
  POST   /reconciliations/{id}/notes            add a note
  PUT    /reconciliations/{id}/items/{itemId}/status   set item status
  POST   /reconciliations/{id}/items/{itemId}/regenerate  rerun AI for one item
  DELETE /reconciliations/{id}                  hard delete
  GET    /reconciliations/{id}/export           Excel support package
"""
import asyncio
import io
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import pandas as pd
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile, status

from core.config import settings as _settings

logger = logging.getLogger(__name__)
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from core.storage import r2 as r2_storage
from models.qbo_connection import QboConnection
from models.reconciliation import (
    Reconciliation,
    ReconciliationItem,
    ReconNote,
    ReconTransaction,
)
from models.subledger_evidence import SubledgerEvidence
from modules.recons.schemas import (
    ActivityFeedEntry,
    AssignBody,
    ItemStatusUpdate,
    NoteCreate,
    ReconciliationCreate,
    ReconciliationDashboard,
    ReconciliationDashboardStats,
    ReconciliationDetail,
    ReconciliationItemResponse,
    ReconciliationResponse,
    ReconNoteResponse,
    ReconTransactionResponse,
)
from modules.recons.service import (
    explain_item,
    explain_recon_summary,
    insights_from,
    run_sync,
)
from modules.recons.overview import (
    fetch_overview,
    fetch_subledger_detail,
    fetch_variance_detail,
)
from models.account_review_status import AccountReviewStatus

router = APIRouter()


# ── List + create ────────────────────────────────────────────────────────────

@router.get("", response_model=list[ReconciliationResponse])
async def list_reconciliations(
    tenant_id: CurrentTenantId,
    recon_type: str | None = Query(default=None, alias="type"),
    db: AsyncSession = Depends(get_db),
) -> list[Reconciliation]:
    stmt = select(Reconciliation).order_by(desc(Reconciliation.created_at))
    if recon_type:
        stmt = stmt.where(Reconciliation.recon_type == recon_type.upper())
    return list((await db.execute(stmt)).scalars().all())


@router.post("", response_model=ReconciliationResponse, status_code=status.HTTP_201_CREATED)
async def create_reconciliation(
    body: ReconciliationCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = Reconciliation(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=body.name,
        recon_type=body.recon_type,
        period_end=body.period_end,
        status="pending",
        created_by=user.id,
    )
    db.add(recon)
    await db.commit()
    await db.refresh(recon)

    # Sync immediately in the background
    background_tasks.add_task(run_sync, recon.id, tenant_id)
    return recon


# ── Live overview (the main dashboard view) ──────────────────────────────────

@router.get("/overview")
async def get_overview(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end date YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Live snapshot of every balance-sheet account with GL + subledger + variance
    at the chosen period end. Pulled directly from QuickBooks — no persistence,
    no AI cost, always fresh. The frontend calls this on dashboard mount and
    again every time the user changes the period.
    """
    from datetime import date
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        return {
            "period_end": pe.isoformat(),
            "accounts": [],
            "totals": {"gl": "0.00", "subledger": "0.00", "variance": "0.00"},
            "by_group": [],
            "qbo_connected": False,
        }

    overview = await fetch_overview(conn, db, pe)
    overview["qbo_connected"] = True
    return overview


@router.get("/account/{qbo_account_id}/subledger")
async def get_account_subledger(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Drill-in for one account's subledger detail.
    For AR/AP — per customer/vendor aging rows.
    For Bank/CC — recent deposits and purchases.
    For others — recent journal entry activity.
    """
    from datetime import date
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected.")
    return await fetch_subledger_detail(conn, db, qbo_account_id, pe)


@router.get("/account/{qbo_account_id}/variance")
async def get_account_variance(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Transactions likely to explain a GL-vs-subledger variance for this account."""
    from datetime import date
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected.")
    return await fetch_variance_detail(conn, db, qbo_account_id, pe)


@router.post("/account/{qbo_account_id}/status")
async def update_account_review_status(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    status_value: str = Query(..., alias="status", description="pending | reviewed | approved | flagged"),
    notes: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Set the review status for one account+period. Upserts on
    (tenant_id, qbo_account_id, period_end). Audit-logged.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    if status_value not in ("pending", "reviewed", "approved", "flagged"):
        raise HTTPException(status_code=400, detail="Invalid status value.")

    row = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end == pe,
        )
    )).scalar_one_or_none()

    # Maker/checker: a manual subledger override cannot be approved by
    # the same user who entered it. Self-approval defeats the whole point
    # of the control. Preparer enters → independent reviewer approves.
    if (
        status_value == "approved"
        and row is not None
        and row.subledger_total is not None
        and row.subledger_entered_by is not None
        and row.subledger_entered_by == user.id
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                "You entered the manual subledger for this account — "
                "approval must come from a different user (maker/checker control)."
            ),
        )

    if row is None:
        row = AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qbo_account_id,
            period_end=pe,
            status=status_value,
            reviewed_by=user.id if status_value != "pending" else None,
            reviewed_at=datetime.now(timezone.utc) if status_value != "pending" else None,
            notes=notes,
        )
        db.add(row)
    else:
        row.status = status_value
        row.reviewed_by = user.id if status_value != "pending" else None
        row.reviewed_at = datetime.now(timezone.utc) if status_value != "pending" else None
        if notes is not None:
            row.notes = notes

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"recon.account_{status_value}",
        entity_type="account_review_status", entity_id=row.id,
        metadata={
            "summary": f"Set account {qbo_account_id} ({period_end}) → {status_value}",
            "qbo_account_id": qbo_account_id,
            "period_end": period_end,
        },
    )
    await db.commit()
    return {
        "qbo_account_id": qbo_account_id,
        "period_end":     period_end,
        "status":         row.status,
        "reviewed_by":    str(row.reviewed_by) if row.reviewed_by else None,
        "reviewed_at":    row.reviewed_at.isoformat() if row.reviewed_at else None,
    }


@router.post("/account/bulk-status")
async def bulk_update_account_review_status(
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Upsert review status for a batch of accounts at the same period.
    Body shape:
      { period_end: "2026-04-30", status: "approved", qbo_account_ids: ["123","124"] }
    Returns the count updated. Audit-logged once for the batch.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(body.get("period_end", ""))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    status_value = body.get("status")
    if status_value not in ("pending", "reviewed", "approved", "flagged"):
        raise HTTPException(status_code=400, detail="Invalid status value.")
    ids: list[str] = list(body.get("qbo_account_ids") or [])
    if not ids:
        raise HTTPException(status_code=400, detail="qbo_account_ids required.")

    existing = list((await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.period_end == pe,
            AccountReviewStatus.qbo_account_id.in_(ids),
        )
    )).scalars().all())
    by_id = {r.qbo_account_id: r for r in existing}

    # Maker/checker — block bulk approval of any account whose override the
    # current user entered. Bulk action either fully succeeds or fails as a
    # set, so we surface every conflict in the error message.
    if status_value == "approved":
        own_overrides = [
            qid for qid, r in by_id.items()
            if r.subledger_total is not None
            and r.subledger_entered_by is not None
            and r.subledger_entered_by == user.id
        ]
        if own_overrides:
            raise HTTPException(
                status_code=403,
                detail=(
                    "You entered the manual subledger for "
                    f"{len(own_overrides)} account(s) in this batch — "
                    "approval must come from a different user (maker/checker). "
                    f"Conflicting account IDs: {', '.join(own_overrides)}."
                ),
            )

    now = datetime.now(timezone.utc)
    is_reviewed = status_value != "pending"
    for qid in ids:
        if qid in by_id:
            by_id[qid].status = status_value
            by_id[qid].reviewed_by = user.id if is_reviewed else None
            by_id[qid].reviewed_at = now if is_reviewed else None
        else:
            db.add(AccountReviewStatus(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                qbo_account_id=qid,
                period_end=pe,
                status=status_value,
                reviewed_by=user.id if is_reviewed else None,
                reviewed_at=now if is_reviewed else None,
            ))

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"recon.bulk_{status_value}",
        entity_type="account_review_status", entity_id=None,
        metadata={
            "summary": f"Bulk set {len(ids)} accounts → {status_value} for {body.get('period_end')}",
            "count": len(ids),
            "status": status_value,
        },
    )
    await db.commit()
    return {"updated": len(ids), "status": status_value}


@router.post("/account/{qbo_account_id}/subledger")
async def set_account_subledger_override(
    qbo_account_id: str,
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Set or clear the manual subledger override for one account+period.

    Body shape:
      { period_end: "2026-04-30",
        total: 45000.00 | null,  // null clears the override
        source: "Bank statement 4/30" | null }

    When `total` is set, the live overview uses it as the subledger balance
    for this account+period and recomputes variance accordingly. Useful for
    Bank / Fixed Asset / Prepaid / Loan accounts where QBO has no separate
    subledger to compare against.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(str(body.get("period_end", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    total_raw = body.get("total")
    source = body.get("source")
    # Optional reconciling items — list of {txn_id, txn_type, txn_number,
    # txn_date, amount, memo}. Sum of selected items is expected to equal
    # the GL−Subledger variance for the account to be "tied out".
    reconciling_items = body.get("reconciling_items") or []
    if not isinstance(reconciling_items, list):
        raise HTTPException(status_code=400, detail="reconciling_items must be a list.")

    if total_raw is not None:
        try:
            total = Decimal(str(total_raw))
        except (ValueError, ArithmeticError):
            raise HTTPException(status_code=400, detail="total must be numeric or null.")
    else:
        total = None

    row = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end == pe,
        )
    )).scalar_one_or_none()

    now = datetime.now(timezone.utc)
    if row is None:
        row = AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qbo_account_id,
            period_end=pe,
            status="pending",
            subledger_total=total,
            subledger_source=source,
            subledger_entered_by=user.id if total is not None else None,
            subledger_entered_at=now if total is not None else None,
            reconciling_items=reconciling_items if total is not None else [],
        )
        db.add(row)
    else:
        row.subledger_total = total
        row.subledger_source = source if total is not None else None
        row.subledger_entered_by = user.id if total is not None else None
        row.subledger_entered_at = now if total is not None else None
        # When the override is cleared we wipe the reconciling items too —
        # they only make sense in the context of a manual subledger.
        row.reconciling_items = reconciling_items if total is not None else []

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.subledger_override_set" if total is not None else "recon.subledger_override_cleared",
        entity_type="account_review_status", entity_id=row.id,
        metadata={
            "summary": (
                f"Set subledger override for account {qbo_account_id} ({pe}) → ${total}"
                if total is not None
                else f"Cleared subledger override for account {qbo_account_id} ({pe})"
            ),
            "qbo_account_id": qbo_account_id,
            "period_end": body.get("period_end"),
            "source": source,
        },
    )
    await db.commit()
    return {
        "qbo_account_id": qbo_account_id,
        "period_end":     body.get("period_end"),
        "subledger_total":  str(total) if total is not None else None,
        "subledger_source": source if total is not None else None,
        "is_manual":      total is not None,
    }


@router.get("/account/{qbo_account_id}/prior-override")
async def get_prior_period_override(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Current period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Find the most recent prior period (< period_end) where this account had
    a manual subledger value entered. Used to roll forward — the prior
    closing becomes context for the new period: user sees the starting
    point, the delta they're declaring, and can copy-as-starting-point with
    one click.

    Returns the prior row's value, source, period_end and evidence count.
    `null` for `prior` when this is the first period with an override.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    row = (await db.execute(
        select(AccountReviewStatus)
        .where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end < pe,
            AccountReviewStatus.subledger_total.is_not(None),
        )
        .order_by(desc(AccountReviewStatus.period_end))
        .limit(1)
    )).scalar_one_or_none()

    if row is None:
        return {"prior": None}

    ev_count = (await db.execute(
        select(func.count(SubledgerEvidence.id)).where(
            SubledgerEvidence.qbo_account_id == qbo_account_id,
            SubledgerEvidence.period_end == row.period_end,
        )
    )).scalar_one()

    return {
        "prior": {
            "period_end":       row.period_end.isoformat(),
            "subledger_total":  str(row.subledger_total),
            "subledger_source": row.subledger_source,
            "status":           row.status,
            "evidence_count":   int(ev_count or 0),
        }
    }


@router.get("/account/{qbo_account_id}/period-entries")
async def get_account_period_entries(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return every transaction posted to this account WITHIN the closing
    period (the month containing period_end). Used inside the manual
    subledger modal so the user can select which entries explain the
    GL-vs-subledger variance — the classic bank-rec "outstanding items"
    pattern, persisted on the override row.

    Falls through to an empty list (not 404) when QBO isn't connected so
    the modal UI degrades gracefully.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    # Month containing period_end. Most close cycles are monthly so this
    # gives the user the activity they're closing against.
    period_start = pe.replace(day=1)

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        return {"rows": [], "period_start": period_start.isoformat(),
                "period_end": pe.isoformat(), "total": "0"}

    from core.qbo_gl import pull_gl_transactions
    gl_rows = await pull_gl_transactions(conn, db, qbo_account_id, period_start, pe)

    rows = []
    total = Decimal("0")
    for r in gl_rows:
        amount = r["amount"]
        total += amount
        rows.append({
            "txn_id":     r["qbo_txn_id"] or "",
            "txn_type":   r["txn_type"],
            "txn_number": r["txn_number"] or "",
            "txn_date":   r["txn_date"].isoformat() if r["txn_date"] else "",
            "amount":     str(amount),
            "memo":       r["memo"] or "",
            "entity":     r["entity_name"] or "",
        })
    return {
        "rows":         rows,
        "period_start": period_start.isoformat(),
        "period_end":   pe.isoformat(),
        "total":        str(total.quantize(Decimal("0.01"))),
    }


# ── Evidence (attached source documents for manual overrides) ────────────────

_ALLOWED_EVIDENCE_EXTS = {"pdf", "xlsx", "xls", "csv", "png", "jpg", "jpeg"}
_ALLOWED_EVIDENCE_MIMES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "image/png",
    "image/jpeg",
}
_MAX_EVIDENCE_BYTES = 15 * 1024 * 1024  # 15 MB


def _serialize_evidence(e: SubledgerEvidence) -> dict:
    return {
        "id":          str(e.id),
        "file_name":   e.file_name,
        "file_size":   e.file_size,
        "mime_type":   e.mime_type,
        "uploaded_by": str(e.uploaded_by),
        "uploaded_at": e.uploaded_at.isoformat() if e.uploaded_at else None,
        "verification": e.verification,
    }


@router.get("/account/{qbo_account_id}/evidence")
async def list_account_evidence(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return the list of attached evidence files for one account+period."""
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    rows = list((await db.execute(
        select(SubledgerEvidence)
        .where(
            SubledgerEvidence.qbo_account_id == qbo_account_id,
            SubledgerEvidence.period_end == pe,
        )
        .order_by(desc(SubledgerEvidence.uploaded_at))
    )).scalars().all())
    return {"evidence": [_serialize_evidence(r) for r in rows]}


@router.post("/account/{qbo_account_id}/evidence", status_code=status.HTTP_201_CREATED)
async def upload_account_evidence(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Upload a supporting document (bank statement, FA register, etc.) for a
    manual subledger override. Stored in R2, listed alongside the override,
    used by reviewers to verify the entered value.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    name = file.filename or "evidence"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in _ALLOWED_EVIDENCE_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"File type .{ext} not allowed. Use: {', '.join(sorted(_ALLOWED_EVIDENCE_EXTS))}.",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > _MAX_EVIDENCE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large (max {_MAX_EVIDENCE_BYTES // (1024 * 1024)} MB).",
        )

    mime = file.content_type or "application/octet-stream"
    # Don't fully reject on MIME alone — browsers can mis-label — but warn
    # via the audit log if it's unfamiliar.
    safe_name = name.replace("/", "_").replace("\\", "_")
    key = r2_storage.tenant_key(
        tenant_id,
        f"subledger-evidence/{qbo_account_id}/{pe.isoformat()}",
        f"{uuid.uuid4()}_{safe_name}",
    )
    r2_storage.upload_file(key, io.BytesIO(raw), content_type=mime)

    row = SubledgerEvidence(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        qbo_account_id=qbo_account_id,
        period_end=pe,
        file_name=safe_name,
        file_size=len(raw),
        mime_type=mime,
        r2_key=key,
        uploaded_by=user.id,
    )
    db.add(row)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.evidence_uploaded",
        entity_type="subledger_evidence", entity_id=row.id,
        metadata={
            "summary": f"Uploaded {safe_name} ({len(raw)} bytes) for account {qbo_account_id} ({pe})",
            "qbo_account_id": qbo_account_id,
            "period_end": pe.isoformat(),
            "mime_unrecognized": mime not in _ALLOWED_EVIDENCE_MIMES,
        },
    )
    await db.commit()
    await db.refresh(row)
    return _serialize_evidence(row)


@router.get("/evidence/{evidence_id}/download")
async def download_account_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return a short-lived signed URL the browser can hit to download the file.
    Tenant scoping ensures users can only ever fetch their own org's files.
    """
    row = (await db.execute(
        select(SubledgerEvidence).where(SubledgerEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")
    url = r2_storage.generate_presigned_download_url(row.r2_key, expires_in=300)
    return {"download_url": url, "file_name": row.file_name, "mime_type": row.mime_type}


@router.post("/evidence/{evidence_id}/verify")
async def verify_account_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Ask Anthropic to read the attached document and pull out the actual
    balance + statement date + doc type. Compare against the user-entered
    subledger value. Cache the result on the evidence row so subsequent
    requests don't re-spend tokens.

    Returns the merged verification envelope:
      { extracted_balance, statement_date, doc_type, doc_identifier,
        match_status, difference, confidence, summary, model, verified_at }
    """
    ev = (await db.execute(
        select(SubledgerEvidence).where(SubledgerEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if ev is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")

    # Fetch the bytes from R2 via signed URL → download.
    # Avoid pulling the full file through this process if cache exists.
    review = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == ev.qbo_account_id,
            AccountReviewStatus.period_end == ev.period_end,
        )
    )).scalar_one_or_none()

    entered = review.subledger_total if review else None
    account_type_hint: str | None = None  # we'd need a QBO lookup; pass None for now

    # Pull the bytes from R2. The boto3 S3 client is sync — wrap the get +
    # the AI call in a thread so we don't block the event loop.
    try:
        obj = await asyncio.to_thread(
            r2_storage._s3.get_object,  # type: ignore[attr-defined]  # _s3 is a private but stable client
            Bucket=_settings.r2_bucket_name, Key=ev.r2_key,
        )
        raw = obj["Body"].read()
    except Exception as e:
        logger.exception("R2 fetch failed during verify")
        raise HTTPException(status_code=502, detail=f"Could not load file from storage: {e}")

    from modules.recons.ai_verify import verify_evidence_document, compute_match
    try:
        extracted = await asyncio.to_thread(
            verify_evidence_document,
            raw, ev.mime_type, ev.file_name, account_type_hint, ev.period_end.isoformat(),
        )
    except Exception as e:
        logger.exception("AI verify failed")
        raise HTTPException(status_code=502, detail=f"AI verification failed: {e}")

    match_status, diff_str = compute_match(extracted.get("extracted_balance"), entered)
    merged = {
        **extracted,
        "match_status": match_status,
        "difference":   diff_str,
        "verified_at":  datetime.now(timezone.utc).isoformat(),
    }
    ev.verification = merged

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.evidence_verified",
        entity_type="subledger_evidence", entity_id=ev.id,
        metadata={
            "summary":      f"Verified evidence {ev.file_name} — {match_status}",
            "match_status": match_status,
            "confidence":   extracted.get("confidence"),
            "model":        extracted.get("model"),
        },
    )
    await db.commit()
    return merged


@router.delete("/evidence/{evidence_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove an attached evidence file."""
    row = (await db.execute(
        select(SubledgerEvidence).where(SubledgerEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")
    r2_storage.delete_file(row.r2_key)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.evidence_deleted",
        entity_type="subledger_evidence", entity_id=row.id,
        metadata={
            "summary": f"Deleted evidence {row.file_name} for account {row.qbo_account_id} ({row.period_end})",
            "qbo_account_id": row.qbo_account_id,
            "period_end": row.period_end.isoformat(),
        },
    )
    await db.delete(row)
    await db.commit()


# ── Reviewer dashboard: every manual override for the tenant ─────────────────

@router.get("/overrides")
async def list_overrides(
    tenant_id: CurrentTenantId,
    period_end: str | None = Query(default=None, description="Filter by period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Reviewer's one-stop QC list — every manual subledger override across
    every account+period (optionally filtered to one period). Each entry
    carries the entered value, source label, evidence count, and review
    status so the reviewer can triage at a glance and click in to verify.
    """
    from datetime import date as _date
    stmt = (
        select(AccountReviewStatus)
        .where(AccountReviewStatus.subledger_total.is_not(None))
        .order_by(desc(AccountReviewStatus.subledger_entered_at))
    )
    if period_end:
        try:
            pe = _date.fromisoformat(period_end)
        except ValueError:
            raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
        stmt = stmt.where(AccountReviewStatus.period_end == pe)

    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        return {"overrides": []}

    # Bulk-load evidence counts + verification status in one query so the
    # reviewer dashboard can show AI-verified vs unverified at a glance.
    if rows:
        ev_rows_full = list((await db.execute(
            select(SubledgerEvidence)
        )).scalars().all())
    else:
        ev_rows_full = []
    ev_index: dict[tuple[str, Any], list[SubledgerEvidence]] = {}
    for e in ev_rows_full:
        ev_index.setdefault((e.qbo_account_id, e.period_end), []).append(e)

    out = []
    for r in rows:
        files = ev_index.get((r.qbo_account_id, r.period_end), [])
        # Verified status: best-of all attached files.
        match_states = [
            (f.verification or {}).get("match_status") for f in files if f.verification
        ]
        if "match" in match_states:
            verified_state = "match"
        elif "mismatch" in match_states:
            verified_state = "mismatch"
        elif match_states:
            verified_state = "unknown"
        else:
            verified_state = "unverified"

        out.append({
            "qbo_account_id":         r.qbo_account_id,
            "period_end":             r.period_end.isoformat(),
            "subledger_total":        str(r.subledger_total) if r.subledger_total is not None else None,
            "subledger_source":       r.subledger_source,
            "subledger_entered_by":   str(r.subledger_entered_by) if r.subledger_entered_by else None,
            "subledger_entered_at":   r.subledger_entered_at.isoformat() if r.subledger_entered_at else None,
            "status":                 r.status,
            "reviewed_by":            str(r.reviewed_by) if r.reviewed_by else None,
            "reviewed_at":            r.reviewed_at.isoformat() if r.reviewed_at else None,
            "evidence_count":         len(files),
            "verification_state":     verified_state,
        })
    return {"overrides": out}


@router.post("/clear-synced-data", status_code=status.HTTP_200_OK)
async def clear_synced_data(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Wipe all persisted reconciliations / items / transactions / notes for
    this workspace. Useful when the user wants to start fresh (e.g. after
    a QBO re-sync brought in different data, or to clear demo data).
    The QBO connection itself is preserved — only Nordavix-side cached
    reconciliation records are deleted.
    """
    # Delete in FK-safe order: notes → transactions → items → reconciliations
    await db.execute(delete(ReconNote))
    await db.execute(delete(ReconTransaction))
    await db.execute(delete(ReconciliationItem))
    await db.execute(delete(Reconciliation))
    await db.commit()
    return {"status": "ok", "message": "All cached reconciliation data cleared."}


# ── Persistent-reconciliations dashboard (deprecated entry, kept for now) ────

@router.get("/dashboard", response_model=ReconciliationDashboard)
async def get_dashboard(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationDashboard:
    recons = list((await db.execute(
        select(Reconciliation).order_by(desc(Reconciliation.created_at))
    )).scalars().all())

    item_rows = list((await db.execute(
        select(ReconciliationItem)
    )).scalars().all())

    total = len(recons)
    completed = sum(1 for r in recons if r.status == "approved")
    pending_review = sum(1 for r in recons if r.status in ("in_review", "computing", "syncing"))
    high_risk = sum(1 for i in item_rows if i.risk_level == "high")
    unresolved = sum((abs(r.difference) for r in recons if r.status != "approved"), Decimal("0"))
    overdue = sum((i.aging_61_90 + i.aging_over_90 for i in item_rows), Decimal("0"))

    stats = ReconciliationDashboardStats(
        total=total,
        completed=completed,
        pending_review=pending_review,
        high_risk_accounts=high_risk,
        unresolved_difference=unresolved,
        overdue_aging_total=overdue,
    )

    recent = recons[:6]

    # Build a synthetic activity feed from recon timestamps + notes.
    activity: list[ActivityFeedEntry] = []
    notes = list((await db.execute(
        select(ReconNote).order_by(desc(ReconNote.created_at)).limit(20)
    )).scalars().all())
    name_lookup = {r.id: r.name for r in recons}

    for r in recons[:10]:
        activity.append(ActivityFeedEntry(
            kind="created",
            recon_id=r.id,
            recon_name=r.name,
            happened_at=r.created_at,
            actor_id=r.created_by,
            summary=f"Created {r.recon_type} reconciliation for {r.period_end}",
        ))
        if r.approved_at:
            activity.append(ActivityFeedEntry(
                kind="approved",
                recon_id=r.id,
                recon_name=r.name,
                happened_at=r.approved_at,
                actor_id=r.approved_by,
                summary=f"Approved {r.name}",
            ))
        if r.ai_summary:
            activity.append(ActivityFeedEntry(
                kind="ai_commentary",
                recon_id=r.id,
                recon_name=r.name,
                happened_at=r.updated_at,
                actor_id=None,
                summary="AI commentary generated",
            ))

    for n in notes:
        activity.append(ActivityFeedEntry(
            kind="noted",
            recon_id=n.reconciliation_id,
            recon_name=name_lookup.get(n.reconciliation_id, "Reconciliation"),
            happened_at=n.created_at,
            actor_id=n.author_id,
            summary=(n.body[:80] + "…") if len(n.body) > 80 else n.body,
        ))

    activity.sort(key=lambda e: e.happened_at, reverse=True)
    activity = activity[:15]

    return ReconciliationDashboard(
        stats=stats,
        recent=[ReconciliationResponse.model_validate(r) for r in recent],
        activity=activity,
        ai_insights=insights_from(recons, item_rows),
    )


# ── Get one ────────────────────────────────────────────────────────────────────

@router.get("/{recon_id}", response_model=ReconciliationDetail)
async def get_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationDetail:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    items = list((await db.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon_id)
        .order_by(desc(ReconciliationItem.subledger_balance))
    )).scalars().all())

    item_ids = [i.id for i in items]
    txns: list[ReconTransaction] = []
    if item_ids:
        txns = list((await db.execute(
            select(ReconTransaction).where(ReconTransaction.reconciliation_item_id.in_(item_ids))
        )).scalars().all())

    notes = list((await db.execute(
        select(ReconNote).where(ReconNote.reconciliation_id == recon_id)
        .order_by(desc(ReconNote.created_at))
    )).scalars().all())

    return ReconciliationDetail(
        recon=ReconciliationResponse.model_validate(recon),
        items=[ReconciliationItemResponse.model_validate(i) for i in items],
        transactions=[ReconTransactionResponse.model_validate(t) for t in txns],
        notes=[ReconNoteResponse.model_validate(n) for n in notes],
    )


# ── Sync (re-pull from QBO) ───────────────────────────────────────────────────

@router.post("/{recon_id}/sync", response_model=ReconciliationResponse)
async def sync_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.status = "syncing"
    recon.error_detail = None
    await db.commit()
    background_tasks.add_task(run_sync, recon_id, tenant_id)
    await db.refresh(recon)
    return recon


# ── Approve / assign ──────────────────────────────────────────────────────────

@router.post("/{recon_id}/approve", response_model=ReconciliationResponse)
async def approve_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.approved_by = user.id
    recon.approved_at = datetime.now(timezone.utc)
    recon.status = "approved"
    await db.commit()
    return recon


@router.post("/{recon_id}/assign", response_model=ReconciliationResponse)
async def assign_reconciliation(
    recon_id: uuid.UUID,
    body: AssignBody,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.assigned_to = body.user_id
    await db.commit()
    return recon


# ── Notes ─────────────────────────────────────────────────────────────────────

@router.post("/{recon_id}/notes", response_model=ReconNoteResponse, status_code=status.HTTP_201_CREATED)
async def add_note(
    recon_id: uuid.UUID,
    body: NoteCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ReconNote:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    note = ReconNote(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        reconciliation_id=recon_id,
        reconciliation_item_id=body.reconciliation_item_id,
        author_id=user.id,
        body=body.body,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


# ── Item-level actions ────────────────────────────────────────────────────────

@router.put("/{recon_id}/items/{item_id}/status", response_model=ReconciliationItemResponse)
async def set_item_status(
    recon_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ItemStatusUpdate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationItem:
    item = (await db.execute(
        select(ReconciliationItem).where(
            ReconciliationItem.id == item_id,
            ReconciliationItem.reconciliation_id == recon_id,
        )
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    item.status = body.status
    if body.status == "approved":
        item.approved_by = user.id
        item.approved_at = datetime.now(timezone.utc)
    await db.commit()
    return item


@router.post("/{recon_id}/items/{item_id}/explain", response_model=ReconciliationItemResponse)
async def explain_item_endpoint(
    recon_id: uuid.UUID,
    item_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationItem:
    """
    Generate (or regenerate) AI commentary for a single reconciliation item.
    Synchronous from the caller's perspective so the UI can show the new
    commentary the moment the request returns — no background polling.
    """
    item = (await db.execute(
        select(ReconciliationItem).where(
            ReconciliationItem.id == item_id,
            ReconciliationItem.reconciliation_id == recon_id,
        )
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    commentary = await explain_item(db, recon, item)
    if commentary:
        item.ai_commentary = commentary
        await db.commit()
        await db.refresh(item)
    return item


@router.post("/{recon_id}/explain", response_model=ReconciliationResponse)
async def explain_recon_endpoint(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    """
    Generate the AI executive summary for the whole reconciliation.
    On-demand only — never auto-runs during sync.
    """
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    summary = await explain_recon_summary(db, recon)
    if summary:
        recon.ai_summary = summary
        await db.commit()
        await db.refresh(recon)
    return recon


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{recon_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> None:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    await db.delete(recon)
    await db.commit()


# ── Export support package (Excel) ────────────────────────────────────────────

@router.get("/{recon_id}/export")
async def export_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    items = list((await db.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon_id)
        .order_by(desc(ReconciliationItem.subledger_balance))
    )).scalars().all())
    item_ids = [i.id for i in items]

    txns: list[ReconTransaction] = []
    if item_ids:
        txns = list((await db.execute(
            select(ReconTransaction).where(ReconTransaction.reconciliation_item_id.in_(item_ids))
        )).scalars().all())

    notes = list((await db.execute(
        select(ReconNote).where(ReconNote.reconciliation_id == recon_id)
        .order_by(ReconNote.created_at)
    )).scalars().all())

    name_by_item = {i.id: i.entity_name for i in items}

    summary_df = pd.DataFrame({
        "Field": ["Reconciliation", "Type", "Period End", "GL Total",
                  "Subledger Total", "Difference", "Status", "AI Summary"],
        "Value": [recon.name, recon.recon_type, str(recon.period_end),
                  f"${float(recon.gl_total):,.2f}",
                  f"${float(recon.subledger_total):,.2f}",
                  f"${float(recon.difference):,.2f}",
                  recon.status, recon.ai_summary or ""],
    })
    items_df = pd.DataFrame([{
        "Entity": i.entity_name,
        "GL Balance": float(i.gl_balance),
        "Subledger Balance": float(i.subledger_balance),
        "Difference": float(i.difference),
        "Current": float(i.aging_current),
        "1-30": float(i.aging_1_30),
        "31-60": float(i.aging_31_60),
        "61-90": float(i.aging_61_90),
        "Over 90": float(i.aging_over_90),
        "Risk": i.risk_level,
        "Status": i.status,
        "AI Commentary": i.ai_commentary or "",
    } for i in items])
    txns_df = pd.DataFrame([{
        "Entity": name_by_item.get(t.reconciliation_item_id, ""),
        "Category": t.category,
        "Type": t.txn_type,
        "Number": t.txn_number or "",
        "Date": str(t.txn_date) if t.txn_date else "",
        "Amount": float(t.amount),
        "Memo": t.memo or "",
    } for t in txns])
    notes_df = pd.DataFrame([{
        "When": n.created_at.isoformat(),
        "Body": n.body,
    } for n in notes])

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        summary_df.to_excel(writer, sheet_name="Summary", index=False)
        items_df.to_excel(writer, sheet_name="Items", index=False)
        if not txns_df.empty:
            txns_df.to_excel(writer, sheet_name="Evidence", index=False)
        if not notes_df.empty:
            notes_df.to_excel(writer, sheet_name="Notes", index=False)
        for sheet in writer.sheets.values():
            for col in sheet.columns:
                max_len = max((len(str(c.value or "")) for c in col), default=10)
                sheet.column_dimensions[col[0].column_letter].width = min(max_len + 2, 60)

    buf.seek(0)
    safe = recon.name.replace(" ", "_").replace("/", "-")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{safe}_reconciliation.xlsx"'},
    )
