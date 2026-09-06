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
    ("assets",              "Total assets",                "bs"),
    # QuickBooks' "Total Liabilities and Equity" INCLUDES current-year net
    # income; Nordavix's `liabilities_equity` deliberately excludes it (the
    # adjustments rail needs it that way). Comparing those two reported a
    # whole year's profit as a discrepancy in the client's books, which is why
    # this line names the balance-sheet total instead.
    ("balance_sheet_total", "Total liabilities & equity",  "bs"),
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

    return (
        {**_totals_from_rows(bs, "bs"), **_totals_from_rows(pl, "pl"),
         # The balance-sheet detail, so a total that disagrees can name the
         # account rather than leaving someone to hunt through the chart.
         "_bs_rows": bs},
        None,
    )


# QBO labels its own summary rows, and the wording varies by locale and by
# whether a company uses "Income" or "Revenue". Matched on a normalised
# substring rather than equality so a "Total Income" and a "Total Revenue"
# both land, and listed most-specific first so "Total Other Income" cannot be
# swallowed by the "Income" match.
_ROW_MATCHERS: list[tuple[str, str, tuple[str, ...]]] = [
    ("assets",             "bs", ("total assets",)),
    ("balance_sheet_total", "bs", ("total liabilities and equity",
                                   "total liabilities & equity")),
    ("cogs",               "pl", ("total cost of goods sold", "total cost of sales",
                                  "total cost of revenue")),
    ("opex",               "pl", ("total expenses", "total operating expenses")),
    ("revenue",            "pl", ("total income", "total revenue")),
    ("net_income",         "pl", ("net income", "profit for the year", "net profit")),
]


def _norm(name: str) -> str:
    """An account name reduced to something two systems can be matched on.

    QuickBooks renders sub-accounts with a colon path and pads for indentation;
    the snapshot stores the leaf name alone. Lowercased, trimmed, and reduced to
    the last path segment so "Fixed Assets:Vehicles" meets "Vehicles".
    """
    tail = (name or "").split(":")[-1]
    return " ".join(tail.lower().split())


def account_differences(
    ours: list[dict], theirs: list, tolerance: Decimal = TIE_TOLERANCE,
) -> list[dict]:
    """WHICH accounts disagree, not just by how much in total.

    A verdict of "6,421 somewhere on the balance sheet" sends someone hunting
    through a chart of accounts by hand, which is the work the tie-out was
    supposed to remove. The totals answer whether to look; this answers where.

    Three kinds of disagreement, kept apart because they mean different things:

      differs     both systems carry the account and disagree on its balance.
      only_qbo    QuickBooks has it and the snapshot doesn't — the usual shape
                  when an account was created, or a transaction posted, after
                  the period was last synced.
      only_ours   the snapshot has it and QuickBooks' report doesn't, which is
                  usually an account that netted to zero and was omitted from
                  their report rather than one that vanished.

    Matched on NAME, which is the only key the two sides share — QuickBooks'
    report gives labels, not account ids. Imperfect: a renamed account shows as
    one of each. Reported as two rows rather than silently paired, because
    guessing at a pairing is how a real difference gets hidden inside a
    plausible one.
    """
    mine = {_norm(a["account_name"]): a for a in ours if a.get("account_name")}
    qbo: dict[str, Decimal] = {}
    for row in theirs:
        if getattr(row, "kind", "") != "data":
            continue
        key = _norm(getattr(row, "label", ""))
        values = getattr(row, "values", None) or []
        if not key or not values:
            continue
        qbo[key] = qbo.get(key, Decimal("0")) + Decimal(str(values[0]))

    out: list[dict] = []
    for key, acct in mine.items():
        ours_val = Decimal(str(acct.get("presented", 0)))
        if key not in qbo:
            if abs(ours_val) > tolerance:
                out.append({"account_name": acct["account_name"], "status": "only_ours",
                            "nordavix": str(ours_val), "quickbooks": None,
                            "difference": str(ours_val)})
            continue
        diff = ours_val - qbo[key]
        if abs(diff) > tolerance:
            out.append({"account_name": acct["account_name"], "status": "differs",
                        "nordavix": str(ours_val), "quickbooks": str(qbo[key]),
                        "difference": str(diff)})
    for key, val in qbo.items():
        if key not in mine and abs(val) > tolerance:
            out.append({"account_name": key.title(), "status": "only_qbo",
                        "nordavix": None, "quickbooks": str(val),
                        "difference": str(-val)})

    # Largest gap first — the one most likely to explain the total.
    out.sort(key=lambda r: abs(Decimal(r["difference"])), reverse=True)
    return out[:20]


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
