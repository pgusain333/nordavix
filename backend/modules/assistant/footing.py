"""What the Copilot is standing on when it quotes a number.

The Copilot would state net income for a month that was never synced, never
reconciled and does not tie out — in the same confident voice it uses for a
closed period. That is the failure this codebase keeps re-encountering in
different clothes: a figure that looks authoritative while its basis is
silently different.

A controller never gives a number without its footing. This computes the
footing ONCE per turn, cheaply, and injects it into the system context, so
every answer carries it whether or not the model thinks to ask. Making it a
tool would have left it optional, and the answers that most need the caveat are
exactly the ones where nobody thinks to look.

Four small queries, all local — no QuickBooks call.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# Past this, "as of the last sync" stops being a footnote and becomes the
# headline: a fortnight of unseen activity can move any figure on the page.
STALE_DAYS = 14


def describe(state: dict) -> str:
    """One paragraph of plain English the model can quote or paraphrase.

    Deliberately written as prose rather than a scorecard: a model asked to
    reason about `{"reconciled": 4, "total": 19}` will invent a framing, and
    the framing is the part that matters.
    """
    if not state.get("synced"):
        return (
            f"DATA FOOTING for {state['period_end']}: this period has NEVER been synced "
            "from QuickBooks. You have no figures for it. Say so plainly and offer to "
            "point the user at Sync — do not answer from an adjacent month as though it "
            "were this one."
        )

    bits: list[str] = []
    age = state.get("sync_age_days")
    if age is None:
        bits.append("the last sync time is unknown")
    elif age <= 1:
        bits.append("synced within the last day")
    elif age > STALE_DAYS:
        bits.append(
            f"last synced {age} days ago, so anything posted since is invisible to you"
        )
    else:
        bits.append(f"last synced {age} days ago")

    total = state.get("accounts_total") or 0
    done = state.get("accounts_reconciled") or 0
    if total:
        if done >= total:
            bits.append("every reconciliation is approved")
        elif done == 0:
            bits.append(f"none of the {total} reconciliations are approved yet")
        else:
            bits.append(f"{done} of {total} reconciliations approved")

    ties = state.get("ties")
    if ties is False:
        bits.append(
            f"and the balance sheet does NOT tie by {state.get('tie_difference')}"
        )
    elif ties is True:
        bits.append("and the balance sheet ties")

    grade = state.get("grade")
    guidance = {
        "closed": (
            "These books are closed and reconciled. Quote figures as final."
        ),
        "in_progress": (
            "These books are still in the close. Quote figures normally but say once, "
            "near the top, that the period is not closed yet — figures can still move."
        ),
        "raw": (
            "These books are synced but essentially unreviewed. Every figure you quote "
            "is a QuickBooks balance, not a closed one. Lead with that caveat, in one "
            "short sentence, before the numbers — and prefer directional language "
            "('roughly', 'as it stands') over precision the data hasn't earned."
        ),
    }.get(grade, "")

    return (
        f"DATA FOOTING for {state['period_end']}: " + ", ".join(bits) + ". " + guidance
    )


def grade(*, synced: bool, total: int, reconciled: int, ties: bool | None,
          sync_age_days: int | None) -> str:
    """closed | in_progress | raw | unsynced.

    "Closed" requires all three: everything reconciled, the sheet tying, and a
    sync recent enough that the answer is about the books the user has. Two out
    of three is in progress — the missing one is always the one that bites.
    """
    if not synced:
        return "unsynced"
    if total and reconciled >= total and ties is not False:
        if sync_age_days is not None and sync_age_days > STALE_DAYS:
            return "in_progress"
        return "closed"
    if reconciled > 0 or ties is True:
        return "in_progress"
    return "raw"


async def data_footing(
    db: AsyncSession,
    tenant_id: uuid.UUID,  # noqa: ARG001 — scoping is enforced by the session
    period_end: date | None,
) -> dict | None:
    """Assemble the footing for one period. Never raises — a footing that fails
    to compute must not take the answer down with it; the model simply gets no
    footing block and answers as it did before."""
    if period_end is None:
        return None
    try:
        from models.account_review_status import AccountReviewStatus
        from models.gl_balance_snapshot import GlBalanceSnapshot
        from models.period_sync import PeriodSync

        synced_at = (await db.execute(
            select(PeriodSync.synced_at).where(PeriodSync.period_end == period_end)
        )).scalar_one_or_none()

        n_accounts = (await db.execute(
            select(func.count()).select_from(GlBalanceSnapshot)
            .where(GlBalanceSnapshot.period_end == period_end)
        )).scalar_one_or_none() or 0

        if not n_accounts:
            return {"period_end": period_end.isoformat(), "synced": False, "grade": "unsynced"}

        # Balance-sheet accounts are the ones that carry a reconciliation; the
        # denominator has to match or "3 of 60 approved" reads as a disaster on
        # a client whose P&L accounts were never in scope.
        bs_ids = set((await db.execute(
            select(GlBalanceSnapshot.qbo_account_id).where(
                GlBalanceSnapshot.period_end == period_end,
                GlBalanceSnapshot.account_type.in_([
                    "Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset",
                    "Other Asset", "Accounts Payable", "Credit Card",
                    "Other Current Liability", "Long Term Liability", "Equity",
                ]),
            )
        )).scalars().all())

        approved = 0
        if bs_ids:
            approved = (await db.execute(
                select(func.count()).select_from(AccountReviewStatus).where(
                    AccountReviewStatus.period_end == period_end,
                    AccountReviewStatus.status == "approved",
                    AccountReviewStatus.qbo_account_id.in_(bs_ids),
                )
            )).scalar_one_or_none() or 0

        ties: bool | None = None
        tie_diff = None
        try:
            from modules.financials.internal import statement_totals
            totals = await statement_totals(db, tenant_id, period_end)
            if totals:
                diff = totals["assets"] - totals["balance_sheet_total"]
                ties = abs(diff) < 1
                tie_diff = f"{diff:,.2f}"
        except Exception:
            logger.exception("footing: tie-out check failed")

        age_days = None
        if synced_at:
            age_days = max(0, (datetime.now(UTC) - synced_at).days)

        state = {
            "period_end": period_end.isoformat(),
            "synced": True,
            "sync_age_days": age_days,
            "accounts_total": len(bs_ids),
            "accounts_reconciled": approved,
            "ties": ties,
            "tie_difference": tie_diff,
        }
        state["grade"] = grade(
            synced=True, total=len(bs_ids), reconciled=approved,
            ties=ties, sync_age_days=age_days,
        )
        return state
    except Exception:
        logger.exception("footing: could not assess period %s", period_end)
        return None
