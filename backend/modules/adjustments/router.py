"""
Adjustments API — review queue + actions for AI-proposed journal entries.

  GET    /adjustments                 list proposals (filter by period/source/status/source_ref)
  GET    /adjustments/accounts        chart of accounts for the JE-line editor
  POST   /adjustments/{id}/accept     reviewer approves the draft       (reviewer+)
  POST   /adjustments/{id}/dismiss    reject / not applicable           (preparer+)
  POST   /adjustments/{id}/mark-posted  human booked it in QBO          (preparer+)
  PATCH  /adjustments/{id}            edit lines/memo before accepting  (preparer+, open only)

Backs both the inline proposed-entry cards (filtered by source_ref) and the
consolidated review queue. We never write to QuickBooks — accept/post only
record the review state; the human posts the entry.
"""
import logging
import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.db.session import get_db
from models.closed_period import ClosedPeriod
from models.proposed_entry import ProposedEntry
from models.user import User
from modules.adjustments.service import (
    VALID_SOURCES,
    VALID_STATUSES,
    lines_balanced,
    normalize_lines,
    period_accounts,
    serialize,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_period(period_end: str | None) -> date | None:
    if not period_end:
        return None
    try:
        return date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")


async def _is_closed(db: AsyncSession, tenant_id: uuid.UUID, period_end: date) -> bool:
    row = (await db.execute(
        select(ClosedPeriod).where(
            ClosedPeriod.tenant_id == tenant_id,
            ClosedPeriod.period_end == period_end,
        )
    )).scalar_one_or_none()
    return row is not None


async def _load(db: AsyncSession, entry_id: str) -> ProposedEntry:
    try:
        eid = uuid.UUID(entry_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid entry id.")
    # Tenant auto-filter on the SELECT scopes this to the caller's workspace.
    row = (await db.execute(
        select(ProposedEntry).where(ProposedEntry.id == eid)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Proposed entry not found.")
    return row


# ── List + accounts ───────────────────────────────────────────────────────


@router.get("")
async def list_proposals(
    tenant_id: CurrentTenantId,
    period_end: str | None = Query(None, description="Period end YYYY-MM-DD"),
    source: str | None = Query(None, description="bank | recon | flux"),
    status: str | None = Query(None, description="open | accepted | posted | dismissed"),
    source_ref: str | None = Query(None, description="origin key (account id / variance id)"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """List proposed entries for the workspace, newest first. The inline cards
    pass source + source_ref; the queue passes just period_end."""
    pe = _parse_period(period_end)
    stmt = select(ProposedEntry)
    if pe is not None:
        stmt = stmt.where(ProposedEntry.period_end == pe)
    if source in VALID_SOURCES:
        stmt = stmt.where(ProposedEntry.source == source)
    if status in VALID_STATUSES:
        stmt = stmt.where(ProposedEntry.status == status)
    if source_ref:
        stmt = stmt.where(ProposedEntry.source_ref == source_ref)
    stmt = stmt.order_by(ProposedEntry.created_at.desc())

    rows = (await db.execute(stmt)).scalars().all()
    items = [serialize(r) for r in rows]
    return {
        "items": items,
        "open_count": sum(1 for r in rows if r.status == "open"),
    }


@router.get("/accounts")
async def list_accounts(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Chart of accounts captured for this period (for the JE-line editor)."""
    pe = _parse_period(period_end)
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    accounts = await period_accounts(db, tenant_id, pe)
    accounts.sort(key=lambda a: (a.get("account_number") or "", a.get("account_name") or ""))
    return {"accounts": accounts}


# ── Lifecycle transitions ─────────────────────────────────────────────────


async def _transition(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: CurrentUser,
    entry_id: str,
    *,
    new_status: str,
    action: str,
) -> dict:
    entry = await _load(db, entry_id)
    if await _is_closed(db, tenant_id, entry.period_end):
        raise HTTPException(
            status_code=423,
            detail=(
                f"Books are closed for period {entry.period_end}. "
                "An admin must reopen the period before changing proposed entries."
            ),
        )
    prev = entry.status
    entry.status = new_status
    entry.status_changed_at = datetime.now(UTC)
    entry.status_changed_by = user.id
    await write_audit_event(
        db,
        tenant_id=tenant_id,
        user_id=user.id,
        action=action,
        entity_type="proposed_entry",
        entity_id=entry.id,
        metadata={"source": entry.source, "status_before": prev, "status_after": new_status},
    )
    await db.commit()
    await db.refresh(entry)
    return serialize(entry)


@router.post("/{entry_id}/accept")
async def accept_proposal(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Approve the draft. Reviewer+ — accepting an adjusting entry is an
    approval, mirroring the recon/flux approve gates."""
    return await _transition(
        db, tenant_id, user, entry_id, new_status="accepted", action="adjustment.accept"
    )


@router.post("/{entry_id}/dismiss")
async def dismiss_proposal(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Reject the draft (not applicable / wrong)."""
    return await _transition(
        db, tenant_id, user, entry_id, new_status="dismissed", action="adjustment.dismiss"
    )


@router.post("/{entry_id}/mark-posted")
async def mark_posted(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Record that the human booked this entry in QuickBooks."""
    return await _transition(
        db, tenant_id, user, entry_id, new_status="posted", action="adjustment.posted"
    )


# ── Edit (before acceptance) ──────────────────────────────────────────────


@router.patch("/{entry_id}")
async def edit_proposal(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Edit a still-open draft — typically to pick the right offset account or
    tweak the memo before accepting. Re-validates that the lines balance."""
    entry = await _load(db, entry_id)
    if entry.status != "open":
        raise HTTPException(
            status_code=409,
            detail=f"Only open proposals can be edited (this one is {entry.status}).",
        )
    if await _is_closed(db, tenant_id, entry.period_end):
        raise HTTPException(status_code=423, detail="Books are closed for this period.")

    if "lines" in payload:
        lines = normalize_lines(payload.get("lines"))
        if not lines_balanced(lines):
            raise HTTPException(
                status_code=422,
                detail="Journal entry must balance: total debits must equal total credits.",
            )
        entry.lines = lines
    if "description" in payload and payload["description"]:
        entry.description = str(payload["description"]).strip()[:500]
    if "memo" in payload:
        entry.memo = (str(payload["memo"]).strip()[:500] or None) if payload["memo"] else None

    await write_audit_event(
        db,
        tenant_id=tenant_id,
        user_id=user.id,
        action="adjustment.edit",
        entity_type="proposed_entry",
        entity_id=entry.id,
        metadata={"source": entry.source},
    )
    await db.commit()
    await db.refresh(entry)
    return serialize(entry)
