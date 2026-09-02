"""Does Nordavix's picture of the books match QuickBooks' own?

Nordavix derives its statements from `gl_balance_snapshots` — a trial balance
pulled once per sync and then reasoned over locally. That is fast, works while
QuickBooks is down, and respects the module's own classifications. It is also
an INDEPENDENT calculation, and an independent calculation that nobody checks
against the source is a second opinion nobody asked for.

`statement_validation` already checks internal consistency: assets equal
liabilities plus equity plus net income, cash flow has no unexplained plug.
That catches arithmetic. It cannot catch a snapshot that missed an account, a
classification the two systems disagree about, or a sync that silently captured
a stale balance — because in all three cases Nordavix's figures are internally
perfect and externally wrong.

So this asks the other question. Pull QuickBooks' own Balance Sheet and Profit
and Loss for the period, total them the same way, and compare. Two possible
answers and both are worth saying out loud:

  it ties      — the strongest sentence an accounting product can put on a
                 screen, and one Nordavix could not previously say at all.
  it doesn't   — with the line, the two figures, and the difference, so the
                 gap is a thing to investigate rather than a feeling.

Deliberately NOT a fix-it. It reports a disagreement; a human decides which
side is wrong, because "make the numbers match" is how a reconciliation becomes
a plug.
"""
from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from core.fiscal import fiscal_year_start
from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)

# What counts as agreement. Two systems rounding independently can differ by
# cents across hundreds of accounts; a dollar of slack absorbs that without
# hiding anything a reviewer would care about. Stated here rather than inline
# so the number is arguable — it is the whole definition of "ties".
TIE_TOLERANCE = Decimal("1.00")

# The lines compared, and where each one comes from in QuickBooks' own totals.
# Balance sheet first because it is the one a difference is most alarming in.
_LINES: list[tuple[str, str, str]] = [
    # (key, label, which QBO report)
    ("assets",             "Total assets",         "bs"),
    ("liabilities_equity", "Liabilities & equity", "bs"),
    ("revenue",            "Revenue",              "pl"),
    ("cogs",               "Cost of revenue",      "pl"),
    ("opex",               "Operating expenses",   "pl"),
    ("net_income",         "Net income",           "pl"),
]


def compare(ours: dict, theirs: dict, tolerance: Decimal = TIE_TOLERANCE) -> dict:
    """Line-by-line agreement between two sets of statement totals.

    Pure, and the reason it is pure is that "do these tie" is the one judgement
    in this module nobody should have to trust. A line either party could not
    produce is reported as `unavailable` rather than compared against a zero —
    a missing figure and a figure of nought are not the same claim, and treating
    them alike would let an empty QuickBooks report read as perfect agreement.
    """
    lines: list[dict] = []
    worst = Decimal("0")
    comparable = 0

    for key, label, source in _LINES:
        a, b = ours.get(key), theirs.get(key)
        if a is None or b is None:
            lines.append({
                "key": key, "label": label, "source": source,
                "nordavix": None if a is None else str(a),
                "quickbooks": None if b is None else str(b),
                "difference": None, "ties": None, "status": "unavailable",
            })
            continue
        diff = Decimal(str(a)) - Decimal(str(b))
        ties = abs(diff) <= tolerance
        comparable += 1
        worst = max(worst, abs(diff))
        lines.append({
            "key": key, "label": label, "source": source,
            "nordavix": str(a), "quickbooks": str(b),
            "difference": str(diff), "ties": ties,
            "status": "ties" if ties else "differs",
        })

    differing = [line for line in lines if line["status"] == "differs"]
    return {
        "lines": lines,
        "comparable": comparable,
        "differing": len(differing),
        # None, not True, when nothing could be compared. "Everything ties" out
        # of zero comparisons is the most confident wrong answer available.
        "ties": None if comparable == 0 else len(differing) == 0,
        "largest_difference": str(worst) if comparable else None,
        "tolerance": str(tolerance),
    }


async def qbo_totals(
    conn: QboConnection | None, db: AsyncSession, period_end: date,
    *, fiscal_year_end: str | None = None,
) -> tuple[dict, str | None]:
    """QuickBooks' OWN totals for the period, as (totals, error).

    The P&L is pulled year-to-date from the fiscal year start, which is what
    the snapshot holds — comparing a monthly figure against a year-to-date one
    would manufacture a difference and then report it as a problem with the
    books.
    """
    if conn is None:
        return {}, "QuickBooks isn't connected, so there's nothing to compare against."

    from modules.financials.router import _fetch_bs, _fetch_pl

    try:
        bs = await _fetch_bs(conn, db, period_end)
        pl = await _fetch_pl(conn, db, period_end, fiscal_year_start(period_end, fiscal_year_end))
    except Exception:
        logger.exception("Tie-out: QuickBooks report fetch failed for %s", period_end)
        return {}, "Couldn't read the statements from QuickBooks. Try again, or reconnect."

    return {**_totals_from_rows(bs, "bs"), **_totals_from_rows(pl, "pl")}, None


# QBO labels its own summary rows, and the wording varies by locale and by
# whether a company uses "Income" or "Revenue". Matched on a normalised
# substring rather than equality so a "Total Income" and a "Total Revenue"
# both land, and listed most-specific first so "Total Other Income" cannot be
# swallowed by the "Income" match.
_ROW_MATCHERS: list[tuple[str, str, tuple[str, ...]]] = [
    ("assets",             "bs", ("total assets",)),
    ("liabilities_equity", "bs", ("total liabilities and equity",
                                  "total liabilities & equity")),
    ("cogs",               "pl", ("total cost of goods sold", "total cost of sales",
                                  "total cost of revenue")),
    ("opex",               "pl", ("total expenses", "total operating expenses")),
    ("revenue",            "pl", ("total income", "total revenue")),
    ("net_income",         "pl", ("net income", "profit for the year", "net profit")),
]


def _totals_from_rows(rows, which: str) -> dict[str, Decimal]:
    """Pick the summary lines out of a parsed QBO report.

    Only rows QuickBooks itself labelled as totals are read — the report's own
    arithmetic, not ours re-derived from its detail. The point of the exercise
    is to compare against THEIR answer; recomputing it here would compare
    Nordavix against Nordavix.
    """
    out: dict[str, Decimal] = {}
    for row in rows:
        label = (getattr(row, "label", "") or "").strip().lower()
        if not label:
            continue
        values = getattr(row, "values", None) or []
        if not values:
            continue
        for key, source, needles in _ROW_MATCHERS:
            if source != which or key in out:
                continue
            if any(n in label for n in needles):
                out[key] = Decimal(str(values[0]))
                break
    return out
