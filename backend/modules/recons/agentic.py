"""
Agentic preparer — AI acts as a "preparer" role on every open account
in a period.

For each account where the math works (ticking all period transactions
closes the gap between GL and opening-balance to within $1), the agent:
  • Saves the override (subledger_total = opening + sum(items))
  • Persists the full reconciling-items list
  • Marks status = "reviewed" (the v3 schema's name for "Prepared")
  • Logs the action so an auditor can see exactly what the AI did

For each account where the math DOESN'T tie out, the agent doesn't
guess or plug — it calls Claude with the account context (GL, opening,
unticked-items, prior notes) and asks for 2-3 likely reasons for the
gap. That analysis lands on the account's notes field. Status stays
"pending" so a human preparer picks it up with a head start.

Guardrails (refuse to touch):
  • status == "approved"        — already signed off
  • period is closed             — books are locked
  • subledger_total is set       — preparer already entered a manual value
  • snapshot missing for account — can't reconcile what we don't have

The agent runs as a one-shot per click (the user pressed the button
this turn — they expect a single batch of work, not background
auto-runs on future syncs).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account_review_status import AccountReviewStatus
from models.closed_period import ClosedPeriod
from models.gl_balance_snapshot import GlBalanceSnapshot
from models.qbo_connection import QboConnection
from models.user import User

logger = logging.getLogger(__name__)


# ── Cooperative cancellation ────────────────────────────────────────────────
# In-memory cancel registry. The user can hit "Stop" mid-run; the agentic
# loop checks the flag between accounts and exits early with whatever it
# has processed so far. Per-process state is fine — Agentic runs are
# scoped to a single API request on a single machine; we don't need
# cross-process coordination.

_CANCEL_FLAGS: set[tuple[str, str]] = set()


def request_cancel(tenant_id: uuid.UUID, period_end: date) -> None:
    """Signal an in-flight agentic run to stop after its current account."""
    _CANCEL_FLAGS.add((str(tenant_id), period_end.isoformat()))


def _is_cancelled(tenant_id: uuid.UUID, period_end: date) -> bool:
    return (str(tenant_id), period_end.isoformat()) in _CANCEL_FLAGS


def _clear_cancel(tenant_id: uuid.UUID, period_end: date) -> None:
    _CANCEL_FLAGS.discard((str(tenant_id), period_end.isoformat()))

# Credit-natural account types — QBO returns these with positive amounts
# even though their GL balance is negative (credit). We flip the sign on
# their transactions so the build-up math reads correctly. Mirrors the
# logic in modules/recons/pdf.py and the inline form on the dashboard.
_CREDIT_NATURAL_TYPES = {
    "Accounts Payable", "Credit Card",
    "Other Current Liability", "Long Term Liability", "Equity",
}

# Tolerance for "tied out" — accountants accept sub-dollar rounding.
_TIE_TOLERANCE = Decimal("1.00")


# ── Result shapes ──────────────────────────────────────────────────────────


@dataclass
class AccountResult:
    qbo_account_id:  str
    account_name:    str
    account_number:  str
    action:          str            # 'prepared' | 'analyzed' | 'skipped'
    reason:          str            # human-readable explanation
    items_added:     int = 0
    gap_before:      str = "0.00"
    gap_after:       str = "0.00"


@dataclass
class AgenticResult:
    period_end:     str
    prepared:       int = 0   # status flipped to "reviewed"
    analyzed:       int = 0   # notes populated, no status change
    skipped:        int = 0   # nothing changed (approved / closed / manual / no snapshot)
    failed:         int = 0   # exception during processing
    accounts:       list[AccountResult] = field(default_factory=list)
    duration_ms:    int = 0
    started_at:     str = ""


# ── Main entry point ───────────────────────────────────────────────────────


async def run_agentic_prep_for_account(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: User,
    period_end: date,
    qbo_account_id: str,
) -> AgenticResult:
    """Single-account variant of run_agentic_prep. Reuses the same engine
    by passing through an `only_qbo_id` filter — the bulk runner's loop
    skips every other account when this is set.

    Powers the per-row "Run AI" button on the recons dashboard. Same
    behavior contract (auto-pulls txns + builds structured AI commentary),
    just scoped to one row."""
    return await run_agentic_prep(
        db, tenant_id, user, period_end, only_qbo_id=qbo_account_id,
    )


async def run_agentic_prep(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: User,
    period_end: date,
    only_qbo_id: str | None = None,
) -> AgenticResult:
    """Iterate every reconcilable account for the period and apply the
    agentic preparer logic. Synchronous — caller blocks until done.
    Typical 20-account period takes ~5-15s depending on QBO latency
    and how many accounts need AI analysis.

    `only_qbo_id`: when set, restricts the run to just that account.
    Used by the per-row "Run AI" button (via run_agentic_prep_for_account).
    Skips the cancel-flag plumbing because a single-row run finishes too
    fast to bother."""
    start_dt = datetime.now(UTC)
    result = AgenticResult(period_end=period_end.isoformat(), started_at=start_dt.isoformat())

    # Stale cancel from a previous run shouldn't pre-cancel this one.
    _clear_cancel(tenant_id, period_end)

    # Period must not be closed.
    closed = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == period_end)
    )).scalar_one_or_none()
    if closed is not None:
        # Don't fail loudly — return an empty result with a single skip
        # entry explaining why. The UI will show the banner.
        result.skipped = 1
        result.accounts.append(AccountResult(
            qbo_account_id="*",
            account_name="(period locked)",
            account_number="",
            action="skipped",
            reason="The books for this period are closed. Reopen the period before running the AI preparer.",
        ))
        return result

    # QBO connection — needed to pull period transactions.
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        result.skipped = 1
        result.accounts.append(AccountResult(
            qbo_account_id="*",
            account_name="(no QuickBooks connection)",
            account_number="",
            action="skipped",
            reason="QuickBooks isn't connected — connect it and try again.",
        ))
        return result

    # All synced GL accounts for the period (only the reconcilable BS types).
    # We import the type filter from the overview module so the agent and
    # the dashboard agree on what counts as "reconcilable".
    from modules.recons.overview import ACCOUNT_TYPE_GROUPS
    snap_rows = list((await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.period_end == period_end,
        )
    )).scalars().all())
    snap_rows = [s for s in snap_rows if s.account_type in ACCOUNT_TYPE_GROUPS]
    # Per-row mode: filter the candidate set to one account. Everything
    # else falls out and the loop processes a single iteration.
    if only_qbo_id:
        snap_rows = [s for s in snap_rows if s.qbo_account_id == only_qbo_id]
        if not snap_rows:
            result.skipped = 1
            result.accounts.append(AccountResult(
                qbo_account_id=only_qbo_id,
                account_name="(account not found in snapshot)",
                account_number="",
                action="skipped",
                reason=(
                    "This account isn't in the current period's GL snapshot. "
                    "Sync the period from QuickBooks first."
                ),
            ))
            return result
    if not snap_rows:
        result.skipped = 1
        result.accounts.append(AccountResult(
            qbo_account_id="*",
            account_name="(no synced accounts)",
            account_number="",
            action="skipped",
            reason="No GL snapshot exists for this period. Click Sync first, then re-run.",
        ))
        return result

    # All current-period review-status rows in one query (covers approved
    # check + manual override check without per-account roundtrip).
    review_rows = list((await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.period_end == period_end,
        )
    )).scalars().all())
    review_by_qid: dict[str, AccountReviewStatus] = {
        r.qbo_account_id: r for r in review_rows
    }

    # Prior-period closing balances (the rolled-forward opening for each
    # account). One query, most-recent prior per account in memory.
    prior_rows = list((await db.execute(
        select(AccountReviewStatus)
        .where(
            AccountReviewStatus.period_end < period_end,
            AccountReviewStatus.subledger_total.is_not(None),
        )
        .order_by(AccountReviewStatus.qbo_account_id, AccountReviewStatus.period_end.desc())
    )).scalars().all())
    prior_by_qid: dict[str, AccountReviewStatus] = {}
    for r in prior_rows:
        # Keep only the most recent per account (the .order_by sorts the
        # right one first).
        if r.qbo_account_id not in prior_by_qid:
            prior_by_qid[r.qbo_account_id] = r

    # Process each account. We commit per-account so a failure on row 7
    # doesn't lose the work done on rows 1-6. Opening balance for each
    # account = the prior reconciled subledger ONLY (close-and-roll).
    # No GL snapshot fallback per user requirement.
    for snap in snap_rows:
        # Cooperative cancel check — fires between accounts so each
        # in-flight account gets to commit cleanly before we stop.
        if _is_cancelled(tenant_id, period_end):
            _clear_cancel(tenant_id, period_end)
            result.accounts.append(AccountResult(
                qbo_account_id="*",
                account_name="(stopped by user)",
                account_number="",
                action="skipped",
                reason=(
                    "Stopped before processing this account. Accounts "
                    "already processed above were saved; the rest are "
                    "untouched. Click Run AI to resume."
                ),
            ))
            result.skipped += 1
            break
        try:
            await _process_account(
                db=db,
                tenant_id=tenant_id,
                user=user,
                conn=conn,
                snap=snap,
                period_end=period_end,
                review=review_by_qid.get(snap.qbo_account_id),
                prior=prior_by_qid.get(snap.qbo_account_id),
                result=result,
            )
        except Exception as exc:
            logger.exception(
                "Agentic prep failed on account %s (%s)",
                snap.qbo_account_id, snap.account_name,
            )
            result.failed += 1
            result.accounts.append(AccountResult(
                qbo_account_id=snap.qbo_account_id,
                account_name=snap.account_name,
                account_number=snap.account_number or "",
                action="skipped",
                reason=f"Internal error: {type(exc).__name__}: {str(exc)[:120]}",
            ))
            # Reset session so the next account can still write
            await db.rollback()

    result.duration_ms = int((datetime.now(UTC) - start_dt).total_seconds() * 1000)
    logger.info(
        "Agentic prep complete: tenant=%s period=%s prepared=%d analyzed=%d skipped=%d failed=%d in %dms",
        tenant_id, period_end, result.prepared, result.analyzed, result.skipped, result.failed,
        result.duration_ms,
    )
    return result


async def _process_account(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: User,
    conn: QboConnection,
    snap: GlBalanceSnapshot,
    period_end: date,
    review: AccountReviewStatus | None,
    prior: AccountReviewStatus | None,
    result: AgenticResult,
) -> None:
    """Apply the agentic prep logic to one account."""
    qid = snap.qbo_account_id
    name = snap.account_name
    number = snap.account_number or ""

    # ── Guardrails — refuse to touch ────────────────────────────────────
    if review and review.status == "approved":
        result.skipped += 1
        result.accounts.append(AccountResult(
            qbo_account_id=qid, account_name=name, account_number=number,
            action="skipped",
            reason="Already approved — AI does not touch signed-off reconciliations.",
        ))
        return
    # Skip only TRULY-MANUAL seed entries — i.e., subledger_total was
    # set BUT no prior reconciled period exists to roll from. In that
    # case the value is the start of the close-and-roll chain (a
    # human-typed initial number) and AI shouldn't touch it.
    #
    # When a prior reconciled period exists, any saved subledger_total
    # on the current row came from one of:
    #   - AI's own prior run (we now want to refresh)
    #   - Auto-save on approval (auto-saved rolled-forward + items)
    #   - Manual save via the inline form (still roll-forward-derived
    #     because the form computes total = opening + items)
    # All three are fair game for re-prep — AI just recomputes and
    # overwrites with fresh data.
    if review and review.subledger_total is not None:
        has_prior_rolled = prior is not None and prior.subledger_total is not None
        if not has_prior_rolled:
            result.skipped += 1
            result.accounts.append(AccountResult(
                qbo_account_id=qid, account_name=name, account_number=number,
                action="skipped",
                reason=(
                    "Manual seed entry (no prior reconciled period to roll from) — "
                    "AI defers to human input. Reconcile a prior period first if "
                    "you want AI to roll forward and refresh this."
                ),
            ))
            return
        # Otherwise: there's a prior to roll from. The current saved
        # value can be safely overwritten — AI re-computes from the
        # same chain anyway. Fall through.

    gl_balance = Decimal(snap.balance)
    is_credit_natural = snap.account_type in _CREDIT_NATURAL_TYPES
    flip = -1 if is_credit_natural else 1

    # ── Schedule-backed account fork ───────────────────────────────────
    # Before falling through to the generic "opening + GL period activity"
    # logic, check whether this account is tied to a Nordavix Schedule
    # (Prepaid / Accrual / Fixed Asset / Lease / Loan). If yes, the
    # Schedule is the AUTHORITATIVE subledger — not the QBO GL — and we
    # must compare schedule-derived SL to GL. A non-zero variance means a
    # JE is missing or extra in QBO; we surface that gap rather than
    # auto-papering over it with GL activity.
    sched = await _schedule_backed_subledger(db, tenant_id, qid, period_end)
    if sched is not None:
        await _process_schedule_backed_account(
            db=db, tenant_id=tenant_id, user=user,
            snap=snap, period_end=period_end, review=review,
            gl_balance=gl_balance, sched=sched, result=result,
        )
        return

    # ── Compute opening balance — strict close-and-roll ────────────────
    # Opening = prior reconciled subledger ONLY. If no prior is
    # reconciled, opening = $0 and AI will likely fail to tie out
    # (which is correct — the user needs to reconcile the prior
    # period first). No QBO fallback.
    from modules.recons.overview import pick_rollforward_opening
    chosen = pick_rollforward_opening(prior)
    if chosen is None:
        opening = Decimal("0")
        opening_source = "no prior reconciled period on file (assumed $0 opening)"
    else:
        opening = chosen[1]
        opening_source = f"reconciled prior-period subledger ({chosen[0].isoformat()})"

    # ── Pull every transaction posted to this account in the period ─────
    from core.qbo_gl import pull_gl_transactions
    period_start = period_end.replace(day=1)
    try:
        gl_rows = await pull_gl_transactions(conn, db, qid, period_start, period_end)
    except Exception as e:
        logger.exception("pull_gl_transactions failed for %s", qid)
        result.failed += 1
        result.accounts.append(AccountResult(
            qbo_account_id=qid, account_name=name, account_number=number,
            action="skipped",
            reason=f"Could not pull transactions from QuickBooks: {type(e).__name__}",
        ))
        return

    # Agentic Mode is opt-in (user explicitly clicked the button), so we
    # DO auto-tick every period transaction and try to tie out the row.
    # This is the "let AI do the bookkeeping for me" action. Users who
    # want manual control just don't click Agentic Mode — the normal
    # dashboard workflow shows opening + variance and lets the user pick
    # items via the inline form. If the user later changes their mind
    # about AI's work, they can use the Reset AI button to clear it.
    items: list[dict[str, Any]] = []
    signed_period_sum = Decimal("0")
    for r in gl_rows:
        amount = r["amount"]
        signed = flip * amount
        signed_period_sum += signed
        items.append({
            "txn_id":     r.get("qbo_txn_id") or "",
            "txn_type":   r.get("txn_type") or "",
            "txn_number": r.get("txn_number") or "",
            "txn_date":   r["txn_date"].isoformat() if r.get("txn_date") else "",
            "amount":     str(amount),
            "memo":       r.get("memo") or "",
        })

    computed = opening + signed_period_sum
    gap_before = gl_balance - opening   # variance with no items applied
    gap_after = gl_balance - computed   # variance after ticking all items
    tied_out = abs(gap_after) < _TIE_TOLERANCE

    if tied_out:
        # ── Auto-tie succeeded: save items + mark reviewed + commentary ─
        # Build the commentary explaining what AI did (skipped for the
        # trivial-tie zero-items case — no value in narrating "nothing
        # happened, opening already equals GL").
        if items:
            logger.info(
                "Agentic: building commentary for %s (%s) — %d item(s)",
                qid, name, len(items),
            )
            try:
                commentary = await build_ai_commentary(
                    db=db, conn=conn,
                    qid=qid, period_end=period_end,
                    account_name=name, account_number=number, account_type=snap.account_type,
                    is_credit_natural=is_credit_natural,
                    opening=opening, gl_balance=gl_balance, computed=computed,
                    items=items, prior=prior,
                    opening_source_label=opening_source,
                )
            except Exception:
                logger.exception(
                    "Agentic: commentary BUILD FAILED for %s (%s) — preparing without commentary",
                    qid, name,
                )
                commentary = None
        else:
            commentary = None

        await _save_prepared(
            db=db, tenant_id=tenant_id, user=user,
            qid=qid, period_end=period_end, review=review,
            subledger_total=computed,
            items=items,
            source_note=(
                f"AI-prepared: opening {_money(opening)} + "
                f"{len(items)} period transaction{'' if len(items) == 1 else 's'} "
                f"(net {_money(signed_period_sum)}) = subledger {_money(computed)} = GL {_money(gl_balance)}."
            ),
            commentary=commentary,
        )
        result.prepared += 1
        result.accounts.append(AccountResult(
            qbo_account_id=qid, account_name=name, account_number=number,
            action="prepared",
            reason=(
                f"Tied out by including all {len(items)} transaction"
                f"{'' if len(items) == 1 else 's'} posted this period."
                if items else
                "Opening rolled forward equals GL — trivial tie, no items needed."
            ),
            items_added=len(items),
            gap_before=str(gap_before.quantize(Decimal('0.01'))),
            gap_after=str(gap_after.quantize(Decimal('0.01'))),
        ))
        return

    # ── Couldn't tie out: AI analyzes the residual variance ──────────────
    # Ticking all period items still doesn't match GL → the gap likely
    # lives outside the current period (back-dated entries, prior-period
    # adjustments, items not yet posted). Don't save items or subledger
    # — let user investigate. Write commentary identifying candidates
    # and explaining what to look for.
    logger.info(
        "Agentic: analyzing residual variance for %s (%s) — gap_after=%s, %d candidate(s)",
        qid, name, gap_after, len(items),
    )
    try:
        commentary = await build_variance_commentary(
            db=db, conn=conn,
            qid=qid, period_end=period_end,
            account_name=name, account_number=number, account_type=snap.account_type,
            is_credit_natural=is_credit_natural,
            opening=opening, gl_balance=gl_balance, variance=gap_before,
            candidate_items=items,
            period_activity_sum=signed_period_sum,
            prior=prior,
            opening_source_label=opening_source,
        )
    except Exception:
        logger.exception(
            "Agentic: variance commentary failed for %s (%s)",
            qid, name,
        )
        commentary = None

    await _save_analyzed_row(
        db=db, tenant_id=tenant_id,
        qid=qid, period_end=period_end, review=review,
        commentary=commentary,
        opening=opening, variance=gap_before, candidate_count=len(items),
        prior_period_end=prior.period_end if prior and prior.subledger_total is not None else None,
    )
    result.analyzed += 1
    result.accounts.append(AccountResult(
        qbo_account_id=qid, account_name=name, account_number=number,
        action="analyzed",
        reason=(
            f"Couldn't auto-tie — ticking all {len(items)} item(s) leaves "
            f"residual gap of {_money(gap_after)}. Open the row to review."
        ),
        items_added=0,
        gap_before=str(gap_before.quantize(Decimal('0.01'))),
        gap_after=str(gap_after.quantize(Decimal('0.01'))),
    ))


# ── Persistence helpers ────────────────────────────────────────────────────


async def _save_prepared(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: User,
    qid: str,
    period_end: date,
    review: AccountReviewStatus | None,
    subledger_total: Decimal,
    items: list[dict[str, Any]],
    source_note: str,
    commentary: dict[str, Any] | None = None,
) -> None:
    """Upsert the AccountReviewStatus row with the AI-prepared subledger
    and flip status to "reviewed". Mirrors the inline form's save path so
    a human-prepared row and an AI-prepared row are structurally identical
    EXCEPT the ai_commentary JSONB field — non-null only on AI prep, used
    by the dashboard to render the AI Commentary card and by the per-account
    PDF to render the same data in tabular form."""
    now = datetime.now(UTC)
    if review is None:
        review = AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qid,
            period_end=period_end,
            status="reviewed",
            subledger_total=subledger_total,
            subledger_source=source_note,
            subledger_entered_by=user.id,
            subledger_entered_at=now,
            reconciling_items=items,
            ai_commentary=commentary,
            prepared_by=user.id,
            prepared_at=now,
            reviewed_by=user.id,    # legacy field — kept in sync
            reviewed_at=now,
        )
        db.add(review)
    else:
        review.status = "reviewed"
        review.subledger_total = subledger_total
        review.subledger_source = source_note
        review.subledger_entered_by = user.id
        review.subledger_entered_at = now
        review.reconciling_items = items
        review.ai_commentary = commentary
        review.prepared_by = user.id
        review.prepared_at = now
        review.reviewed_by = user.id
        review.reviewed_at = now

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.agentic.prepared",
        entity_type="account_review_status", entity_id=review.id,
        metadata={
            "summary": (
                f"AI agentic preparer reconciled account {qid} for {period_end}: "
                f"tied subledger to GL by including {len(items)} period transaction(s)."
            ),
            "qbo_account_id": qid,
            "period_end": period_end.isoformat(),
            "items_added": len(items),
            "subledger_total": str(subledger_total),
        },
    )
    await db.commit()


async def _save_analyzed_row(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    qid: str,
    period_end: date,
    review: AccountReviewStatus | None,
    commentary: dict[str, Any] | None,
    opening: Decimal,
    variance: Decimal,
    candidate_count: int,
    prior_period_end: date | None,
) -> None:
    """Save AI's analysis for an account that has variance — but
    CRUCIALLY: don't touch subledger_total or reconciling_items.

    The whole point of this fix is that AI doesn't auto-tick items.
    The user manually picks items via the inline form. AI's job is
    to write commentary that helps the user identify likely items
    and explain the variance.

    Status stays "pending" so the user knows there's work to do.
    The ai_commentary field gets the structured analysis (rendered
    as the AI Commentary card in the expanded row + on the PDF).
    """
    if review is None:
        review = AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qid,
            period_end=period_end,
            status="pending",
            reconciling_items=[],
            ai_commentary=commentary,
        )
        db.add(review)
    else:
        # Status: don't promote. If the user has been working on this
        # row (status reviewed/approved), leave status alone — they
        # know what they're doing. Otherwise leave at pending.
        review.ai_commentary = commentary
        # DO NOT TOUCH subledger_total, reconciling_items, status, or
        # any actor stamps — this is purely analytical output, not work.

    await db.commit()


# ── AI commentary on accounts with variance (analyze, don't act) ───────────


async def build_variance_commentary(
    *,
    db: AsyncSession,
    conn: QboConnection,
    qid: str,
    period_end: date,
    account_name: str,
    account_number: str,
    account_type: str,
    is_credit_natural: bool,
    opening: Decimal,
    gl_balance: Decimal,
    variance: Decimal,
    candidate_items: list[dict[str, Any]],
    period_activity_sum: Decimal,
    prior: AccountReviewStatus | None,
    opening_source_label: str = "",
) -> dict[str, Any]:
    """
    Build structured AI commentary for an account WITH variance —
    AI's role here is to ANALYZE and SUGGEST, never to auto-tick.

    Same shape as build_ai_commentary so the dashboard + PDF render
    consistently:
      { generated_at, confidence, checks[], recommendation, narrative }

    Confidence/recommendation flavors:
      • high   / approve   — period activity sums to exactly variance →
        ticking all candidates would tie. User can review + bulk-tick.
      • medium / review    — partial match, some candidates likely apply
      • low    / investigate — period activity doesn't explain variance;
        the gap likely lives outside the current period (back-dated entries,
        prior-period adjustments, subledger truly differs from GL).
    """
    checks: list[dict[str, Any]] = []

    # Check 1: Variance vs period activity — does ticking all candidates
    # explain the gap? This is the auditable "would auto-tick have
    # worked" check.
    sum_minus_variance = (period_activity_sum - variance).quantize(Decimal("0.01"))
    if abs(sum_minus_variance) < _TIE_TOLERANCE:
        checks.append({
            "name":   "Variance vs period activity",
            "status": "pass",
            "detail": (
                f"Variance of {_money(variance)} exactly matches the net of "
                f"{len(candidate_items)} period transaction(s) ({_money(period_activity_sum)}). "
                "Ticking all of them in the inline form would tie this account out."
            ),
        })
        match_quality = "full"
    elif period_activity_sum != 0 and abs(sum_minus_variance) < abs(variance):
        checks.append({
            "name":   "Variance vs period activity",
            "status": "warn",
            "detail": (
                f"Variance is {_money(variance)} and period activity nets "
                f"{_money(period_activity_sum)} — partial match. Some of the "
                f"{len(candidate_items)} candidate transaction(s) likely apply, "
                "but additional out-of-period items may be needed too."
            ),
        })
        match_quality = "partial"
    else:
        checks.append({
            "name":   "Variance vs period activity",
            "status": "warn",
            "detail": (
                f"Variance of {_money(variance)} doesn't line up with the period's "
                f"net activity ({_money(period_activity_sum)}). The gap likely "
                "lives outside the current month — possible causes: back-dated "
                "entries, prior-period adjustments, manual JEs not yet posted, "
                "or a genuine subledger-vs-GL difference that needs investigation."
            ),
        })
        match_quality = "none"

    # Check 2: Opening provenance
    if prior is not None and prior.subledger_total is not None:
        checks.append({
            "name":   "Opening balance",
            "status": "pass",
            "detail": (
                f"Rolled forward from prior period's reconciled subledger "
                f"({prior.period_end.isoformat()})."
            ),
        })
    else:
        checks.append({
            "name":   "Opening balance",
            "status": "warn",
            "detail": (
                "No prior-period reconciled subledger on file — assumed $0 "
                "opening. Reconcile the prior period first so the chain rolls "
                "forward properly."
            ),
        })

    # Check 3: Candidate volume + composition
    if not candidate_items:
        checks.append({
            "name":   "Period activity",
            "status": "warn",
            "detail": (
                "No transactions found in QuickBooks for this account in the "
                "period. The variance likely comes from out-of-period activity "
                "or a non-QBO source (bank statement, vendor invoice, etc.)."
            ),
        })
    else:
        type_counts: dict[str, int] = {}
        je_count = 0
        for it in candidate_items:
            t = (it.get("txn_type") or "").strip()
            if t:
                type_counts[t] = type_counts.get(t, 0) + 1
            if "journal" in t.lower():
                je_count += 1
        comp = ", ".join(
            f"{c} {t.lower()}{'s' if c != 1 else ''}"
            for t, c in sorted(type_counts.items(), key=lambda x: -x[1])
        )
        if je_count > 0 and je_count >= max(2, len(candidate_items) * 0.3):
            checks.append({
                "name":   "Period activity",
                "status": "warn",
                "detail": (
                    f"{len(candidate_items)} candidate transaction(s): {comp}. "
                    f"{je_count} are manual journal entries — review those "
                    "carefully before ticking; they're often the cause of "
                    "subledger-vs-GL gaps."
                ),
            })
        else:
            checks.append({
                "name":   "Period activity",
                "status": "pass",
                "detail": f"{len(candidate_items)} candidate transaction(s): {comp}.",
            })

    # Derive confidence + recommendation from check results + match
    has_warn = any(c["status"] == "warn" for c in checks)
    if match_quality == "full" and not has_warn:
        confidence = "high"
        recommendation = "review"   # user reviews + ticks; AI never auto-prepares
    elif match_quality == "full" or match_quality == "partial":
        confidence = "medium"
        recommendation = "review"
    else:
        confidence = "low"
        recommendation = "investigate"

    # Narrative — single Claude call to summarize what the user should do.
    narrative = _generate_variance_narrative(
        account_name=account_name, account_number=account_number,
        account_type=account_type, period_end=period_end,
        opening=opening, gl_balance=gl_balance, variance=variance,
        candidate_items=candidate_items,
        period_activity_sum=period_activity_sum,
        match_quality=match_quality,
        confidence=confidence,
    )

    accounts: list[dict[str, Any]] = []
    try:
        from modules.adjustments.service import period_accounts
        accounts = await period_accounts(db, conn.tenant_id, period_end)
    except Exception:
        logger.exception("Loading chart for proposed entries failed (acct=%s)", qid)

    actions = _generate_recon_actions(
        account_name=account_name, account_number=account_number,
        account_type=account_type, period_end=period_end,
        opening=opening, gl_balance=gl_balance, target=gl_balance,
        items=candidate_items, tied_out=False, accounts=accounts, variance=variance,
    )
    await _persist_recon_proposals(
        db, tenant_id=conn.tenant_id, qid=qid, period_end=period_end,
        proposed_entries=actions.get("proposed_entries") or [],
    )
    return {
        "generated_at":   datetime.now(UTC).isoformat(),
        "headline":       actions["headline"],
        "confidence":     confidence,
        "checks":         checks,
        "recommendation": recommendation,
        "recommendations": actions["recommendations"],
        "item_flags":     actions["item_flags"],
        "narrative":      narrative,
    }


def _generate_variance_narrative(
    *,
    account_name: str,
    account_number: str,
    account_type: str,
    period_end: date,
    opening: Decimal,
    gl_balance: Decimal,
    variance: Decimal,
    candidate_items: list[dict[str, Any]],
    period_activity_sum: Decimal,
    match_quality: str,
    confidence: str,
) -> str:
    """Plain-English summary of the variance + what the user should
    do next. Single Claude call, falls back to a templated summary
    if the API fails."""
    try:
        from core.ai.client import compute_cache_key, generate_narrative

        # Compact summary of top candidates by absolute amount.
        sorted_items = sorted(
            candidate_items,
            key=lambda i: abs(Decimal(str(i.get("amount", "0") or "0"))),
            reverse=True,
        )[:5]
        items_summary = "\n".join(
            f"  - {i.get('txn_date','')} {i.get('txn_type','')} "
            f"#{i.get('txn_number','')}: "
            f"{_money(Decimal(str(i.get('amount','0') or '0')))} — "
            f"{(i.get('memo') or '')[:80]}"
            for i in sorted_items
        ) or "  (no candidate transactions in the period)"

        system_prompt = (
            "You are a senior accountant helping a preparer understand a "
            "month-end account variance. Write 2-3 sentences in plain English "
            "explaining what the variance likely represents and which "
            "transactions the preparer should review first. Do NOT recommend "
            "ticking specific items — that's the preparer's call. Be specific "
            "about which transactions look most relevant given the variance "
            "amount. No markdown, no bullets. Under 80 words."
        )
        user_prompt = (
            f"Account: {account_number + ' · ' if account_number else ''}{account_name} ({account_type})\n"
            f"Period End: {period_end.isoformat()}\n\n"
            f"Opening (rolled forward): {_money(opening)}\n"
            f"GL balance: {_money(gl_balance)}\n"
            f"Variance to reconcile: {_money(variance)}\n"
            f"Net of {len(candidate_items)} period transaction(s): {_money(period_activity_sum)}\n"
            f"Match quality between activity and variance: {match_quality}\n\n"
            f"Top candidates by magnitude:\n{items_summary}\n\n"
            f"Summarize for the preparer."
        )
        key = compute_cache_key(
            account_number or account_name,
            str(gl_balance), str(opening),
            f"agentic-variance-{period_end.isoformat()}",
        )
        resp = generate_narrative(system_prompt, user_prompt, key, max_tokens=220)
        return resp.content.strip()
    except Exception:
        logger.exception("Variance narrative AI call failed — falling back to template")
        return (
            f"Variance of {_money(variance)} between rolled-forward opening "
            f"{_money(opening)} and GL {_money(gl_balance)}. "
            f"{len(candidate_items)} candidate transaction(s) totaling "
            f"{_money(period_activity_sum)} were found in the period. "
            "Open the row to review and tick the items that apply."
        )


# ── AI commentary on tied-out reconciliations (legacy — only called by the
# trivial-tie path now, since we no longer auto-tick items) ────────────────


async def build_ai_commentary(
    *,
    db: AsyncSession,
    conn: QboConnection,
    qid: str,
    period_end: date,
    account_name: str,
    account_number: str,
    account_type: str,
    is_credit_natural: bool,
    opening: Decimal,
    gl_balance: Decimal,
    computed: Decimal,
    items: list[dict[str, Any]],
    prior: AccountReviewStatus | None,
    opening_source_label: str = "",
) -> dict[str, Any]:
    """
    Build the structured AI commentary for a successfully-tied
    reconciliation. Mix of deterministic heuristic checks (pure
    Python, auditable, no AI cost) and one optional Claude call for
    the plain-English narrative.

    Shape:
      {
        "generated_at": "2026-05-26T01:30:00+00:00",
        "confidence":   "high" | "medium" | "low",
        "checks": [
          {"name": "...", "status": "pass" | "warn" | "fail", "detail": "..."},
          ...
        ],
        "recommendation": "approve" | "review" | "investigate",
        "narrative":   "free text — AI summary"
      }

    The dashboard renders this directly as a tabular card; the per-account
    PDF renders the same data as a section. Stays embedded with the row
    forever (don't auto-clear on human edit) — it's a historical snapshot
    of what AI did at the time of preparation.
    """
    checks: list[dict[str, Any]] = []

    # Check 1: Math tie-out — by construction this always passes when we
    # reach this code path, but record it explicitly so the reviewer sees
    # the math.
    checks.append({
        "name":   "Tie-out math",
        "status": "pass",
        "detail": (
            f"Opening {_money(opening)} + {len(items)} period "
            f"transaction{'' if len(items) == 1 else 's'} totaling "
            f"{_money(computed - opening)} = subledger {_money(computed)} = GL "
            f"{_money(gl_balance)}."
        ),
    })

    # Check 2: Opening provenance — strict close-and-roll. Two flavors:
    #   • Pass : rolled forward from a reconciled prior subledger
    #   • Warn : no prior reconciliation on file — opening assumed $0
    #            (the user needs to reconcile the prior period first
    #            for the chain to be meaningful)
    if prior is not None and prior.subledger_total is not None:
        checks.append({
            "name":   "Opening balance",
            "status": "pass",
            "detail": (
                f"Rolled forward from prior period's reconciled subledger "
                f"({prior.period_end.isoformat()})."
            ),
        })
    else:
        checks.append({
            "name":   "Opening balance",
            "status": "warn",
            "detail": (
                "No prior-period reconciled subledger on file — assumed $0 as "
                "opening. Reconcile the prior period first so this period can "
                "roll forward properly."
            ),
        })

    # Check 3: Data provenance — every reconciling item came directly
    # from QBO at sync time. Worth surfacing for audit reassurance.
    checks.append({
        "name":   "Data provenance",
        "status": "pass",
        "detail": (
            "All reconciling items pulled directly from QuickBooks via the "
            "GeneralLedger report at the time of sync."
        ),
    })

    # Check 4: Item composition — break down what kinds of transactions
    # were ticked. Warn if a large fraction are manual JEs (those usually
    # warrant human eyes).
    type_counts: dict[str, int] = {}
    je_count = 0
    for it in items:
        t = (it.get("txn_type") or "").strip()
        if t:
            type_counts[t] = type_counts.get(t, 0) + 1
        if "journal" in t.lower() or t.lower() == "je":
            je_count += 1
    composition = ", ".join(
        f"{c} {t.lower()}{'s' if c != 1 else ''}"
        for t, c in sorted(type_counts.items(), key=lambda x: -x[1])
    ) or "no transactions"
    if je_count > 0 and je_count >= max(2, len(items) * 0.3):
        # >=30% manual JEs (and at least 2) → warn
        checks.append({
            "name":   "Item composition",
            "status": "warn",
            "detail": (
                f"{composition}. "
                f"{je_count} manual journal {'entries' if je_count != 1 else 'entry'} — "
                "review for adjusting entries before approving."
            ),
        })
    else:
        checks.append({
            "name":   "Item composition",
            "status": "pass",
            "detail": composition + ".",
        })

    # Check 5: Date distribution — flag if all items cluster at month-end
    # (often a sign of bulk-entered catch-up activity) or if none of the
    # items fall in the current month at all.
    dates_in_period = []
    for it in items:
        ds = it.get("txn_date") or ""
        if not ds:
            continue
        try:
            d = date.fromisoformat(ds[:10])
            if d.replace(day=1) == period_end.replace(day=1):
                dates_in_period.append(d)
        except Exception:
            continue
    if items and dates_in_period:
        last_week = sum(1 for d in dates_in_period if (period_end - d).days <= 7)
        if last_week == len(dates_in_period) and len(dates_in_period) >= 3:
            checks.append({
                "name":   "Date distribution",
                "status": "warn",
                "detail": (
                    f"All {len(dates_in_period)} items fall in the last 7 days of the period — "
                    "could indicate late or bulk-entered activity. Verify cut-off."
                ),
            })
        else:
            spread_days = (max(dates_in_period) - min(dates_in_period)).days if len(dates_in_period) > 1 else 0
            checks.append({
                "name":   "Date distribution",
                "status": "pass",
                "detail": (
                    f"Activity spread across {spread_days + 1} day"
                    f"{'' if spread_days == 0 else 's'} of the period."
                ),
            })

    # Check 6: Secondary source — pull the account's current QBO balance
    # as an independent cross-check. For a month whose period_end is in
    # the past, this confirms that period activity was finalized; if the
    # numbers don't reconcile we flag (someone may have back-dated entries).
    try:
        secondary = await _secondary_qbo_check(
            conn=conn, db=db, qid=qid,
            account_name=account_name, account_number=account_number,
            period_end=period_end, gl_balance=gl_balance,
        )
        if secondary is not None:
            checks.append(secondary)
    except Exception:
        logger.exception("Secondary QBO check failed for %s — skipping", qid)
        # Don't fail the whole commentary because the secondary check failed.

    # Derive confidence + recommendation from the check results.
    has_warn = any(c["status"] == "warn" for c in checks)
    has_fail = any(c["status"] == "fail" for c in checks)
    if has_fail:
        confidence = "low"
        recommendation = "investigate"
    elif has_warn:
        confidence = "medium"
        recommendation = "review"
    else:
        confidence = "high"
        recommendation = "approve"

    # Narrative — single Claude call. Falls back to a templated summary if
    # the call fails so we never block the commentary on AI availability.
    narrative = _generate_narrative(
        account_name=account_name, account_number=account_number,
        account_type=account_type, period_end=period_end,
        opening=opening, gl_balance=gl_balance, computed=computed,
        items=items, checks=checks, confidence=confidence,
    )

    accounts: list[dict[str, Any]] = []
    try:
        from modules.adjustments.service import period_accounts
        accounts = await period_accounts(db, conn.tenant_id, period_end)
    except Exception:
        logger.exception("Loading chart for proposed entries failed (acct=%s)", qid)

    actions = _generate_recon_actions(
        account_name=account_name, account_number=account_number,
        account_type=account_type, period_end=period_end,
        opening=opening, gl_balance=gl_balance, target=computed,
        items=items, tied_out=True, accounts=accounts,
    )
    await _persist_recon_proposals(
        db, tenant_id=conn.tenant_id, qid=qid, period_end=period_end,
        proposed_entries=actions.get("proposed_entries") or [],
    )
    return {
        "generated_at":   datetime.now(UTC).isoformat(),
        "headline":       actions["headline"],
        "confidence":     confidence,
        "checks":         checks,
        "recommendation": recommendation,
        "recommendations": actions["recommendations"],
        "item_flags":     actions["item_flags"],
        "narrative":      narrative,
    }


def _generate_recon_actions(
    *,
    account_name: str,
    account_number: str,
    account_type: str,
    period_end: date,
    opening: Decimal,
    gl_balance: Decimal,
    target: Decimal,
    items: list[dict[str, Any]],
    tied_out: bool,
    accounts: list[dict[str, Any]] | None = None,
    variance: Decimal | None = None,
) -> dict[str, Any]:
    """The ACTIONABLE layer of recon commentary. One Claude call, grounded
    in the actual reconciling items, that thinks like a reviewing
    accountant and returns:
      - headline:        one-line verdict
      - recommendations: concrete next actions (1-4, may be empty if clean)
      - item_flags:      reconciling items that look UNRELATED, out of
                         period, or otherwise doubtful — each with the
                         reason and what to do about it
      - proposed_entries: balanced adjusting JEs the user can review + copy
                         into QBO (e.g. reclass a flagged item, book a
                         correcting entry for an unexplained variance). Only
                         when there's a clear, correct entry; [] otherwise.
                         Accounts come from `accounts` (the period chart) so
                         the lines reference real GL accounts.

    This is the "if a transaction in the ledger seems not related or there
    is any doubt, tell me what to do" layer. Falls back to empty lists on
    any failure so it never blocks the rest of the commentary."""
    import json as _json

    empty = {"headline": "", "recommendations": [], "item_flags": [], "proposed_entries": []}
    try:
        from core.ai.client import compute_cache_key, generate_narrative

        sorted_items = sorted(
            items, key=lambda i: abs(Decimal(str(i.get("amount", "0") or "0"))), reverse=True,
        )[:25]
        items_block = "\n".join(
            f"  - {i.get('txn_date', '')} {i.get('txn_type', '')} "
            f"#{i.get('txn_number', '')}: "
            f"{_money(Decimal(str(i.get('amount', '0') or '0')))} — "
            f"{(i.get('memo') or '(no memo)')[:90]}"
            for i in sorted_items
        ) or "  (no reconciling items selected)"

        # Chart of accounts for this period — so proposed JE lines reference
        # real GL accounts (number + name). Capped to keep the prompt small.
        acct_list = accounts or []
        chart_block = "\n".join(
            f"  - {a.get('account_number') or '—'} {a.get('account_name', '')} ({a.get('account_type', '')})"
            for a in acct_list[:80]
        ) or "  (chart unavailable)"

        system_prompt = (
            "You are a senior reconciliation reviewer at a CPA firm signing off on a "
            "balance-sheet reconciliation. You are given the account, its opening "
            "balance, its GL balance, and the GL transactions selected as reconciling "
            "items. Review them like a careful accountant.\n\n"
            "Return ONE JSON object and nothing else:\n"
            "{\n"
            '  "headline": "one-sentence verdict, <= 140 chars",\n'
            '  "recommendations": ["specific next action", ...],   // 1-4, [] if clean\n'
            '  "item_flags": [\n'
            '     {"label":"txn description","amount":"123.45","reason":"why it is '
            'questionable","action":"what the preparer should do","severity":"low|medium|high"}\n'
            "  ],\n"
            '  "proposed_entries": [\n'
            '     {"description":"what this entry fixes","confidence":"high|medium|low",\n'
            '      "memo":"reference for the JE","rationale":"one sentence why",\n'
            '      "lines":[{"account_number":"1234","account_name":"Account","debit":"100.00","credit":"0.00"},\n'
            '               {"account_number":"5678","account_name":"Account","debit":"0.00","credit":"100.00"}]}\n'
            "  ]\n"
            "}\n\n"
            "Flag a reconciling item ONLY when a reviewer would genuinely question it:\n"
            "- it does not belong in this account type (e.g. a payroll run sitting in "
            "Prepaid Insurance, an expense in a cash account)\n"
            "- it is back-dated or falls outside the period being reconciled\n"
            "- it is a large manual journal entry with a blank or vague memo\n"
            "- a single item concentrates an unusual share of the balance\n"
            "- the memo / entity is unrelated to what this account should hold\n"
            "Do NOT flag ordinary, well-described activity. If everything looks clean, "
            "return an empty item_flags array and recommend approval.\n\n"
            "Propose an adjusting entry (proposed_entries) ONLY when there is a clear, "
            "correct journal entry to post — e.g. reclassifying a flagged misclassified "
            "item to the right account, or booking a correcting entry for an unexplained "
            "variance. Each entry MUST balance (total debits == total credits) and use "
            "accounts FROM THE PROVIDED CHART (copy the account_number + name exactly). "
            "Do not propose an entry for an account that already ties out cleanly. Return "
            "an empty proposed_entries array when no adjustment is warranted. Never invent "
            "an account that isn't in the chart.\n"
            "Rules: JSON only, no markdown. Never invent amounts. 'amount' is a positive "
            "decimal string. Keep reasons and actions concrete and short."
        )
        variance_line = (
            f"Unexplained variance (GL − subledger): {_money(variance)}\n"
            if variance is not None and abs(variance) >= _TIE_TOLERANCE
            else ""
        )
        user_prompt = (
            f"Account: {account_number + ' · ' if account_number else ''}{account_name} ({account_type})\n"
            f"Period end: {period_end.isoformat()}\n"
            f"Opening balance: {_money(opening)}\n"
            f"GL balance: {_money(gl_balance)}\n"
            f"Subledger built from opening + items: {_money(target)}\n"
            f"Ties out to GL: {'yes' if tied_out else 'no'}\n"
            f"{variance_line}\n"
            f"Reconciling items ({len(items)} total; top {len(sorted_items)} by |amount|):\n"
            f"{items_block}\n\n"
            f"Chart of accounts (use these for any proposed_entries lines):\n"
            f"{chart_block}\n\n"
            "Review and return the JSON."
        )
        key = compute_cache_key(
            account_number or account_name, str(gl_balance), str(target),
            # v2 = output now includes proposed_entries; bump so we don't serve
            # a pre-feature cached response that lacks them.
            f"recon-actions-v2-{period_end.isoformat()}-{len(items)}",
        )
        resp = generate_narrative(system_prompt, user_prompt, key, max_tokens=1100)
        raw = resp.content.strip()
        first, last = raw.find("{"), raw.rfind("}")
        if first == -1 or last == -1:
            return empty
        parsed = _json.loads(raw[first:last + 1])

        recs = [
            str(r).strip().lstrip("-•* ").strip()
            for r in (parsed.get("recommendations") or [])
            if str(r).strip()
        ][:4]

        flags: list[dict[str, Any]] = []
        for f in (parsed.get("item_flags") or [])[:8]:
            if not isinstance(f, dict):
                continue
            label = str(f.get("label") or "").strip()
            reason = str(f.get("reason") or "").strip()
            if not label or not reason:
                continue
            amt = f.get("amount")
            try:
                amt_str = str(abs(Decimal(str(amt)).quantize(Decimal("0.01")))) if amt not in (None, "") else ""
            except Exception:
                amt_str = ""
            sev = str(f.get("severity") or "medium").lower().strip()
            if sev not in ("low", "medium", "high"):
                sev = "medium"
            flags.append({
                "label":    label[:160],
                "amount":   amt_str,
                "reason":   reason[:240],
                "action":   str(f.get("action") or "").strip()[:240],
                "severity": sev,
            })

        # Proposed adjusting entries — balanced JEs the user can review + copy
        # into QBO. Validate each maps to real chart accounts and balances.
        from modules.adjustments.service import lines_balanced, normalize_lines

        by_number: dict[str, dict] = {}
        by_name: dict[str, dict] = {}
        for a in acct_list:
            if a.get("account_number"):
                by_number[str(a["account_number"]).strip()] = a
            if a.get("account_name"):
                by_name[str(a["account_name"]).strip().lower()] = a

        proposed: list[dict[str, Any]] = []
        for pe in (parsed.get("proposed_entries") or [])[:5]:
            if not isinstance(pe, dict):
                continue
            lines = normalize_lines(pe.get("lines"))
            for ln in lines:
                match = None
                if ln.get("account_number") and ln["account_number"] in by_number:
                    match = by_number[ln["account_number"]]
                elif ln.get("account_name", "").lower() in by_name:
                    match = by_name[ln["account_name"].lower()]
                if match is not None:
                    ln["account_qbo_id"] = match.get("qbo_account_id")
                    ln["account_number"] = match.get("account_number") or ln.get("account_number")
                    ln["account_name"] = match.get("account_name") or ln["account_name"]
            if not lines_balanced(lines):
                continue
            conf = str(pe.get("confidence") or "").lower().strip()
            proposed.append({
                "description": str(pe.get("description") or "").strip()[:500] or "Proposed adjusting entry",
                "memo":        (str(pe.get("memo")).strip()[:500] if pe.get("memo") else None),
                "rationale":   (str(pe.get("rationale") or pe.get("reason") or "").strip() or None),
                "confidence":  conf if conf in ("high", "medium", "low") else "medium",
                "lines":       lines,
            })

        return {
            "headline":         str(parsed.get("headline") or "").strip()[:200],
            "recommendations":  recs,
            "item_flags":       flags,
            "proposed_entries": proposed,
        }
    except Exception:
        logger.exception("recon actions AI call failed — returning empty actions")
        return empty


async def _persist_recon_proposals(
    db: AsyncSession,
    *,
    tenant_id,
    qid: str,
    period_end: date,
    proposed_entries: list[dict[str, Any]],
) -> None:
    """Persist AI-proposed recon adjusting entries (best-effort, idempotent).

    Replaces only the OPEN recon proposals for this account+period so a
    re-run refreshes drafts without touching the user's accept/dismiss
    decisions. Added to the caller's session; committed with the recon save."""
    try:
        from modules.adjustments.service import replace_open_proposals
        await replace_open_proposals(
            db,
            tenant_id=tenant_id,
            source="recon",
            source_ref=qid,
            period_end=period_end,
            entries=proposed_entries or [],
        )
    except Exception:
        logger.exception("Recon proposed-entry persistence failed for acct=%s", qid)


async def _secondary_qbo_check(
    *,
    conn: QboConnection,
    db: AsyncSession,
    qid: str,
    account_name: str,
    account_number: str,
    period_end: date,
    gl_balance: Decimal,
) -> dict[str, Any] | None:
    """Independent verification: pull a fresh look at this account's
    balance directly from QBO's TrialBalance at period_end and compare
    against the snapshot we used for the reconciliation. If they match,
    the snapshot was a true representation of QBO at sync time and
    nothing has changed since; if they differ, someone back-dated
    entries after the sync."""
    try:
        from core.qbo_tb import fetch_trial_balance, lookup_balance, parse_trial_balance
        report = await fetch_trial_balance(conn, period_end)
        parsed = parse_trial_balance(report)
        live = lookup_balance(parsed, qbo_id=qid, acct_num=account_number, name=account_name)
    except Exception:
        return None

    if live is None:
        return {
            "name":   "Secondary source verification",
            "status": "warn",
            "detail": (
                "Account not found in a freshly-pulled QBO TrialBalance at period_end — "
                "it may have been renamed, deleted, or marked inactive since the sync."
            ),
        }

    delta = (live - gl_balance).quantize(Decimal("0.01"))
    if abs(delta) < Decimal("1.00"):
        return {
            "name":   "Secondary source verification",
            "status": "pass",
            "detail": (
                f"Re-pulled live from QuickBooks TrialBalance at period_end and matched: "
                f"{_money(live)}. No back-dated entries since the original sync."
            ),
        }
    return {
        "name":   "Secondary source verification",
        "status": "warn",
        "detail": (
            f"Live QuickBooks TrialBalance at period_end now shows {_money(live)} "
            f"vs the snapshot's {_money(gl_balance)} (delta {_money(delta)}). "
            "Someone may have posted, edited, or back-dated entries after the original sync. "
            "Re-Sync the period and re-run AI to refresh."
        ),
    }


def _generate_narrative(
    *,
    account_name: str,
    account_number: str,
    account_type: str,
    period_end: date,
    opening: Decimal,
    gl_balance: Decimal,
    computed: Decimal,
    items: list[dict[str, Any]],
    checks: list[dict[str, Any]],
    confidence: str,
) -> str:
    """Single Claude call to write a 2-3 sentence plain-English summary
    of what AI reconciled and what (if anything) a reviewer should
    double-check. Falls back to a templated summary if the call fails."""
    try:
        from core.ai.client import compute_cache_key, generate_narrative

        warn_lines = [c["detail"] for c in checks if c["status"] != "pass"]
        warn_section = (
            "Warnings raised during checks:\n" + "\n".join(f"  - {w}" for w in warn_lines) + "\n\n"
            if warn_lines else
            "All deterministic checks passed.\n\n"
        )
        system_prompt = (
            "You are a senior accountant summarizing an AI-prepared account reconciliation "
            "for a reviewer who will decide whether to approve it. Write 2-3 sentences in "
            "plain English. No markdown, no bullets, no headings. Be concrete and specific "
            "about what was reconciled. If any check raised a warning, the second sentence "
            "must explicitly name what the reviewer should verify. Keep it under 70 words."
        )
        user_prompt = (
            f"Account: {account_number + ' · ' if account_number else ''}{account_name} ({account_type})\n"
            f"Period End: {period_end.isoformat()}\n"
            f"Reconciled: opening {_money(opening)} + {len(items)} period transaction(s) = "
            f"closing subledger {_money(computed)} = GL {_money(gl_balance)}.\n"
            f"Confidence: {confidence}.\n\n"
            f"{warn_section}"
            f"Write the summary now."
        )
        key = compute_cache_key(
            account_number or account_name,
            str(gl_balance), str(computed),
            f"agentic-narrative-{period_end.isoformat()}",
        )
        resp = generate_narrative(system_prompt, user_prompt, key, max_tokens=200)
        return resp.content.strip()
    except Exception:
        logger.exception("Narrative AI call failed — falling back to template")
        return (
            f"AI-prepared this {account_type.lower()} account by including all {len(items)} "
            f"transaction{'' if len(items) == 1 else 's'} posted during the period, which "
            f"ties subledger {_money(computed)} to GL {_money(gl_balance)} exactly. "
            f"Confidence: {confidence}."
        )


# ── Schedule-backed subledger (Prepaid / Accrual / FA / Lease / Loan) ──────
#
# For these five account types the Nordavix Schedule is the authoritative
# subledger. The recon logic must compute SL from the schedule (independent
# of QBO GL activity) and compare to the GL balance. A non-zero variance
# means there's a JE that should be posted to (or removed from) QuickBooks
# — Agentic Mode surfaces that gap rather than auto-papering over it.
#
# Sign convention: `sl_signed` is returned in DEBIT-POSITIVE so it can be
# compared directly to `GlBalanceSnapshot.balance` (which stores debit-
# positive too). Asset accounts → positive; liabilities + contra-assets →
# negative.


async def _schedule_backed_subledger(
    db: AsyncSession,
    tenant_id: uuid.UUID,  # noqa: ARG001 — tenant filter applied via session event listener
    qbo_account_id: str,
    period_end: date,
) -> dict | None:
    """If `qbo_account_id` is tied to a Nordavix Schedule, return the
    schedule-derived subledger info. Otherwise return None and the caller
    falls back to the GL-based logic.

    Returns:
      {
        "schedule_type":  "prepaid" | "accrual" | "fixed_asset_cost" |
                          "fixed_asset_accdep" | "lease_liability" |
                          "lease_rou" | "loan",
        "sl_signed":      Decimal in debit-positive convention,
        "item_count":     int — # active items hitting this account,
        "je_items":       list[dict] — period JEs expected per the
                                       schedule, in reconciling_items
                                       shape (txn_id, txn_type, txn_number,
                                       txn_date, amount, memo).
      }
    """
    from models.schedule import (
        ScheduleAccrual,
        ScheduleFixedAsset,
        ScheduleLease,
        ScheduleLoan,
        SchedulePrepaid,
    )
    from modules.schedules.calc import (
        ZERO,
        _accrual_balance_as_of,
        _fa_accumulated_dep_as_of,
        _lease_liability_as_of,
        _loan_principal_as_of,
        _months_between,
        _prepaid_period_expense,
        _prepaid_unamortized_as_of,
        _q,
        fa_period_depreciation,
        lease_principal_paid_in_period,
        loan_principal_paid_in_period,
    )

    p_start = period_end.replace(day=1)

    # ── Prepaid (debit-natural asset) ────────────────────────────────
    prepaids = list((await db.execute(
        select(SchedulePrepaid).where(
            SchedulePrepaid.qbo_account_id == qbo_account_id,
            SchedulePrepaid.is_active.is_(True),
        )
    )).scalars().all())
    if prepaids:
        sl = ZERO
        je: list[dict] = []
        for it in prepaids:
            sl += _prepaid_unamortized_as_of(it, period_end)
            if p_start <= it.invoice_date <= period_end:
                je.append({
                    "txn_id":     f"prepaid-init-{it.id}",
                    "txn_type":   "Schedule (Initial)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.invoice_date.isoformat(),
                    "amount":     str(_q(Decimal(it.total_amount))),
                    "memo":       f"{it.description} — initial prepayment per Nordavix Schedule",
                })
            amort = _prepaid_period_expense(it, p_start, period_end)
            if amort > ZERO:
                je.append({
                    "txn_id":     f"prepaid-amort-{it.id}-{period_end.isoformat()}",
                    "txn_type":   "Schedule (Amortization)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   period_end.isoformat(),
                    "amount":     str(_q(-amort)),
                    "memo":       f"{it.description} — period amortization per Nordavix Schedule",
                })
        return {"schedule_type": "prepaid", "sl_signed": _q(sl), "item_count": len(prepaids), "je_items": je}

    # ── Accrual (credit-natural liability) ───────────────────────────
    accruals = list((await db.execute(
        select(ScheduleAccrual).where(
            ScheduleAccrual.qbo_account_id == qbo_account_id,
            ScheduleAccrual.is_active.is_(True),
        )
    )).scalars().all())
    if accruals:
        sl_pos = ZERO
        je = []
        for it in accruals:
            sl_pos += _accrual_balance_as_of(it, period_end)
            if p_start <= it.accrual_date <= period_end:
                je.append({
                    "txn_id":     f"accrual-book-{it.id}",
                    "txn_type":   "Schedule (Accrual)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.accrual_date.isoformat(),
                    "amount":     str(_q(-Decimal(it.amount))),
                    "memo":       f"{it.description} — accrual booked per Nordavix Schedule",
                })
            if it.reverses_on is not None and p_start <= it.reverses_on <= period_end:
                je.append({
                    "txn_id":     f"accrual-rev-{it.id}",
                    "txn_type":   "Schedule (Reversal)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.reverses_on.isoformat(),
                    "amount":     str(_q(Decimal(it.amount))),
                    "memo":       f"{it.description} — accrual reversed per Nordavix Schedule",
                })
        return {"schedule_type": "accrual", "sl_signed": _q(-sl_pos), "item_count": len(accruals), "je_items": je}

    # ── Fixed Asset COST account (debit-natural asset) ───────────────
    fas_cost = list((await db.execute(
        select(ScheduleFixedAsset).where(
            ScheduleFixedAsset.qbo_account_id == qbo_account_id,
            ScheduleFixedAsset.is_active.is_(True),
        )
    )).scalars().all())
    if fas_cost:
        sl = ZERO
        je = []
        for it in fas_cost:
            in_svc = it.in_service_date <= period_end
            disposed = it.disposed_on is not None and it.disposed_on <= period_end
            if in_svc and not disposed:
                sl += Decimal(it.cost)
            if p_start <= it.in_service_date <= period_end:
                je.append({
                    "txn_id":     f"fa-add-{it.id}",
                    "txn_type":   "Schedule (FA Addition)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.in_service_date.isoformat(),
                    "amount":     str(_q(Decimal(it.cost))),
                    "memo":       f"{it.description} — placed in service per Nordavix Schedule",
                })
            if it.disposed_on is not None and p_start <= it.disposed_on <= period_end:
                je.append({
                    "txn_id":     f"fa-disp-{it.id}",
                    "txn_type":   "Schedule (FA Disposal)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.disposed_on.isoformat(),
                    "amount":     str(_q(-Decimal(it.cost))),
                    "memo":       f"{it.description} — disposed per Nordavix Schedule",
                })
        return {"schedule_type": "fixed_asset_cost", "sl_signed": _q(sl), "item_count": len(fas_cost), "je_items": je}

    # ── Fixed Asset ACCUMULATED DEP contra-asset (credit-natural) ────
    fas_dep = list((await db.execute(
        select(ScheduleFixedAsset).where(
            ScheduleFixedAsset.accumulated_dep_qbo_account_id == qbo_account_id,
            ScheduleFixedAsset.is_active.is_(True),
        )
    )).scalars().all())
    if fas_dep:
        sl_pos = ZERO
        je = []
        for it in fas_dep:
            sl_pos += _fa_accumulated_dep_as_of(it, period_end)
            dep = fa_period_depreciation(it, p_start, period_end)
            if dep > ZERO:
                je.append({
                    "txn_id":     f"fa-dep-{it.id}-{period_end.isoformat()}",
                    "txn_type":   "Schedule (Depreciation)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   period_end.isoformat(),
                    "amount":     str(_q(-dep)),
                    "memo":       f"{it.description} — period depreciation per Nordavix Schedule",
                })
        return {"schedule_type": "fixed_asset_accdep", "sl_signed": _q(-sl_pos), "item_count": len(fas_dep), "je_items": je}

    # ── Lease LIABILITY (credit-natural) ─────────────────────────────
    leases_liab = list((await db.execute(
        select(ScheduleLease).where(
            ScheduleLease.qbo_account_id == qbo_account_id,
            ScheduleLease.is_active.is_(True),
        )
    )).scalars().all())
    if leases_liab:
        sl_pos = ZERO
        je = []
        active_count = 0
        for it in leases_liab:
            if it.initial_liability is None or it.discount_rate_pct is None:
                continue  # cash-basis lease — no BS liability
            active_count += 1
            sl_pos += _lease_liability_as_of(it, period_end)
            if p_start <= it.lease_start <= period_end:
                je.append({
                    "txn_id":     f"lease-init-{it.id}",
                    "txn_type":   "Schedule (Lease Initial)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.lease_start.isoformat(),
                    "amount":     str(_q(-Decimal(it.initial_liability))),
                    "memo":       f"{it.description} — initial lease liability per Nordavix Schedule",
                })
            principal = lease_principal_paid_in_period(it, p_start, period_end)
            if principal > ZERO:
                je.append({
                    "txn_id":     f"lease-pay-{it.id}-{period_end.isoformat()}",
                    "txn_type":   "Schedule (Lease Payment)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   period_end.isoformat(),
                    "amount":     str(_q(principal)),
                    "memo":       f"{it.description} — principal portion of lease payment per Nordavix Schedule",
                })
        if active_count > 0:
            return {"schedule_type": "lease_liability", "sl_signed": _q(-sl_pos), "item_count": active_count, "je_items": je}

    # ── Lease ROU asset (debit-natural) ──────────────────────────────
    leases_rou = list((await db.execute(
        select(ScheduleLease).where(
            ScheduleLease.rou_qbo_account_id == qbo_account_id,
            ScheduleLease.is_active.is_(True),
        )
    )).scalars().all())
    if leases_rou:
        sl = ZERO
        je = []
        active_count = 0
        for it in leases_rou:
            if it.initial_rou_asset is None:
                continue
            active_count += 1
            total_months = (it.lease_end.year - it.lease_start.year) * 12 + (it.lease_end.month - it.lease_start.month) + 1
            if total_months <= 0:
                continue
            months_elapsed = min(_months_between(it.lease_start, period_end), total_months)
            monthly_amort = Decimal(it.initial_rou_asset) / Decimal(total_months)
            rou_remaining = max(ZERO, Decimal(it.initial_rou_asset) - monthly_amort * Decimal(months_elapsed))
            sl += rou_remaining
            if p_start <= it.lease_start <= period_end:
                je.append({
                    "txn_id":     f"lease-rou-init-{it.id}",
                    "txn_type":   "Schedule (ROU Initial)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.lease_start.isoformat(),
                    "amount":     str(_q(Decimal(it.initial_rou_asset))),
                    "memo":       f"{it.description} — ROU asset recognized per Nordavix Schedule",
                })
            # Period amortization = monthly_amort × (months_elapsed_now − months_elapsed_prior).
            # prior_pe = last day of the month BEFORE p_start.
            if p_start.month == 1:
                prior_pe = date(p_start.year - 1, 12, 31)
            else:
                from calendar import monthrange as _mr
                prev_m = p_start.month - 1
                prior_pe = date(p_start.year, prev_m, _mr(p_start.year, prev_m)[1])
            months_prior = min(_months_between(it.lease_start, prior_pe), total_months)
            period_amort = max(ZERO, monthly_amort * Decimal(months_elapsed - months_prior))
            if period_amort > ZERO and it.lease_start <= period_end:
                je.append({
                    "txn_id":     f"lease-rou-amort-{it.id}-{period_end.isoformat()}",
                    "txn_type":   "Schedule (ROU Amortization)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   period_end.isoformat(),
                    "amount":     str(_q(-period_amort)),
                    "memo":       f"{it.description} — ROU period amortization per Nordavix Schedule",
                })
        if active_count > 0:
            return {"schedule_type": "lease_rou", "sl_signed": _q(sl), "item_count": active_count, "je_items": je}

    # ── Loan (credit-natural liability) ──────────────────────────────
    loans = list((await db.execute(
        select(ScheduleLoan).where(
            ScheduleLoan.qbo_account_id == qbo_account_id,
            ScheduleLoan.is_active.is_(True),
        )
    )).scalars().all())
    if loans:
        sl_pos = ZERO
        je = []
        for it in loans:
            sl_pos += _loan_principal_as_of(it, period_end)
            if p_start <= it.loan_date <= period_end:
                je.append({
                    "txn_id":     f"loan-orig-{it.id}",
                    "txn_type":   "Schedule (Loan Origination)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   it.loan_date.isoformat(),
                    "amount":     str(_q(-Decimal(it.original_principal))),
                    "memo":       f"{it.description} — loan origination per Nordavix Schedule",
                })
            principal = loan_principal_paid_in_period(it, p_start, period_end)
            if principal > ZERO:
                je.append({
                    "txn_id":     f"loan-pay-{it.id}-{period_end.isoformat()}",
                    "txn_type":   "Schedule (Loan Payment)",
                    "txn_number": str(it.id)[-8:],
                    "txn_date":   period_end.isoformat(),
                    "amount":     str(_q(principal)),
                    "memo":       f"{it.description} — principal payment per Nordavix Schedule",
                })
        return {"schedule_type": "loan", "sl_signed": _q(-sl_pos), "item_count": len(loans), "je_items": je}

    return None


# Type-aware offset (expense/cash) placeholder for a schedule correcting entry.
# The asset/liability side is the real GL account; this is the other side the
# user confirms before posting (the schedule doesn't store the offset account).
_SCHEDULE_OFFSET_LABELS = {
    "prepaid":            "Amortization expense",
    "accrual":            "Accrued expense",
    "fixed_asset_cost":   "Cash / original expense",
    "fixed_asset_accdep": "Depreciation expense",
    "lease_liability":    "Lease expense / cash",
    "lease_rou":          "ROU asset amortization expense",
    "loan":               "Interest expense / cash",
}


def _schedule_correcting_entry(
    *,
    schedule_type: str,
    qid: str,
    number: str,
    name: str,
    sl: Decimal,
    gl_balance: Decimal,
    gap: Decimal,
) -> dict[str, Any]:
    """Build a balanced correcting JE that brings a schedule-backed account's
    GL into line with its Nordavix schedule. The asset/liability side is the
    real GL account; the offset (expense/cash) is a type-aware placeholder the
    user confirms before posting. Direction follows the sign of the gap."""
    pretty = schedule_type.replace("_", " ")
    offset_label = _SCHEDULE_OFFSET_LABELS.get(schedule_type, "Offset account")
    mag = abs(gap).quantize(Decimal("0.01"))
    this_line = {"account_qbo_id": qid, "account_number": number or None, "account_name": name}
    offset_line = {"account_qbo_id": None, "account_number": None, "account_name": offset_label}
    # delta = sl - gl_balance (debit-positive). delta > 0 → this account needs a debit.
    if (sl - gl_balance) > Decimal("0"):
        lines = [
            {**this_line, "debit": str(mag), "credit": "0.00"},
            {**offset_line, "debit": "0.00", "credit": str(mag)},
        ]
    else:
        lines = [
            {**offset_line, "debit": str(mag), "credit": "0.00"},
            {**this_line, "debit": "0.00", "credit": str(mag)},
        ]
    return {
        "description": f"Adjust {name} to the Nordavix {pretty} schedule",
        "lines": lines,
        "memo": f"Per Nordavix {pretty} schedule",
        "rationale": (
            f"The {pretty} schedule (your subledger of record) shows {_money(sl)} but the GL "
            f"shows {_money(gl_balance)} — a {_money(gap)} gap. Post this entry in QuickBooks to "
            f"bring the GL in line with the schedule, then re-sync. Confirm the offset account "
            f"({offset_label}) before posting."
        ),
        "confidence": "medium",
    }


async def _process_schedule_backed_account(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: User,
    snap: GlBalanceSnapshot,
    period_end: date,
    review: AccountReviewStatus | None,
    gl_balance: Decimal,
    sched: dict,
    result: AgenticResult,
) -> None:
    """Reconcile a schedule-backed account: subledger = Nordavix Schedule,
    not QBO GL activity. Tied out → mark prepared. Variance → analyze + show
    expected JEs so the user knows what's missing in QBO."""
    sl = Decimal(sched["sl_signed"])
    je_items = sched["je_items"]
    gap = gl_balance - sl
    tied_out = abs(gap) < _TIE_TOLERANCE

    qid = snap.qbo_account_id
    name = snap.account_name
    number = snap.account_number or ""
    pretty_type = sched["schedule_type"].replace("_", " ")

    if tied_out:
        commentary = {
            "generated_at": datetime.now(UTC).isoformat(),
            "confidence":   "high",
            "checks": [
                {
                    "name":   "Subledger source",
                    "status": "pass",
                    "detail": (
                        f"Computed from Nordavix {pretty_type} schedule "
                        f"({sched['item_count']} active item(s)) — authoritative "
                        "subledger for this account."
                    ),
                },
                {
                    "name":   "Schedule vs GL",
                    "status": "pass",
                    "detail": (
                        f"Schedule SL of {_money(sl)} ties to GL of {_money(gl_balance)}. "
                        "No reconciling items needed."
                    ),
                },
            ],
            "recommendation": "approve",
            "narrative": (
                f"AI-prepared this schedule-backed reconciliation by deriving the "
                f"subledger from the Nordavix {pretty_type} schedule "
                f"({sched['item_count']} active item(s)). Schedule balance of {_money(sl)} "
                f"matches GL of {_money(gl_balance)} — clean tie-out."
            ),
        }
        await _save_prepared(
            db=db, tenant_id=tenant_id, user=user,
            qid=qid, period_end=period_end, review=review,
            subledger_total=sl, items=je_items,
            source_note=(
                f"AI-prepared (schedule-backed {pretty_type}): Nordavix Schedule "
                f"yields {_money(sl)}, matches GL {_money(gl_balance)} "
                f"({sched['item_count']} active item(s), {len(je_items)} period JE(s))."
            ),
            commentary=commentary,
        )
        # Ties to the schedule → no correcting entry needed. Clear any stale
        # OPEN proposal from a prior run when it didn't tie.
        await _persist_recon_proposals(
            db, tenant_id=tenant_id, qid=qid, period_end=period_end, proposed_entries=[],
        )
        result.prepared += 1
        result.accounts.append(AccountResult(
            qbo_account_id=qid, account_name=name, account_number=number,
            action="prepared",
            reason=f"Schedule-backed ({pretty_type}): Nordavix Schedule SL {_money(sl)} matches GL — tied out.",
            items_added=len(je_items),
            gap_before=str(gap.quantize(Decimal("0.01"))),
            gap_after=str(gap.quantize(Decimal("0.01"))),
        ))
        return

    # Variance — analyze, do NOT mark prepared.
    je_summary = (
        ", ".join(f"{j['txn_type']} {_money(Decimal(j['amount']))}" for j in je_items[:3])
        if je_items else "no period activity in the schedule"
    )
    commentary = {
        "generated_at": datetime.now(UTC).isoformat(),
        "confidence":   "medium",
        "checks": [
            {
                "name":   "Subledger source",
                "status": "pass",
                "detail": (
                    f"Computed from Nordavix {pretty_type} schedule "
                    f"({sched['item_count']} active item(s))."
                ),
            },
            {
                "name":   "Schedule vs GL",
                "status": "warn",
                "detail": (
                    f"Schedule SL of {_money(sl)} vs GL of {_money(gl_balance)} — "
                    f"variance of {_money(gap)}. The Nordavix Schedule is the "
                    "authoritative subledger; this gap means the corresponding "
                    "JE is missing (or extra) in QuickBooks."
                ),
            },
            {
                "name":   "Suggested JEs for this period",
                "status": "warn" if je_items else "pass",
                "detail": (
                    f"{len(je_items)} JE(s) expected per the schedule: {je_summary}. "
                    "See the Suggestions tab to review and post the missing entries to QBO."
                    if je_items else
                    "No new schedule activity this period — variance is from prior-period "
                    "JEs that were never posted to QBO."
                ),
            },
        ],
        "recommendation": "investigate",
        "narrative": (
            f"Schedule shows a balance of {_money(sl)} but QBO GL shows {_money(gl_balance)} — "
            f"a {_money(gap)} gap. The Nordavix Schedule is your subledger of record, so this "
            "variance represents JE(s) that need to be posted to (or removed from) QuickBooks. "
            "Open the Suggestions tab to see the expected JEs for this period and post them. "
            "Re-Sync the period after posting and re-run AI to confirm the tie-out."
        ),
    }
    await _save_analyzed_row(
        db=db, tenant_id=tenant_id,
        qid=qid, period_end=period_end, review=review,
        commentary=commentary,
        opening=Decimal("0"),  # n/a for schedule-backed
        variance=gap, candidate_count=len(je_items),
        prior_period_end=None,
    )
    # Draft a balanced correcting JE to bring the GL in line with the schedule
    # (the schedule is the subledger of record). Asset/liability side is the
    # real account; offset is a type-aware placeholder the user confirms.
    await _persist_recon_proposals(
        db, tenant_id=tenant_id, qid=qid, period_end=period_end,
        proposed_entries=[_schedule_correcting_entry(
            schedule_type=sched["schedule_type"], qid=qid, number=number,
            name=name, sl=sl, gl_balance=gl_balance, gap=gap,
        )],
    )
    result.analyzed += 1
    result.accounts.append(AccountResult(
        qbo_account_id=qid, account_name=name, account_number=number,
        action="analyzed",
        reason=(
            f"Schedule-backed ({pretty_type}): Nordavix Schedule SL of {_money(sl)} "
            f"doesn't match GL of {_money(gl_balance)} (variance {_money(gap)}). "
            "Likely missing or extra JE in QBO — see Suggestions tab."
        ),
        items_added=0,
        gap_before=str(gap.quantize(Decimal("0.01"))),
        gap_after=str(gap.quantize(Decimal("0.01"))),
    ))


# ── Display formatting ─────────────────────────────────────────────────────


def _money(v: Decimal) -> str:
    """Compact money format for log messages and notes."""
    sign = -1 if v < 0 else 1
    abs_v = abs(v).quantize(Decimal("0.01"))
    n = f"{abs_v:,.2f}"
    return f"$({n})" if sign < 0 else f"${n}"
