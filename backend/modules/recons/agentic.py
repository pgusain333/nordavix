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

    # Fallback roll-forward source: prior-period GL snapshot. Used when
    # an account has no reconciled prior subledger. Without this the AI
    # would assume opening = $0 on every first-time account and never
    # tie out. With it, opening = GL @ prior period_end → first April
    # reconciliation works because (GL @ Mar 31) + April activity = GL @ Apr 30.
    prior_snap_rows = list((await db.execute(
        select(GlBalanceSnapshot)
        .where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.period_end < period_end,
        )
        .order_by(GlBalanceSnapshot.qbo_account_id, GlBalanceSnapshot.period_end.desc())
    )).scalars().all())
    prior_snap_by_qid: dict[str, GlBalanceSnapshot] = {}
    for r in prior_snap_rows:
        if r.qbo_account_id not in prior_snap_by_qid:
            prior_snap_by_qid[r.qbo_account_id] = r

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
                prior_snap=prior_snap_by_qid.get(snap.qbo_account_id),
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
    prior_snap: GlBalanceSnapshot | None,
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
    # Detect whether a populated subledger_total was set by AI vs by a
    # human. AI defers to humans but should refresh its OWN prior work
    # (especially after logic improvements like the prior-GL roll-forward
    # fallback). Three signals identify an AI-set subledger:
    #   1. ai_commentary is not null (new column from the commentary
    #      feature — present on every AI-prepared row going forward)
    #   2. subledger_source string starts with "AI-prepared" (legacy
    #      AI runs from before the commentary feature shipped)
    #   3. The user clicking Agentic Mode now is the same one who last
    #      saved the subledger AND it has an AI-shaped source — they're
    #      re-running their own automation, allow it.
    if review and review.subledger_total is not None:
        src = (review.subledger_source or "").lower()
        was_ai = (
            review.ai_commentary is not None
            or src.startswith("ai-prepared")
            or "ai-prepared" in src
        )
        if not was_ai:
            result.skipped += 1
            result.accounts.append(AccountResult(
                qbo_account_id=qid, account_name=name, account_number=number,
                action="skipped",
                reason=(
                    "A human preparer already entered a manual subledger value — "
                    "AI defers to human input. Clear the override on the row if "
                    "you want AI to re-prepare it."
                ),
            ))
            return
        # Otherwise: AI set this previously. Re-prep is allowed — fall
        # through to the normal flow, which overwrites with fresh data.

    # ── Compute opening balance ─────────────────────────────────────────
    # Priority chain (matches the dashboard's display logic):
    #   1. Prior period's reconciled subledger (rolled forward)
    #   2. Prior period's GL balance snapshot (audit-ready fallback so
    #      first-time reconciliations have a sensible starting point —
    #      GL @ Mar 31 is deterministic and auditable; assuming $0 would
    #      bake the entire historical balance into "current activity"
    #      and make the AI's math impossible to tie out)
    #   3. Zero (truly no history)
    opening_source: str
    if prior is not None and prior.subledger_total is not None:
        opening = Decimal(prior.subledger_total)
        opening_source = f"reconciled prior-period subledger ({prior.period_end.isoformat()})"
    elif prior_snap is not None:
        opening = Decimal(prior_snap.balance)
        opening_source = (
            f"GL balance at the prior period end ({prior_snap.period_end.isoformat()}) — "
            "no reconciled subledger on file for the prior period"
        )
    else:
        opening = Decimal("0")
        opening_source = "no prior period on file (assumed $0 opening)"

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
        # ── Auto-prepare: save override + mark reviewed + AI commentary ─
        # Commentary is only useful when AI actually DID something — i.e.,
        # ticked one or more reconciling items. Accounts with zero period
        # activity tie out trivially (opening rolled forward = GL), so
        # there's nothing for the AI to explain. Skip the commentary
        # build + the Claude call in that case (no value, just cost).
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
                    items=items, prior=prior, prior_snap=prior_snap,
                    opening_source_label=opening_source,
                )
                logger.info(
                    "Agentic: commentary built for %s (%s) — confidence=%s recommendation=%s",
                    qid, name,
                    commentary.get("confidence") if commentary else "(none)",
                    commentary.get("recommendation") if commentary else "(none)",
                )
            except Exception:
                # Don't let a commentary failure block the prep — the
                # account still gets tied out + saved; just no card.
                logger.exception(
                    "Agentic: commentary BUILD FAILED for %s (%s) — preparing without commentary",
                    qid, name,
                )
                commentary = None
        else:
            logger.info(
                "Agentic: skipping commentary for %s (%s) — zero items (trivial tie-out)",
                qid, name,
            )
            commentary = None
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
            commentary=commentary,
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


# ── AI commentary on tied-out reconciliations ──────────────────────────────


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
    prior_snap: GlBalanceSnapshot | None = None,
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

    # Check 2: Opening provenance — three flavors:
    #   • Pass : rolled forward from a reconciled prior subledger
    #   • Warn : rolled forward from prior GL snapshot (no reconciled
    #            prior subledger, so we're trusting the prior GL was
    #            correct — auditor should confirm)
    #   • Warn : truly no prior history — opening assumed $0
    if prior is not None and prior.subledger_total is not None:
        checks.append({
            "name":   "Opening balance",
            "status": "pass",
            "detail": (
                f"Rolled forward from prior period's reconciled subledger "
                f"({prior.period_end.isoformat()})."
            ),
        })
    elif prior_snap is not None:
        checks.append({
            "name":   "Opening balance",
            "status": "warn",
            "detail": (
                f"Rolled forward from prior period's GL balance "
                f"({prior_snap.period_end.isoformat()}) since no reconciled subledger "
                "exists for that period. Confirm the prior-period GL was accurate "
                "before approving."
            ),
        })
    else:
        checks.append({
            "name":   "Opening balance",
            "status": "warn",
            "detail": (
                "No prior-period closing on file — assumed $0 as opening. "
                "Verify this is the first reconciliation period for the account."
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
        if "journal" in t.lower() or "je" == t.lower():
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

    return {
        "generated_at":   datetime.now(UTC).isoformat(),
        "confidence":     confidence,
        "checks":         checks,
        "recommendation": recommendation,
        "narrative":      narrative,
    }


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
