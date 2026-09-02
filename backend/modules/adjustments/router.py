"""
Adjustments API — review queue + actions for AI-proposed journal entries.

  GET    /adjustments                 list proposals (filter by period/source/status/source_ref)
  GET    /adjustments/accounts        chart of accounts for the JE-line editor
  GET    /adjustments/net-effect      what a period's adjustments do to the statements
  GET    /adjustments/{id}/trace      the full provenance of one entry
  POST   /adjustments/{id}/accept     reviewer approves the draft        (reviewer+)
  POST   /adjustments/{id}/reopen     pull an approved entry back to open (admin + reviewer)
  POST   /adjustments/{id}/dismiss    reject, with a required reason     (reviewer+)
  POST   /adjustments/{id}/mark-posted  human booked it in QBO           (reviewer+)
  PATCH  /adjustments/{id}            edit lines/memo before accepting   (preparer+, open only)

Backs both the inline proposed-entry cards (filtered by source_ref) and the
consolidated review queue. We never write to QuickBooks — accept/post only
record the review state; the human posts the entry.

Every entry can account for itself: where it came from, what it is made of, who
decided what and why, what supports it, and what changed as a result. Those are
the five sections of /trace, and the columns behind them (prepared_by,
approved_by, dismiss_reason, posted_qbo_doc) exist so the row can answer without
anyone reconstructing it from memory.
"""
import logging
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.db.base import current_request_readonly
from core.db.session import get_db
from models.account import Account
from models.account_review_status import AccountReviewStatus
from models.audit_log import AuditLog
from models.closed_period import ClosedPeriod
from models.proposed_entry import ProposedEntry
from models.qbo_connection import QboConnection
from models.trial_balance import TrialBalance
from models.user import User
from models.variance import Variance
from modules.adjustments.service import (
    EFFECT_LINES,
    VALID_SOURCES,
    VALID_STATUSES,
    baseline_disposition,
    blocks_self_approval,
    build_qbo_je_csv,
    close_only,
    combine_effects,
    entry_subject,
    lines_balanced,
    match_entry_to_qbo,
    net_effect,
    normalize_lines,
    period_accounts,
    serialize,
    sync_entry_graph,
)
from modules.memory import service as memory

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
        close_only(select(ProposedEntry).where(ProposedEntry.id == eid))
    )).scalar_one_or_none()
    if row is None:
        # Also the answer for another product's entry (e.g. a §471(c) reclass):
        # it is not this queue's to accept, dismiss, edit or post.
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
    stmt = close_only(select(ProposedEntry))
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
    enforce_maker_checker: bool = False,
    clear_saved: bool = False,
    reason: str | None = None,
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
    # Maker/checker: the user who prepared/edited this draft can't also be the
    # one who signs it off. Reads prepared_by, which ONLY the edit path writes —
    # it used to read status_changed_by, which every transition also stamped, so
    # approving an entry overwrote the very fact the control depends on and a
    # reviewer who reopened an entry was then blocked from re-approving it.
    # Admins bypass — master access for solo firms — mirroring the recon
    # subledger control.
    if enforce_maker_checker and blocks_self_approval(
        prepared_by=entry.prepared_by, user_id=user.id, role=user.role,
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                "You prepared/edited this adjusting entry — approval must come "
                "from a different reviewer (maker/checker control). Admins can bypass."
            ),
        )
    if clear_saved:
        # Reopen out of a saved batch: the entry leaves the locked/finalized
        # batch and returns to an editable open draft (it re-Saves with the
        # batch once re-approved). Until then it drops out of the CSV export +
        # posting check, which both select on saved_at.
        entry.saved_at = None
        entry.saved_by = None
    prev = entry.status
    entry.status = new_status
    entry.status_changed_at = datetime.now(UTC)
    entry.status_changed_by = user.id

    # Who approved is its own fact, kept apart from who prepared. Reopening
    # withdraws the approval, so the id goes with it — leaving it behind would
    # let a re-approved entry cite a sign-off that no longer happened.
    if new_status == "accepted":
        entry.approved_by = user.id
    elif new_status == "open":
        entry.approved_by = None
    if new_status == "dismissed":
        entry.dismiss_reason = reason
    elif new_status == "open":
        entry.dismiss_reason = None      # reopened for another look

    await write_audit_event(
        db,
        tenant_id=tenant_id,
        user_id=user.id,
        action=action,
        entity_type="proposed_entry",
        entity_id=entry.id,
        metadata={
            "source": entry.source, "status_before": prev, "status_after": new_status,
            **({"reason": reason} if reason else {}),
        },
    )

    # Knowledge graph: derived from the status we just set, so the edges cannot
    # disagree with the row. Dismissed entries KEEP a `considered_for` edge —
    # what was weighed and rejected is part of the record (best-effort; never
    # blocks the transition).
    await sync_entry_graph(db, entry)

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
        db, tenant_id, user, entry_id, new_status="accepted", action="adjustment.accept",
        enforce_maker_checker=True,
    )


# Short enough not to be a chore, long enough that a stray keystroke isn't a
# reason. Whether the words are any good is a human matter — the product's job
# is to make sure the question was asked.
MIN_DISMISS_REASON = 3


@router.post("/{entry_id}/dismiss")
async def dismiss_proposal(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    payload: dict = Body(default_factory=dict),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Reject the draft (not applicable / wrong). Reviewer+ — killing a
    proposed entry is a review decision, the mirror image of accepting it.

    A reason is REQUIRED. A dismissed entry is a decision not to book something
    the product found, and that decision outlives the person who made it: it is
    what a reviewer re-reads, what the passed-adjustments schedule aggregates,
    what an examiner asks about, and what Client Memory learns this firm's
    conventions from. Without it the record says only that six things were
    rejected, which is the same as saying nothing.
    """
    reason = str(payload.get("reason") or "").strip()[:500]
    if len(reason) < MIN_DISMISS_REASON:
        raise HTTPException(
            status_code=422,
            detail="Say why this entry isn't being booked — the reason is kept with the close record.",
        )
    return await _transition(
        db, tenant_id, user, entry_id, new_status="dismissed",
        action="adjustment.dismiss", reason=reason,
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


@router.post("/{entry_id}/reopen")
async def reopen_proposal(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Pull an approved entry back to 'open' so its accounts can be changed and
    it can be re-approved. Admin + reviewer only — un-approving is a reviewer
    decision. Works even after the batch is saved: reopening pulls the entry
    back out of the saved batch (it re-Saves with the batch once re-approved),
    so it drops out of the CSV export + posting check until then. The reopen
    itself doesn't enforce maker/checker (it's not a sign-off); re-approval
    still does, so whoever edits the account can't self-approve (admins bypass).
    Posted entries are already in QuickBooks and can't be reopened — post a new
    correcting entry instead. Closed periods are blocked (via _transition)."""
    entry = await _load(db, entry_id)
    if entry.status != "accepted":
        raise HTTPException(
            status_code=409,
            detail=f"Only approved entries can be reopened (this one is {entry.status}).",
        )
    return await _transition(
        db, tenant_id, user, entry_id, new_status="open", action="adjustment.reopen",
        clear_saved=True,
    )


# ── Edit (before acceptance) ──────────────────────────────────────────────


@router.patch("/{entry_id}")
async def edit_proposal(
    entry_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Edit a still-open draft — typically to pick the right offset account or
    tweak the memo before accepting. Re-validates that the lines balance.
    Preparer+ — preparers build the entry (select accounts) and the edit
    auto-saves for the reviewer; approval stays a separate reviewer-only gate."""
    entry = await _load(db, entry_id)
    if entry.status != "open":
        raise HTTPException(
            status_code=409,
            detail=f"Only open proposals can be edited (this one is {entry.status}).",
        )
    if await _is_closed(db, tenant_id, entry.period_end):
        raise HTTPException(status_code=423, detail="Books are closed for this period.")

    # Snapshot the AI's original lines before we overwrite them — the diff is
    # what Client Memory learns from (which offset account the human prefers).
    before_lines = list(entry.lines or [])

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

    # Record the human who prepared this draft so the approval gate can enforce
    # maker/checker (the editor can't self-approve). Its own column: writing it
    # to status_changed_by meant the next transition erased it. An untouched AI
    # draft leaves prepared_by NULL and stays approvable by anyone — the control
    # exists to separate two humans, not to block a reviewer from the machine's
    # work. The full history is the audit event below.
    entry.prepared_by = user.id

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
    result = serialize(entry)

    # ── Client Memory: learn from this correction ───────────────────────────
    # Runs AFTER the edit is durably committed, in its own transaction, so a
    # learning failure (e.g. a concurrent-insert unique race) can never block or
    # undo the edit. If the human re-pointed the offset account, record the
    # AI-original -> human-final swap and let the distiller decide whether it's
    # a repeatable convention. Skipped for read-only (demo / suspended) requests.
    if not current_request_readonly.get():
        try:
            swap = memory.detect_offset_swap(before_lines, entry.lines)
            if swap:
                # The memory key must be a STABLE account id so the convention
                # recurs. recon/bank already use source_ref = qbo_account_id;
                # flux's source_ref is the ephemeral variance id, so resolve the
                # variance's GL account (matching the flux apply lookup). If it
                # can't be resolved, skip flux capture rather than key on an id
                # that never repeats.
                mem_ref: str | None = entry.source_ref
                if entry.source == "flux":
                    mem_ref = None
                    try:
                        from models.account import Account
                        from models.variance import Variance
                        vid = uuid.UUID(entry.source_ref)
                        mem_ref = (await db.execute(
                            select(Account.qbo_account_id)
                            .join(Variance, Variance.account_id == Account.id)
                            .where(Variance.id == vid)
                        )).scalar_one_or_none()
                    except Exception:
                        mem_ref = None
                if mem_ref:
                    await memory.record_signal(
                        db, tenant_id=tenant_id, signal_type="account_swap",
                        source=entry.source, source_ref=mem_ref,
                        period_end=entry.period_end, account_key=mem_ref,
                        proposed_entry_id=entry.id, before=swap["from"], after=swap["to"],
                        created_by=user.id,
                    )
                    await memory.distill_offset_swap(
                        db, tenant_id=tenant_id, source=entry.source,
                        source_ref=mem_ref, swap=swap,
                    )
                    await db.commit()
        except Exception:
            logger.exception("client-memory capture failed (entry=%s)", entry.id)
            await db.rollback()

    return result


# ── Provenance: what an adjustment does, and where it came from ───────────


# audit action → what a person did, in words. Unknown actions fall back to the
# de-prefixed verb rather than being hidden: a trail that silently omits events
# it doesn't recognise is worse than one that prints an ugly label.
_DECISION_LABEL = {
    "adjustment.edit":            "Edited",
    "adjustment.accept":          "Approved",
    "adjustment.dismiss":         "Not booked",
    "adjustment.posted":          "Marked posted",
    "adjustment.reopen":          "Reopened for another look",
    "adjustment.detected_posted": "Found in QuickBooks",
    "adjustment.save":            "Locked into the saved batch",
}


async def _display_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[str, str]:
    """user_id → display name. Clerk profile when available, email otherwise —
    the same resolution the audit trail uses. A trace names a handful of people,
    so this stays a plain loop."""
    if not ids:
        return {}
    from core.auth.clerk_users import _format_display_name, get_clerk_user

    users = list((await db.execute(select(User).where(User.id.in_(list(ids))))).scalars().all())
    out: dict[str, str] = {}
    for u in users:
        name = u.email
        if u.clerk_user_id:
            try:
                clerk = await get_clerk_user(u.clerk_user_id)
                if clerk:
                    name = _format_display_name(clerk) or u.email
            except Exception:
                logger.debug("clerk lookup failed for %s", u.clerk_user_id, exc_info=True)
        out[str(u.id)] = name
    return out


async def _subject_label(db: AsyncSession, entry: ProposedEntry, accounts: list[dict]) -> dict | None:
    """The close object this entry was drafted about, named in English.

    Mirrors service.entry_subject — that function decides WHICH object, this one
    says what it is. Returns None for producers with no close-object subject
    (the assistant), rather than a placeholder that implies a link exists.
    """
    node = entry_subject(entry)
    if node is None:
        return None
    label = None
    if entry.source == "flux":
        try:
            v = (await db.execute(
                select(Variance).where(Variance.id == uuid.UUID(entry.source_ref))
            )).scalar_one_or_none()
            if v is not None:
                acct = (await db.execute(
                    select(Account).where(Account.id == v.account_id)
                )).scalar_one_or_none()
                name = acct.account_name if acct else "an account"
                label = f"{name} — variance of {float(v.dollar_variance):,.2f}"
        except (ValueError, TypeError):
            pass
    elif entry.source == "gl_accuracy":
        try:
            from models.gl_accuracy_finding import GlAccuracyFinding
            f = (await db.execute(
                select(GlAccuracyFinding).where(GlAccuracyFinding.id == uuid.UUID(entry.source_ref))
            )).scalar_one_or_none()
            if f is not None:
                label = f.title or f"{f.vendor} — {f.posted_account_name or 'posted account'}"
        except (ValueError, TypeError):
            pass
    else:
        match = next((a for a in accounts if a.get("qbo_account_id") == entry.source_ref), None)
        if match:
            label = f"{match.get('account_name')} reconciliation"

    return {
        "type": node.type,
        "id": node.id,
        # Naming a subject we couldn't load would assert a link that may not
        # resolve; say so instead.
        "label": label or "No longer available",
        "resolved": label is not None,
    }


@router.get("/net-effect")
async def period_net_effect(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    basis: str = Query("month", description="month | ytd — the P&L basis"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """What this period's adjustments do to the financial statements.

    Split by outcome, because the two halves answer different questions. What
    is BOOKED (accepted + posted) is the difference between the GL and the
    financials you will hand over. What was PASSED (dismissed) is the
    uncorrected-difference schedule an auditor keeps by hand: each item was
    immaterial on its own, and the only way to know whether they matter is to
    add them up. Three passed items at $340, $290 and $410 are $1,040.
    """
    pe = _parse_period(period_end)
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")

    rows = (await db.execute(
        close_only(select(ProposedEntry).where(ProposedEntry.period_end == pe))
    )).scalars().all()
    accounts = await period_accounts(db, tenant_id, pe)
    type_by_account = {
        a["qbo_account_id"]: a.get("account_type") or ""
        for a in accounts if a.get("qbo_account_id")
    }

    def _eff(r):
        return net_effect(r.lines, type_by_account=type_by_account)

    def _roll(subset):
        return combine_effects([_eff(r) for r in subset])

    booked = [r for r in rows if r.status in ("accepted", "posted")]
    passed = [r for r in rows if r.status == "dismissed"]

    from modules.financials.internal import statement_totals
    baseline = await statement_totals(
        db, tenant_id, pe, basis="month" if basis == "month" else "ytd",
    )

    # ── Which booked entries are NOT already in that baseline ────────────
    # The snapshot is a read of QuickBooks. An entry the user has posted there
    # is in it, and applying the entry again on top would double-count — the
    # exact shape of bug this module keeps producing: a figure that looks
    # authoritative while its basis is silently different.
    #
    # Decidable in two of three cases, and the third is reported rather than
    # guessed: never-confirmed entries are not in QBO and are applied; entries
    # confirmed posted before the snapshot was captured are in it and are not;
    # entries confirmed AFTER the capture are in QuickBooks but possibly not in
    # this read, so the baseline is stale and the UI says so.
    captured = baseline.get("captured_at") if baseline else None
    apply_to_baseline, already_in, stale = [], 0, 0
    for r in booked:
        d = baseline_disposition(
            posted_confirmed_at=r.posted_confirmed_at, captured_at=captured,
        )
        if d == "apply":
            apply_to_baseline.append(r)
        elif d == "already_in":
            already_in += 1
        else:
            stale += 1

    applied = combine_effects([_eff(r) for r in apply_to_baseline])
    # `cash` is a component of assets, not a statement line of its own.
    STATEMENT_LINES = tuple(k for k in EFFECT_LINES if k != "cash")

    adjusted = None
    if baseline is not None:
        adjusted = {
            # A None baseline line (month basis with no prior snapshot) has no
            # adjusted value either — adding to an unknown gives an unknown,
            # and rendering the delta alone as though it were the figure would
            # be the same lie in a different place.
            k: (None if baseline.get(k) is None
                else str(Decimal(str(baseline[k])) + Decimal(applied[k])))
            for k in STATEMENT_LINES
        }

    # Which entries move each line — the click target in the rail.
    contributors: dict[str, list[str]] = {
        line: [
            str(r.id) for r in apply_to_baseline
            if Decimal(_eff(r)[line]) != Decimal("0")
        ]
        for line in STATEMENT_LINES
    }

    return {
        "period_end": pe.isoformat(),
        "baseline": (
            {**{k: (None if v is None else str(v))
                for k, v in baseline.items()
                if k not in ("captured_at", "pl_basis", "prior_period_end")},
             "captured_at": captured.isoformat() if captured else None,
             # "month" | "ytd" | "unavailable". The snapshot's P&L rows are
             # year to date; month differences them against the prior month,
             # and says "unavailable" rather than serving a YTD figure under a
             # monthly heading when that prior month isn't synced.
             "pl_basis": baseline["pl_basis"],
             "prior_period_end": baseline.get("prior_period_end")}
            if baseline else None
        ),
        "adjusted": adjusted,
        "applied": {"count": len(apply_to_baseline), **applied},
        "already_in_baseline": already_in,
        "baseline_stale_count": stale,
        "contributors": contributors,
        "booked": {"count": len(booked), **_roll(booked)},
        "passed": {
            "count": len(passed),
            **_roll(passed),
            # A passed item with no recorded reason is the gap this schedule
            # exists to close; surfacing the count keeps it visible.
            "without_reason": sum(1 for r in passed if not (r.dismiss_reason or "").strip()),
        },
        "open_count": sum(1 for r in rows if r.status == "open"),
    }


@router.get("/{entry_id}/trace")
async def entry_trace(
    entry_id: str,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Everything behind one adjusting entry, in five answers.

      origin    what produced this, and from what
      basis     the lines it is made of, against real accounts
      decisions who did what, when, and why
      support   what justifies it
      effect    what changed because of it

    The same five questions every close object should answer. This is a READ of
    facts already stored — the audit log, the row's own stamps, the graph, the
    chart of accounts — assembled in one place rather than a second copy of
    them, so it cannot drift from what it describes.
    """
    entry = await _load(db, entry_id)
    accounts = await period_accounts(db, tenant_id, entry.period_end)
    by_qbo = {a["qbo_account_id"]: a for a in accounts if a.get("qbo_account_id")}
    type_by_account = {k: (v.get("account_type") or "") for k, v in by_qbo.items()}

    # ── decisions ────────────────────────────────────────────────────────
    events = (await db.execute(
        select(AuditLog)
        .where(AuditLog.entity_type == "proposed_entry", AuditLog.entity_id == entry.id)
        .order_by(AuditLog.created_at.asc())
    )).scalars().all()
    names = await _display_names(
        db,
        {e.user_id for e in events if e.user_id}
        | {x for x in (entry.prepared_by, entry.approved_by, entry.created_by) if x},
    )
    decisions = [
        {
            "at": e.created_at.isoformat() if e.created_at else None,
            "action": e.action,
            "label": _DECISION_LABEL.get(e.action, e.action.split(".")[-1].replace("_", " ").capitalize()),
            "by": names.get(str(e.user_id)) if e.user_id else "Nordavix",
            "reason": (e.event_data or {}).get("reason"),
        }
        for e in events
    ]

    # ── support ──────────────────────────────────────────────────────────
    # The offset convention this entry's account pairing would draw on. Looked
    # up the same way the producers do, so what the trace shows is what the
    # product would actually apply.
    memory_fact = None
    try:
        fact = await memory.active_offset_fact(
            db, source=entry.source, source_ref=entry.source_ref,
        )
        if fact is not None:
            memory_fact = {"id": str(fact.id), "title": fact.title, "kind": fact.kind}
    except Exception:
        logger.debug("memory lookup failed for entry %s", entry.id, exc_info=True)

    # ── effect ───────────────────────────────────────────────────────────
    edges: list[dict] = []
    try:
        from core.db.base import tenant_scope
        from core.graph import Node, neighbors

        with tenant_scope(entry.tenant_id):
            for n in await neighbors(db, Node("journal_entry", str(entry.id))):
                edges.append({"relation": n.relation, "type": n.node.type, "id": n.node.id})
    except Exception:
        logger.debug("graph read failed for entry %s", entry.id, exc_info=True)

    return {
        "id": str(entry.id),
        "origin": {
            "source": entry.source,
            "drafted_by": names.get(str(entry.created_by)) if entry.created_by else "Nordavix",
            "created_at": entry.created_at.isoformat() if entry.created_at else None,
            "confidence": entry.confidence,
            "rationale": entry.rationale,
            "subject": await _subject_label(db, entry, accounts),
        },
        "basis": {
            "period_end": entry.period_end.isoformat(),
            "lines": [
                {
                    **ln,
                    "account_type": type_by_account.get(str(ln.get("account_qbo_id")))
                    if ln.get("account_qbo_id") else None,
                    "known_account": str(ln.get("account_qbo_id")) in by_qbo
                    if ln.get("account_qbo_id") else False,
                }
                for ln in (entry.lines or [])
            ],
        },
        "decisions": decisions,
        "prepared_by": names.get(str(entry.prepared_by)) if entry.prepared_by else None,
        "approved_by": names.get(str(entry.approved_by)) if entry.approved_by else None,
        "dismiss_reason": entry.dismiss_reason,
        "support": {"rationale": entry.rationale, "memory_fact": memory_fact},
        "effect": {
            **net_effect(entry.lines, type_by_account=type_by_account),
            # Only a BOOKED entry moves the statements. Showing the arithmetic
            # for a draft or a passed item as though it had landed is the
            # difference between "what this would do" and "what happened".
            "applied": entry.status in ("accepted", "posted"),
            "posted_qbo_doc": entry.posted_qbo_doc,
            "posted_confirmed_at": (
                entry.posted_confirmed_at.isoformat() if entry.posted_confirmed_at else None
            ),
            "edges": edges,
        },
    }


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
        close_only(select(ProposedEntry).where(ProposedEntry.period_end == pe))
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
    Accountant 'Import journal entries' CSV. Only entries that are saved
    (locked) AND still 'accepted' are included: open / dismissed drafts are
    excluded, and entries already 'posted' (found in QBO by the posting check)
    are dropped so they can't be re-imported and double-booked."""
    pe = _parse_period(period_end)
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    rows = (await db.execute(
        close_only(select(ProposedEntry))
        .where(
            ProposedEntry.period_end == pe,
            ProposedEntry.saved_at.isnot(None),
            ProposedEntry.status == "accepted",
        )
        .order_by(ProposedEntry.created_at.asc())
    )).scalars().all()
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=(
                "No entries to import for this period — approve and Save entries "
                "first, or they may already be posted in QuickBooks."
            ),
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


async def _reopen_flux(
    db: AsyncSession,
    tenant_id,
    qbo_account_ids: set[str],
    period_end: date,
    *,
    user_id,
) -> list[str]:
    """Reset the flux variances for the given accounts at this period back to
    'open' (pending) so they're re-analyzed against the post-adjustment GL — the
    flux mirror of _reopen_recons. Clears the per-line sign-off and the now-stale
    AI commentary, and un-signs the analysis itself (TrialBalance.approved_by) so
    the close gate re-blocks. Caller commits. Returns the account ids reopened."""
    ids = {a for a in qbo_account_ids if a}
    if not ids:
        return []
    rows = (await db.execute(
        select(Variance, Account.qbo_account_id, Account.trial_balance_id)
        .join(Account, Account.id == Variance.account_id)
        .join(TrialBalance, TrialBalance.id == Account.trial_balance_id)
        .where(
            TrialBalance.period_current == period_end,
            Account.qbo_account_id.in_(ids),
        )
    )).all()
    reopened: list[str] = []
    touched_tbs: set = set()
    for var, qbo_id, tb_id in rows:
        # Skip variances with no prepared/approved work to undo.
        if var.status == "pending" and var.approved_by is None and var.ai_commentary is None:
            continue
        var.status = "pending"
        var.approved_by = None
        var.approved_at = None
        var.ai_commentary = None
        touched_tbs.add(tb_id)
        await write_audit_event(
            db,
            tenant_id=tenant_id,
            user_id=user_id,
            action="flux.reopen_after_adjustment",
            entity_type="variance",
            entity_id=var.id,
            metadata={
                "qbo_account_id": qbo_id,
                "period_end": period_end.isoformat(),
                "trial_balance_id": str(tb_id),
            },
        )
        reopened.append(qbo_id)
    # The analysis is no longer fully signed off once an account reopened.
    if touched_tbs:
        tbs = (await db.execute(
            select(TrialBalance).where(TrialBalance.id.in_(touched_tbs))
        )).scalars().all()
        for tb in tbs:
            if tb.approved_by is not None or tb.approved_at is not None:
                tb.approved_by = None
                tb.approved_at = None
    return reopened


@router.post("/check-posted")
async def check_posted(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Read QuickBooks (read-only) and check whether each saved adjustment has
    been posted, matching by account + amount + posting type within the period.
    When every saved entry is found, reopen the reconciliations and flux
    analyses for the accounts those entries hit so they're redone against the
    new GL. This is a read-only check (it only marks entries posted when
    actually found in QBO), so any workspace member (preparer+) can run it."""
    pe = _parse_period(period_end)
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    if await _is_closed(db, tenant_id, pe):
        raise HTTPException(status_code=423, detail="Books are closed for this period.")

    saved = (await db.execute(
        close_only(select(ProposedEntry))
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
        if found:
            # Keep the proof, not just the verdict. This is an OBSERVATION —
            # we read QuickBooks and found the entry — which is a different and
            # stronger fact than a human ticking "I posted it" via mark-posted,
            # so it gets its own columns and mark-posted never fills them.
            # It used to be returned to the browser and stored nowhere, which
            # left the most defensible fact in this module living in component
            # state until the period dropdown changed.
            e.posted_qbo_doc = str(doc)[:100]
            e.posted_confirmed_at = now
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
            await sync_entry_graph(db, e)
        results.append({
            "id": str(e.id),
            "description": e.description,
            "posted": found or e.status == "posted",
            "qbo_doc": doc or e.posted_qbo_doc,
        })

    all_posted = bool(results) and all(r["posted"] for r in results)
    reopened: list[str] = []
    reopened_flux: list[str] = []
    if all_posted:
        affected = {
            str(ln.get("account_qbo_id"))
            for e in saved for ln in (e.lines or [])
            if ln.get("account_qbo_id")
        }
        reopened = await _reopen_recons(db, tenant_id, affected, pe, user_id=user.id)
        reopened_flux = await _reopen_flux(db, tenant_id, affected, pe, user_id=user.id)

    await db.commit()
    return {
        "period_end": pe.isoformat(),
        "entries": results,
        "total": len(results),
        "posted_count": sum(1 for r in results if r["posted"]),
        "all_posted": all_posted,
        "reopened_accounts": reopened,
        "reopened_flux_accounts": reopened_flux,
    }
