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


async def run_agentic_prep(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: User,
    period_end: date,
) -> AgenticResult:
    """Iterate every reconcilable account for the period and apply the
    agentic preparer logic. Synchronous — caller blocks until done.
    Typical 20-account period takes ~5-15s depending on QBO latency
    and how many accounts need AI analysis."""
    start_dt = datetime.now(UTC)
    result = AgenticResult(period_end=period_end.isoformat(), started_at=start_dt.isoformat())

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
    # doesn't lose the work done on rows 1-6.
    for snap in snap_rows:
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
    if review and review.subledger_total is not None:
        result.skipped += 1
        result.accounts.append(AccountResult(
            qbo_account_id=qid, account_name=name, account_number=number,
            action="skipped",
            reason="A preparer already entered a manual subledger value — AI defers to human input.",
        ))
        return

    # ── Compute opening balance (rolled forward from prior close) ───────
    opening = Decimal(prior.subledger_total) if prior and prior.subledger_total is not None else Decimal("0")
    gl_balance = Decimal(snap.balance)
    is_credit_natural = snap.account_type in _CREDIT_NATURAL_TYPES
    flip = -1 if is_credit_natural else 1

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

    # Build the reconciling-items payload in the EXACT shape the inline
    # form / PDF / overview code expects.
    items: list[dict[str, Any]] = []
    signed_sum = Decimal("0")
    for r in gl_rows:
        amount = r["amount"]  # Decimal — already signed per QBO's convention
        signed = flip * amount
        signed_sum += signed
        items.append({
            "txn_id":     r.get("qbo_txn_id") or "",
            "txn_type":   r.get("txn_type") or "",
            "txn_number": r.get("txn_number") or "",
            "txn_date":   r["txn_date"].isoformat() if r.get("txn_date") else "",
            "amount":     str(amount),     # store raw amount; flip happens at display time
            "memo":       r.get("memo") or "",
        })

    computed = opening + signed_sum
    gap_before = gl_balance - opening   # before any items
    gap_after = gl_balance - computed   # after ticking all items
    tied_out = abs(gap_after) < _TIE_TOLERANCE

    if tied_out:
        # ── Auto-prepare: save override + mark reviewed ─────────────────
        await _save_prepared(
            db=db, tenant_id=tenant_id, user=user,
            qid=qid, period_end=period_end, review=review,
            subledger_total=computed,
            items=items,
            source_note=(
                f"AI-prepared: opening {_money(opening)} + "
                f"{len(items)} period transaction{'' if len(items) == 1 else 's'} "
                f"(net {_money(signed_sum)}) = subledger {_money(computed)} = GL {_money(gl_balance)}."
            ),
        )
        result.prepared += 1
        result.accounts.append(AccountResult(
            qbo_account_id=qid, account_name=name, account_number=number,
            action="prepared",
            reason=(
                f"Tied out by including all {len(items)} transaction"
                f"{'' if len(items) == 1 else 's'} posted this period."
            ),
            items_added=len(items),
            gap_before=str(gap_before.quantize(Decimal('0.01'))),
            gap_after=str(gap_after.quantize(Decimal('0.01'))),
        ))
        return

    # ── Can't tie out — AI analyzes likely reasons for the residual gap ─
    # Don't change the status. Don't save items. Just attach a note so
    # a human preparer reads the analysis when they open the row.
    try:
        ai_note = _analyze_gap(
            account_name=name,
            account_number=number,
            account_type=snap.account_type,
            period_end=period_end,
            opening=opening,
            gl_balance=gl_balance,
            ticked_sum=signed_sum,
            items=items,
            residual_gap=gap_after,
        )
    except Exception as e:
        logger.exception("AI analysis failed for %s", qid)
        ai_note = (
            f"AI-analyzed: couldn't auto-tie. Opening {_money(opening)} + period activity "
            f"{_money(signed_sum)} = {_money(computed)} vs GL {_money(gl_balance)} "
            f"(residual gap {_money(gap_after)}). "
            f"AI gap-analysis call failed: {type(e).__name__}."
        )

    await _save_analyzed_note(
        db=db, tenant_id=tenant_id,
        qid=qid, period_end=period_end, review=review,
        note=ai_note,
    )
    result.analyzed += 1
    result.accounts.append(AccountResult(
        qbo_account_id=qid, account_name=name, account_number=number,
        action="analyzed",
        reason=(
            f"Couldn't auto-tie (residual gap {_money(gap_after)}). "
            "AI analysis written to the row's notes — a human preparer needs to finish this one."
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
) -> None:
    """Upsert the AccountReviewStatus row with the AI-prepared subledger
    and flip status to "reviewed". Mirrors the inline form's save path so
    a human-prepared row and an AI-prepared row are structurally identical."""
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


async def _save_analyzed_note(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    qid: str,
    period_end: date,
    review: AccountReviewStatus | None,
    note: str,
) -> None:
    """Upsert AccountReviewStatus with an AI analysis note. Status stays
    "pending" (don't flip it — only successful ties prepare). If there
    are existing preparer notes we append rather than overwrite."""
    now = datetime.now(UTC)
    final_note = note
    if review and review.notes and review.notes.strip():
        # Don't clobber human notes — append.
        final_note = f"{review.notes.rstrip()}\n\n— AI analysis added {now.strftime('%Y-%m-%d')} —\n{note}"

    if review is None:
        review = AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qid,
            period_end=period_end,
            status="pending",
            notes=final_note,
            reconciling_items=[],
        )
        db.add(review)
    else:
        review.notes = final_note

    await db.commit()


# ── AI gap analysis ────────────────────────────────────────────────────────


def _analyze_gap(
    *,
    account_name: str,
    account_number: str,
    account_type: str,
    period_end: date,
    opening: Decimal,
    gl_balance: Decimal,
    ticked_sum: Decimal,
    items: list[dict[str, Any]],
    residual_gap: Decimal,
) -> str:
    """Ask Claude for 2-3 likely reasons the AI couldn't tie this account.

    Single API call per non-tying account — adds ~$0.001-0.005 + ~1-2s
    per call. For a small period (5-10 non-tying accounts) the total
    overhead is acceptable. For a large period the upstream caller can
    rate-limit (out of scope here)."""
    # Compact summary of the items (don't ship 100 lines of memo text
    # to the API — pick top 5 by absolute amount).
    sorted_items = sorted(
        items,
        key=lambda i: abs(Decimal(str(i.get("amount", "0") or "0"))),
        reverse=True,
    )[:5]
    items_summary = "\n".join(
        f"  - {i.get('txn_date','')} {i.get('txn_type','')} #{i.get('txn_number','')}: "
        f"{_money(Decimal(str(i.get('amount','0') or '0')))} — {(i.get('memo') or '')[:80]}"
        for i in sorted_items
    ) or "  (no transactions posted to this account in the period)"

    system_prompt = (
        "You are a senior accountant reviewing a month-end account reconciliation that "
        "failed to tie out by including all current-period transactions. Your job is to "
        "explain — in 2-3 sentences — the MOST LIKELY reasons for the residual gap.\n\n"
        "Output rules:\n"
        "  - Plain text only — no markdown, no headings, no bullets.\n"
        "  - Be specific and actionable: name what a preparer should check next.\n"
        "  - Don't invent transactions or amounts — work only from what's provided.\n"
        "  - Skip generic platitudes like 'review with care' — give concrete leads.\n"
        "  - Keep it under 80 words."
    )
    user_prompt = (
        f"Account: {account_number + ' · ' if account_number else ''}{account_name}\n"
        f"Account Type: {account_type}\n"
        f"Period End: {period_end.isoformat()}\n\n"
        f"Opening balance (rolled forward from prior close): {_money(opening)}\n"
        f"GL balance at period end: {_money(gl_balance)}\n"
        f"Net activity from {len(items)} current-period transaction(s): {_money(ticked_sum)}\n"
        f"Computed closing subledger (opening + activity): {_money(opening + ticked_sum)}\n"
        f"Residual gap (GL − computed subledger): {_money(residual_gap)}\n\n"
        f"Top transactions by magnitude:\n{items_summary}\n\n"
        f"What are the 2-3 most likely reasons this account doesn't tie out?"
    )

    # Reuse the existing AI client. cache_key is informational here — we
    # don't have a stable cache concept for gap analysis (the data changes
    # every sync), but pass a deterministic-ish key for telemetry.
    from core.ai.client import compute_cache_key, generate_narrative
    key = compute_cache_key(
        account_number or account_name,
        str(gl_balance), str(opening),
        f"agentic-gap-{period_end.isoformat()}",
    )
    resp = generate_narrative(system_prompt, user_prompt, key, max_tokens=240)

    return (
        f"AI-analyzed: couldn't auto-tie this account. "
        f"Opening {_money(opening)} + {len(items)} period transaction(s) totaling "
        f"{_money(ticked_sum)} = computed subledger {_money(opening + ticked_sum)}, "
        f"vs GL {_money(gl_balance)} (residual gap {_money(residual_gap)}).\n\n"
        f"Likely reasons:\n{resp.content.strip()}"
    )


# ── Display formatting ─────────────────────────────────────────────────────


def _money(v: Decimal) -> str:
    """Compact money format for log messages and notes."""
    sign = -1 if v < 0 else 1
    abs_v = abs(v).quantize(Decimal("0.01"))
    n = f"{abs_v:,.2f}"
    return f"$({n})" if sign < 0 else f"${n}"
