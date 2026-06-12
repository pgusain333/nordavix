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

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.db.session import get_db
from models.account_review_status import AccountReviewStatus
from models.closed_period import ClosedPeriod
from models.proposed_entry import ProposedEntry
from models.qbo_connection import QboConnection
from models.user import User
from modules.adjustments.service import (
    VALID_SOURCES,
    VALID_STATUSES,
    build_qbo_je_csv,
    lines_balanced,
    match_entry_to_qbo,
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
    # Saved entries are a locked batch: they can advance to 'posted' but can't be
    # dismissed (the user's "never delete / saved" guarantee).
    if new_status == "dismissed" and entry.saved_at is not None:
        raise HTTPException(
            status_code=409,
            detail="This entry is part of a saved batch and is locked — saved adjustments can't be dismissed.",
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
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Reject the draft (not applicable / wrong). Reviewer+ — killing a
    proposed entry is a review decision, the mirror image of accepting it."""
    return await _transition(
        db, tenant_id, user, entry_id, new_status="dismissed", action="adjustment.dismiss"
    )


@router.post("/{entry_id}/mark-posted")
async def mark_posted(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Record that the human booked this entry in QuickBooks. Reviewer+ —
    asserting "this is in the books now" is checker territory."""
    return await _transition(
        db, tenant_id, user, entry_id, new_status="posted", action="adjustment.posted"
    )


# ── Edit (before acceptance) ──────────────────────────────────────────────


@router.patch("/{entry_id}")
async def edit_proposal(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Edit a still-open draft — typically to pick the right offset account or
    tweak the memo before accepting. Re-validates that the lines balance.
    Reviewer+ — edits feed straight into accept, so they share its gate."""
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


# ── Save batch + QBO CSV export ───────────────────────────────────────────


@router.post("/save")
async def save_batch(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Finalize a period's adjustments once every entry is reviewed: stamp the
    approved entries as 'Saved' (locked + permanent), which unlocks the QBO CSV
    export and the posting check. Requires no entry left 'open'. Reviewer+."""
    pe = _parse_period(period_end)
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    if await _is_closed(db, tenant_id, pe):
        raise HTTPException(status_code=423, detail="Books are closed for this period.")

    rows = (await db.execute(
        select(ProposedEntry).where(ProposedEntry.period_end == pe)
    )).scalars().all()
    active = [r for r in rows if r.status != "dismissed"]
    if not active:
        raise HTTPException(status_code=400, detail="No approved entries to save for this period.")
    open_n = sum(1 for r in active if r.status == "open")
    if open_n:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Approve all {open_n} remaining entr{'y' if open_n == 1 else 'ies'} "
                "before saving the batch."
            ),
        )

    now = datetime.now(UTC)
    newly_saved = 0
    for r in active:
        if r.saved_at is None:
            r.saved_at = now
            r.saved_by = user.id
            newly_saved += 1

    await write_audit_event(
        db,
        tenant_id=tenant_id,
        user_id=user.id,
        action="adjustment.save_batch",
        entity_type="proposed_entry",
        entity_id=None,
        metadata={"period_end": pe.isoformat(), "newly_saved": newly_saved, "total_saved": len(active)},
    )
    await db.commit()
    return {"period_end": pe.isoformat(), "newly_saved": newly_saved, "saved_total": len(active)}


@router.get("/export.csv")
async def export_csv(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Download the saved adjustments for a period as a QuickBooks Online
    Accountant 'Import journal entries' CSV. Only saved (approved + locked)
    entries are included — open/dismissed drafts are excluded."""
    pe = _parse_period(period_end)
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    rows = (await db.execute(
        select(ProposedEntry)
        .where(ProposedEntry.period_end == pe, ProposedEntry.saved_at.isnot(None))
        .order_by(ProposedEntry.created_at.asc())
    )).scalars().all()
    if not rows:
        raise HTTPException(
            status_code=404,
            detail="No saved entries for this period. Approve the entries and click Save first.",
        )
    csv_text = build_qbo_je_csv(rows)
    filename = f"nordavix_adjustments_{pe.isoformat()}.csv"
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Posting check (read QBO) + reopen affected recons ─────────────────────


async def _reopen_recons(
    db: AsyncSession,
    tenant_id,
    qbo_account_ids: set[str],
    period_end: date,
    *,
    user_id,
) -> list[str]:
    """Reset the recons for the given accounts at this period back to pending so
    they're re-reconciled against the post-adjustment GL. Mirrors the recon
    'Reset to pending' action (clears subledger override, reconciling items, AI
    commentary, and all actor stamps). Caller commits. Returns the account ids
    reopened."""
    ids = {a for a in qbo_account_ids if a}
    if not ids:
        return []
    rows = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.tenant_id == tenant_id,
            AccountReviewStatus.period_end == period_end,
            AccountReviewStatus.qbo_account_id.in_(ids),
        ),
        execution_options={"skip_tenant_filter": True},
    )).scalars().all()
    reopened: list[str] = []
    for r in rows:
        if r.status == "pending":
            continue
        r.status = "pending"
        r.subledger_total = None
        r.subledger_source = None
        r.subledger_entered_by = None
        r.subledger_entered_at = None
        r.reconciling_items = []
        r.ai_commentary = None
        r.reviewed_by = None
        r.reviewed_at = None
        r.prepared_by = None
        r.prepared_at = None
        r.approved_by = None
        r.approved_at = None
        await write_audit_event(
            db,
            tenant_id=tenant_id,
            user_id=user_id,
            action="recon.reopen_after_adjustment",
            entity_type="account_review_status",
            entity_id=r.id,
            metadata={"qbo_account_id": r.qbo_account_id, "period_end": period_end.isoformat()},
        )
        reopened.append(r.qbo_account_id)
    return reopened


@router.post("/check-posted")
async def check_posted(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Read QuickBooks (read-only) and check whether each saved adjustment has
    been posted, matching by account + amount + posting type within the period.
    When every saved entry is found, reopen the reconciliations for the accounts
    those entries hit so they can be reconciled against the new GL. Reviewer+."""
    pe = _parse_period(period_end)
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    if await _is_closed(db, tenant_id, pe):
        raise HTTPException(status_code=423, detail="Books are closed for this period.")

    saved = (await db.execute(
        select(ProposedEntry)
        .where(ProposedEntry.period_end == pe, ProposedEntry.saved_at.isnot(None))
        .order_by(ProposedEntry.created_at.asc())
    )).scalars().all()
    if not saved:
        raise HTTPException(
            status_code=400,
            detail="No saved entries to check. Approve the entries and click Save first.",
        )

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=400, detail="Connect QuickBooks to check posting status.")

    from modules.recons.service import fetch_posted_journal_entries
    from modules.schedules.calc import _period_bounds
    start, end = _period_bounds(pe)
    try:
        qbo_jes = await fetch_posted_journal_entries(conn, db, start=start, end=end)
    except Exception as exc:
        logger.exception("QBO journal-entry fetch failed (tenant=%s, period=%s)", tenant_id, pe)
        raise HTTPException(
            status_code=502,
            detail="Couldn't read journal entries from QuickBooks. Try again, or reconnect QuickBooks.",
        ) from exc

    now = datetime.now(UTC)
    results: list[dict] = []
    for e in saved:
        doc = match_entry_to_qbo(e, qbo_jes)
        found = doc is not None
        if found and e.status != "posted":
            e.status = "posted"
            e.status_changed_at = now
            e.status_changed_by = user.id
            await write_audit_event(
                db,
                tenant_id=tenant_id,
                user_id=user.id,
                action="adjustment.detected_posted",
                entity_type="proposed_entry",
                entity_id=e.id,
                metadata={"qbo_doc": doc},
            )
        results.append({
            "id": str(e.id),
            "description": e.description,
            "posted": found or e.status == "posted",
            "qbo_doc": doc,
        })

    all_posted = bool(results) and all(r["posted"] for r in results)
    reopened: list[str] = []
    if all_posted:
        affected = {
            str(ln.get("account_qbo_id"))
            for e in saved for ln in (e.lines or [])
            if ln.get("account_qbo_id")
        }
        reopened = await _reopen_recons(db, tenant_id, affected, pe, user_id=user.id)

    await db.commit()
    return {
        "period_end": pe.isoformat(),
        "entries": results,
        "total": len(results),
        "posted_count": sum(1 for r in results if r["posted"]),
        "all_posted": all_posted,
        "reopened_accounts": reopened,
    }
