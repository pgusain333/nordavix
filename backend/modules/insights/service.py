"""
Insights — turn the snapshot data we already capture (gl_balance_snapshots
+ period_sync) plus a live AR/AP aging pull into decision-grade KPIs.

The dashboard reads ONE endpoint (/api/insights/overview?period_end=YYYY-MM-DD)
and renders everything from the returned blob. All math + risk grading +
heuristic recommendations happen here so the frontend stays dumb.

Sign conventions (matching the rest of Nordavix):
  • gl_balance_snapshots.balance is debit-positive (raw QBO TB).
  • Income / Liability / Equity are credit-natural → flip for presentation.
  • Aging reports from QBO are already natural-positive magnitudes.
"""
from __future__ import annotations

import calendar
import logging
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.gl_balance_snapshot import GlBalanceSnapshot
from models.period_sync import PeriodSync
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from modules.recons.service import _flatten_report_rows, _qbo_get

logger = logging.getLogger(__name__)

# ── QBO account type taxonomy ────────────────────────────────────────────────

CASH_TYPES = {"Bank"}
AR_TYPES   = {"Accounts Receivable"}
AP_TYPES   = {"Accounts Payable"}
# GAAP-aligned: Revenue is OPERATING income only; "Other Income" sits below
# Operating Income on the P&L (interest income, gains on sale, etc.).
# Same for Expense vs Other Expense (Other Expense = interest, losses, …).
INCOME_TYPES         = {"Income"}
OTHER_INCOME_TYPES   = {"Other Income"}
COGS_TYPES           = {"Cost of Goods Sold"}
EXPENSE_TYPES        = {"Expense"}
OTHER_EXPENSE_TYPES  = {"Other Expense"}

# Union used for revenue-trend history (showing all top-line income).
ALL_INCOME_TYPES = INCOME_TYPES | OTHER_INCOME_TYPES
ALL_EXPENSE_TYPES = EXPENSE_TYPES | OTHER_EXPENSE_TYPES | COGS_TYPES

# ── Direct-expense classification ────────────────────────────────────────────
# QBO's account_type only distinguishes COGS from Expense — there's no native
# tag for "direct" vs "indirect" inside the Expense bucket. We classify
# Expense-typed accounts as 'direct' (and therefore part of GP) if EITHER:
#   • the account_number starts with "5" (standard chart-of-accounts
#     convention — 5xxx = direct costs, 6xxx+ = operating overhead), OR
#   • the account_name contains an unambiguous direct-cost keyword.
# COGS-typed accounts are always direct.

_DIRECT_EXPENSE_KEYWORDS = (
    "direct ", "labor", "production",
    "raw material", "raw materials",
    "freight", "shipping",
    "merchant", "processing fee", "transaction fee",
    "hosting", "infrastructure", "api cost", "platform fee",
    "cost of sales", "cost of revenue", "cost of service",
)


def _is_direct_expense(
    account_type: str,
    account_name: str | None = None,
    account_number: str | None = None,
) -> bool:
    """Decide whether a P&L account is a 'direct' cost for GP purposes."""
    if account_type in COGS_TYPES:
        return True
    if account_type in EXPENSE_TYPES:
        if account_number and account_number.strip().startswith("5"):
            return True
        if account_name:
            nm = account_name.lower()
            if any(k in nm for k in _DIRECT_EXPENSE_KEYWORDS):
                return True
    return False

ASSET_TYPES = {"Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset"}
LIAB_TYPES  = {"Accounts Payable", "Credit Card", "Other Current Liability", "Long Term Liability"}
EQUITY_TYPES = {"Equity"}

# Working-capital classification (for liquidity ratios + the indirect-method
# operating cash flow). Current = expected to convert to/consume cash within a
# year. Credit Card is an operating current liability. Long-term items are
# excluded from current ratios on purpose.
CURRENT_ASSET_TYPES       = {"Bank", "Accounts Receivable", "Other Current Asset"}
OTHER_CURRENT_ASSET_TYPES = {"Other Current Asset"}          # inventory, prepaids, etc.
CURRENT_LIAB_TYPES        = {"Accounts Payable", "Credit Card", "Other Current Liability"}
OTHER_CURRENT_LIAB_TYPES  = {"Credit Card", "Other Current Liability"}  # ex-AP (accrued, deferred rev, CC)

# Non-cash expense accounts added back in the indirect cash-flow method. QBO
# has no native "non-cash" flag, so we match by account name.
_DEPRECIATION_KEYWORDS = ("depreciation", "amortization", "amortisation", "depletion")


def _is_depreciation(account_name: str | None) -> bool:
    if not account_name:
        return False
    nm = account_name.lower()
    return any(k in nm for k in _DEPRECIATION_KEYWORDS)


def _is_inventory(account_name: str | None) -> bool:
    return bool(account_name and "inventory" in account_name.lower())

# Credit-natural — balance comes back negative; flip for display.
CREDIT_NATURAL = LIAB_TYPES | EQUITY_TYPES | INCOME_TYPES | OTHER_INCOME_TYPES

ZERO = Decimal("0")


# ── helpers ──────────────────────────────────────────────────────────────────

def _to_money(d: Decimal | int | float) -> float:
    """Round to 2dp and return as float for JSON."""
    if d is None:
        return 0.0
    return float(Decimal(d).quantize(Decimal("0.01")))


def _to_pct(num: Decimal | float, denom: Decimal | float) -> float | None:
    """Safe percentage to 1dp, or None if denominator is zero/None."""
    if denom in (None, 0, ZERO):
        return None
    return float((Decimal(num) / Decimal(denom) * 100).quantize(Decimal("0.1")))


def _prior_month_end(d: date) -> date:
    """Last day of the calendar month immediately preceding d."""
    first = d.replace(day=1)
    return first - timedelta(days=1)


def _last_day_of_month(d: date) -> date:
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])


def _add_months(d: date, n: int) -> date:
    """Add n calendar months to d, clamping the day to the target month length."""
    total = d.month - 1 + n
    year = d.year + total // 12
    month = total % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _signed_presentation(account_type: str, balance: Decimal) -> Decimal:
    """Flip credit-natural accounts so presentation values read positive."""
    if account_type in CREDIT_NATURAL:
        return -balance
    return balance


def _money_str(v: float | Decimal | None, currency: str = "$") -> str:
    if v is None:
        return "—"
    n = float(v)
    sign = "-" if n < 0 else ""
    n = abs(n)
    if n >= 1_000_000:
        return f"{sign}{currency}{n/1_000_000:,.2f}M"
    if n >= 1_000:
        return f"{sign}{currency}{n/1_000:,.1f}K"
    return f"{sign}{currency}{n:,.0f}"


def _change_str(curr: float, prior: float) -> str | None:
    """`+12.4%` style change vs prior. Returns None if prior is 0."""
    if prior in (0, 0.0):
        return None
    pct = (curr - prior) / abs(prior) * 100
    sign = "+" if pct > 0 else ""
    return f"{sign}{pct:.1f}%"


def _risk_for(metric: str, value: float | None) -> str:
    """Color-code a metric. Returns 'green' | 'amber' | 'red' | 'neutral'."""
    if value is None:
        return "neutral"
    v = float(value)
    if metric == "runway_months":
        if v >= 12: return "green"
        if v >= 6:  return "amber"
        return "red"
    if metric == "dso":
        if v <= 30: return "green"
        if v <= 60: return "amber"
        return "red"
    if metric == "dpo":
        if v <= 45: return "green"
        if v <= 75: return "amber"
        return "red"
    if metric == "current_ratio":
        if v >= 1.5: return "green"
        if v >= 1.0: return "amber"
        return "red"
    if metric == "quick_ratio":
        if v >= 1.0: return "green"
        if v >= 0.7: return "amber"
        return "red"
    if metric == "ccc":  # cash conversion cycle, days; lower is better
        if v <= 30: return "green"
        if v <= 60: return "amber"
        return "red"
    if metric == "debt_to_equity":
        if v <= 1.0: return "green"
        if v <= 2.0: return "amber"
        return "red"
    if metric == "debt_to_assets":
        if v <= 0.4: return "green"
        if v <= 0.6: return "amber"
        return "red"
    if metric == "revenue_growth":  # MoM %
        if v > 2:  return "green"
        if v >= -2: return "amber"
        return "red"
    if metric == "operating_leverage":  # rev growth − expense growth, pts
        if v > 0:  return "green"
        if v >= -5: return "amber"
        return "red"
    if metric == "margin_of_safety":  # % above break-even
        if v >= 25: return "green"
        if v > 0:   return "amber"
        return "red"
    if metric == "gross_margin":
        if v >= 50: return "green"
        if v >= 30: return "amber"
        return "red"
    if metric == "net_margin":
        if v >= 15: return "green"
        if v >= 5:  return "amber"
        if v >= 0:  return "amber"
        return "red"
    if metric == "ar_aging_concentration_over_60":
        if v <= 10: return "green"
        if v <= 25: return "amber"
        return "red"
    if metric == "ap_aging_concentration_over_60":
        if v <= 10: return "green"
        if v <= 25: return "amber"
        return "red"
    if metric == "expense_change_mom":
        # absolute MoM growth — flag big swings
        if abs(v) <= 10: return "green"
        if abs(v) <= 25: return "amber"
        return "red"
    if metric == "cash_burn":  # positive = burning
        if v <= 0:  return "green"
        return "amber"
    if metric == "operating_cash_flow":
        if v > 0:  return "green"
        if v == 0: return "amber"
        return "red"
    return "neutral"


# ── snapshot loader ──────────────────────────────────────────────────────────

async def _load_snapshots(
    db: AsyncSession,
    tenant_id,
    period_ends: list[date],
) -> dict[date, list[GlBalanceSnapshot]]:
    if not period_ends:
        return {}
    rows = list((await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.period_end.in_(period_ends)
        )
    )).scalars().all())
    out: dict[date, list[GlBalanceSnapshot]] = defaultdict(list)
    for r in rows:
        out[r.period_end].append(r)
    return out


def _sum_by_types(rows: list[GlBalanceSnapshot], types: set[str]) -> Decimal:
    """Sum signed balances within the given account types (debit-positive raw)."""
    total = ZERO
    for r in rows:
        if r.account_type in types:
            total += r.balance
    return total


def _sum_by_types_presented(rows: list[GlBalanceSnapshot], types: set[str]) -> Decimal:
    """Sum, with sign flipping applied so credit-natural reads positive."""
    total = ZERO
    for r in rows:
        if r.account_type in types:
            total += _signed_presentation(r.account_type, r.balance)
    return total


def period_data_status(rows, *, synced: bool, period_end: date) -> dict:
    """Does this period have balances to report, and if not, why not?

    `_sum_by_types` over an empty list returns 0, and a screen cannot tell that
    apart from a balance that genuinely IS zero — which is how a February whose
    snapshot never saved rendered a confident "$0" for cash.

    The three ways of having nothing are different problems with different
    fixes, so each gets its own message rather than one generic string:
    never synced, synced but the balances didn't save, and synced with no bank
    accounts among them.

    A bank account sitting at zero is NOT one of these. That is a fact, and it
    must still render as $0.

    Pure, because it is the rule that decides whether the product states a
    figure or admits it doesn't have one.
    """
    period_rows = list(rows or [])
    cash_rows = [r for r in period_rows if r.account_type in CASH_TYPES]
    month = period_end.strftime("%B %Y")

    if not synced:
        reason = f"{month} hasn't been synced from QuickBooks yet."
    elif not period_rows:
        reason = (
            f"The {month} balances didn't save — the trial-balance pull failed. "
            "Re-sync the period."
        )
    elif not cash_rows:
        reason = f"No bank or cash accounts were found in the {month} balances."
    else:
        reason = None

    return {
        "synced":            synced,
        "snapshot_accounts": len(period_rows),
        "cash_accounts":     len(cash_rows),
        # False = there was nothing to total, so any cash figure is absence.
        # True with a zero total is a real, reportable zero.
        "cash_available":    bool(cash_rows),
        "reason":            reason,
    }


def history_window(
    period_end: date,
    *,
    books_start: date | None,
    max_months: int,
) -> list[date]:
    """The month-ends the Insights charts plot, oldest first.

    From the tenant's books-start month through `period_end`, because that is
    the company's actual history — a rolling six-month lookback both cut off
    everything earlier and, for a client onboarded three months ago, invented
    months that never had data.

    `max_months` is a ceiling, not a target. It bounds the snapshot query and
    keeps a 220px sparkline readable; a company with five years of books gets
    the most recent `max_months` rather than sixty points three pixels apart.

    With no books-start date (onboarding incomplete) it falls back to
    `max_months` back from `period_end` — the previous behaviour, since there
    is nothing better to anchor to.

    Never returns a month later than `period_end`, and never returns empty.
    """
    out: list[date] = []
    cursor = _last_day_of_month(period_end)
    first = _last_day_of_month(books_start) if books_start else None
    limit = max(1, max_months)
    while len(out) < limit:
        out.append(cursor)
        if first is not None and cursor <= first:
            break
        cursor = _prior_month_end(cursor)
    out.reverse()
    return out


def month_activity(
    *,
    pe: date,
    ytd_current: Decimal | None,
    prior_pe: date | None,
    ytd_prior: Decimal | None,
    is_first_period: bool = False,
) -> Decimal | None:
    """One month's P&L activity, derived from two year-to-date figures.

    Snapshots store income-statement accounts year-to-date, so a single month is
    `YTD(this month) − YTD(last month)`. That subtraction has three ways of
    being impossible, and each used to produce a confident wrong number on the
    history charts instead of an admission:

      * The month itself never synced. Summing no rows gives 0, so the month
        plotted at zero — or, once the prior was subtracted, NEGATIVE. A chart
        showing negative revenue for a month that simply wasn't pulled.

      * There is no earlier month to subtract. This was the OLDEST point on
        every chart: with nothing to subtract, it returned the raw year-to-date
        and plotted nine months of revenue as "Sep". The y-axis then scaled to
        that spike and flattened every real month beneath it.

      * The preceding month never synced, so its YTD read as 0 and this month
        absorbed the whole year before it.

    None means "not knowable", which the caller renders as a gap. Two months
    need no prior:

      * January, whose year-to-date IS the month.
      * `is_first_period` — the tenant's books-start month. Nothing precedes it
        anywhere in Nordavix (recons, close periods and schedules all begin
        there), so there is no earlier month to subtract and none is coming.

    The books-start caveat, stated plainly: when the books start mid-year AND
    the QuickBooks file carries activity earlier in the same fiscal year, that
    first month's year-to-date includes the pre-books part and reads high. Only
    that one point is affected — every later month is a difference of two
    year-to-dates, so the pre-books portion cancels out.

    Pure, because it decides whether a chart states a figure or leaves a hole.
    """
    if ytd_current is None:
        return None
    if pe.month == 1 or is_first_period:
        return ytd_current
    if prior_pe is None or ytd_prior is None:
        return None
    return ytd_current - ytd_prior


# How long a CUSTOM-WINDOW payload may be served from cache.
#
# A custom window's profit-and-loss is a live QuickBooks call, so its figures
# have no relationship to `PeriodSync.synced_at` — the only thing the staleness
# check compares. That meant a custom-window payload could never go stale: post
# entries in QuickBooks, reload the window, and Nordavix served the number it
# computed the first time, indefinitely, with a "Synced …" label that referred
# to the compute rather than the data.
#
# Fifteen minutes keeps a rapid revisit instant while bounding how wrong the
# page can be. Month-mode payloads keep the exact sync-stamp rule, which is
# strictly better than a clock where it applies.
LIVE_CACHE_TTL_SECONDS = 15 * 60


def cache_is_fresh(
    payload: dict | None,
    current_synced_at_iso: str | None,
    *,
    live_sourced: bool = False,
    computed_at: datetime | None = None,
    now: datetime | None = None,
) -> bool:
    """Does a cached Insights payload still describe the data it was built from?

    The payload is cached in `insights_snapshots` and NOTHING used to
    invalidate it, so re-syncing a period from QuickBooks — or posting
    adjusting entries and re-syncing — left Insights serving the figures from
    whenever the month was first opened, indefinitely and silently.

    Rather than clear the cache from every write path (which only works while
    every future write path remembers), the payload records the sync it was
    computed against and the read path checks it here. Self-healing beats
    disciplined.

    A payload with no stamp predates this and is treated as stale, so the first
    view after deploy recomputes once.

    The sync stamp alone is not enough. It answers "is the DATA the same", not
    "was it computed the same way" — so a cached blob survives a deploy that
    changes what compute_overview puts in it, and a corrected figure never
    reaches anyone whose period hasn't been re-synced since. INSIGHTS_PAYLOAD_VERSION
    covers that half: bump it and every cache recomputes once, on first view.
    """
    if not payload:
        return False
    if payload.get("payload_version") != INSIGHTS_PAYLOAD_VERSION:
        return False
    stamped = payload.get("source_synced_at", _MISSING_STAMP)
    if stamped is _MISSING_STAMP:
        return False
    if stamped != current_synced_at_iso:
        return False
    if live_sourced:
        # The sync stamp says nothing about live-pulled figures, so it cannot
        # be the only guard on them. Without a computed_at to age against,
        # refuse rather than assume — an unknown age is not a fresh one.
        if computed_at is None:
            return False
        age = (now or datetime.now(UTC)) - computed_at
        return age.total_seconds() <= LIVE_CACHE_TTL_SECONDS
    return True


_MISSING_STAMP = object()

# Bump whenever a change alters what compute_overview PUTS IN the payload —
# corrected arithmetic, new fields the UI depends on, a different history
# window. Not for display-only changes, which read the cached blob fine.
#
#   1 → 2: history charts derive each month against a basis month instead of
#          returning a raw year-to-date for the oldest point, and carry
#          `has_data` so unsynced months render as gaps rather than zeros.
#   2 → 3: the ProfitAndLoss parse reads only top-level sections (a nested
#          sub-group no longer overwrites its parent's total), falls back to
#          leaf sums when a section summary is blank, and recovers Other Income
#          and Other Expense. Cached revenue and margins predating this are
#          wrong figures, not merely stale ones.
#   3 → 4: the charts run from the tenant's books-start date rather than a
#          rolling six months, so a cached payload holds a shorter history and
#          month labels without the year they now need.
#   4 → 5: recommendations and management-summary lines carry an `action`, and
#          the summary lines became {text, action} objects rather than strings.
INSIGHTS_PAYLOAD_VERSION = 5


def control_account_figures(
    gl_balance: Decimal, aging_total: Decimal | None,
) -> tuple[float, float | None, float | None]:
    """(balance, aging_total, variance) for a control account — A/R or A/P.

    THE LEDGER IS THE BALANCE. Insights used to prefer the aging report's total
    and fall back to the ledger, which put it at odds with both QuickBooks'
    Balance Sheet and Nordavix's own Financial Statements. The two figures
    differ for ordinary reasons — journal entries posted to the control account
    with no customer or vendor, unapplied credits and payments, multi-currency —
    so the aging is a SUBLEDGER COMPARISON, not a substitute.

    The variance is returned rather than hidden: the gap between a control
    account and its subledger is exactly what a preparer needs to see, provided
    it is labelled as a gap instead of silently replacing the balance.

    A pure function because it is the business rule, and rules that can only be
    checked by reading the code are rules that quietly change.
    """
    balance = float(Decimal(gl_balance).quantize(Decimal("0.01")))
    if aging_total is None:
        return balance, None, None
    aging = float(Decimal(aging_total).quantize(Decimal("0.01")))
    return balance, aging, round(balance - aging, 2)


# ── live QBO aging (best-effort; degrades gracefully) ────────────────────────

_BUCKETS = ["current", "1_30", "31_60", "61_90", "over_90"]
_BUCKET_LABELS = {
    "current": "Current",
    "1_30":    "1–30",
    "31_60":   "31–60",
    "61_90":   "61–90",
    "over_90": "Over 90",
}


def _parse_aging_rows(report: dict) -> tuple[list[dict], dict[str, Decimal]]:
    """
    Return (entity_rows, bucket_totals).

    entity_rows: [{ "name", "current", "1_30", "31_60", "61_90", "over_90", "total" }]
    bucket_totals: { "current": Decimal, "1_30": ..., ..., "over_90": ... }
    """
    from modules.recons.overview import _dec, _try_titles  # local: avoid circular at import time

    rows = _flatten_report_rows(report)
    POS = {"current": 1, "1_30": 2, "31_60": 3, "61_90": 4, "over_90": 5, "total": 6}

    def cell(r: dict, key: str) -> str:
        v = _try_titles(r, key)
        if v in (None, ""):
            v = r.get(f"col_{POS[key]}", "")
        return str(v or "0")

    entity_rows: list[dict] = []
    bucket_totals: dict[str, Decimal] = {k: ZERO for k in _BUCKETS}

    for r in rows:
        name = r.get("Customer") or r.get("Vendor") or r.get("col_0", "")
        s = str(name or "").strip()
        if not s or s.upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        total = _dec(cell(r, "total"))
        if total == 0:
            continue
        per_bucket = {b: _dec(cell(r, b)) for b in _BUCKETS}
        entity_rows.append({
            "name":  s,
            **{b: _to_money(per_bucket[b]) for b in _BUCKETS},
            "total": _to_money(total),
        })
        for b in _BUCKETS:
            bucket_totals[b] += per_bucket[b]

    entity_rows.sort(key=lambda x: x["total"], reverse=True)
    return entity_rows, bucket_totals


def _last_numeric_cell(col_data: list[dict]) -> Decimal:
    """Walk a QBO row's ColData back-to-front and return the first numeric value."""
    for cell in reversed(col_data or []):
        v = (cell or {}).get("value")
        if v in (None, ""):
            continue
        try:
            return Decimal(str(v))
        except Exception:
            continue
    return ZERO


# QBO tags each top-level ProfitAndLoss section with a `group`. Older company
# files and some locales omit it, so the section header text is a fallback.
_PL_GROUP_TO_BUCKET = {
    "Income":        "revenue",
    "COGS":          "cogs",
    "Expenses":      "opex",
    "OtherIncome":   "other_income",
    "OtherExpenses": "other_expense",
    "NetIncome":     "net_income",
}
_PL_HEADER_TO_BUCKET = {
    "income":              "revenue",
    "total income":        "revenue",
    "cost of goods sold":  "cogs",
    "cost of sales":       "cogs",
    "expenses":            "opex",
    "expense":             "opex",
    "other income":        "other_income",
    "other expenses":      "other_expense",
    "other expense":       "other_expense",
    "net income":          "net_income",
}
_PL_BUCKETS = ("revenue", "cogs", "opex", "other_income", "other_expense", "net_income")


def _pl_section_bucket(row: dict) -> str | None:
    """Which P&L total this section carries, by `group` then by header text."""
    group = (row.get("group") or "").strip()
    if group in _PL_GROUP_TO_BUCKET:
        return _PL_GROUP_TO_BUCKET[group]
    header = ((row.get("Header") or {}).get("ColData") or [{}])[0].get("value") or ""
    return _PL_HEADER_TO_BUCKET.get(header.strip().lower())


def _pl_leaf_rows(row: dict) -> list[tuple[str, Decimal]]:
    """Every (name, amount) leaf beneath a section, at any depth.

    Only rows QBO marks type "Data" count. Nested Sections are containers whose
    Summary repeats their children, so summing those too would double-count.
    """
    out: list[tuple[str, Decimal]] = []

    def walk(rows: list[dict]) -> None:
        for r in rows or []:
            if (r.get("type") or "") == "Data":
                col = r.get("ColData") or []
                name = (col[0].get("value") if col else None) or ""
                amt = _last_numeric_cell(col)
                if name:
                    out.append((name, amt))
            walk((r.get("Rows") or {}).get("Row") or [])

    walk((row.get("Rows") or {}).get("Row") or [])
    return out


def _pl_section_total(row: dict, leaves: list[tuple[str, Decimal]]) -> Decimal:
    """A section's total: its own Summary, or the sum of its leaves.

    QBO normally supplies the Summary. When the amount cell is blank the old
    code took ZERO, which silently deleted a whole section — an Expenses
    section that vanished this way turned a 57% net margin into 89%.
    """
    summary = (row.get("Summary") or {}).get("ColData") or []
    has_amount = any(
        (c or {}).get("value") not in (None, "") for c in summary[1:]
    )
    if has_amount:
        return _last_numeric_cell(summary)
    return sum((amt for _n, amt in leaves), ZERO)


def _parse_pl_summary(report: dict) -> dict:
    """
    Walk a QBO ProfitAndLoss report and return:
      { revenue, cogs, opex, other_income, other_expense, net_income,
        expense_by_account: {name: Decimal}, parse_warning: str | None }

    ONLY TOP-LEVEL SECTIONS ARE READ. QBO nests sub-accounts as Sections of
    their own, and a nested one can repeat its parent's `group`. The previous
    version recursed and ASSIGNED on every match, so the last nested subtotal
    it met overwrote the section total — a company with 772,000 of income and a
    "Services" sub-group reported the sub-group's 93,400 as its revenue. The
    figure was wrong by a factor of eight and nothing on screen said so.

    `parse_warning` carries a reconciliation failure: the parts must tie to
    QBO's own Net Income. When they don't, the parse is not trustworthy and the
    caller should say so rather than render a confident margin.
    """
    totals: dict[str, Decimal] = dict.fromkeys(_PL_BUCKETS, ZERO)
    seen: set[str] = set()
    expense_by_account: dict[str, Decimal] = {}

    for row in (report.get("Rows") or {}).get("Row") or []:
        bucket = _pl_section_bucket(row)
        if bucket is None or bucket in seen:
            continue
        leaves = _pl_leaf_rows(row)
        totals[bucket] = _pl_section_total(row, leaves)
        seen.add(bucket)
        if bucket == "opex":
            for name, amt in leaves:
                if amt != 0:
                    expense_by_account[name] = expense_by_account.get(name, ZERO) + amt

    return {
        **totals,
        "expense_by_account": expense_by_account,
        "parse_warning": pl_reconciliation_warning(
            totals, net_income_found="net_income" in seen,
        ),
    }


def pl_reconciliation_warning(
    totals: dict[str, Decimal], *, net_income_found: bool,
) -> str | None:
    """Do the parsed P&L sections tie to QuickBooks' own Net Income?

    revenue − cogs − opex + other income − other expense should equal net
    income. When it doesn't, a section was missed or double-counted, and every
    figure downstream — gross margin, net margin, operating income — is built on
    it. Saying so beats rendering 89% as a fact.

    `net_income_found` is the difference between "the net income line is zero"
    and "there was no net income line". The check used to skip on a zero total,
    which conflated them — so the one case it exists for, a parse that lost a
    section, disabled the very guard meant to catch it: lose Net Income along
    with COGS and the page renders a confident 100% margin and no warning. A
    genuine break-even month is now checked like any other, and a missing line
    says the figures could not be cross-checked at all.

    Pure, so the reconciliation rule is testable without a QBO round trip.
    """
    if not net_income_found:
        # Nothing parsed at all is an empty report, not a partial one — a period
        # with no activity, or a blank response. The page renders zeros, which
        # reads as "no data" on its own; warning there would cry wolf. The
        # warning is for a PARTIAL parse: sections found, net income missing.
        if all(v == ZERO for v in totals.values()):
            return None
        return (
            "QuickBooks' profit and loss had no net income line, so the figures on "
            "this page could not be cross-checked against it. Treat the margins as "
            "indicative."
        )
    net = totals.get("net_income", ZERO)
    derived = (
        totals.get("revenue", ZERO)
        - totals.get("cogs", ZERO)
        - totals.get("opex", ZERO)
        + totals.get("other_income", ZERO)
        - totals.get("other_expense", ZERO)
    )
    drift = abs(derived - net)
    # A dollar covers rounding across sections; anything more is a lost section.
    if drift <= Decimal("1"):
        return None
    return (
        f"QuickBooks' profit and loss didn't add up as parsed: revenue less costs "
        f"gives {derived:,.2f} but QuickBooks reports net income of {net:,.2f}. "
        f"Some figures on this page may be understated."
    )


async def _fetch_pl_summary(
    conn: QboConnection | None,
    db: AsyncSession,
    period_start: date,
    period_end: date,
) -> tuple[dict | None, str | None]:
    """Return (summary, error). Either is non-null."""
    if conn is None:
        return None, ("QuickBooks isn't connected, so profit-and-loss figures for this "
                      "period fall back to saved monthly snapshots.")
    try:
        report = await _qbo_get(
            conn, db, "/reports/ProfitAndLoss",
            params={
                "start_date":        period_start.isoformat(),
                "end_date":          period_end.isoformat(),
                "accounting_method": "Accrual",
                "minorversion":      "65",
            },
        )
    except Exception:
        logger.exception("Insights P&L pull failed for [%s..%s]", period_start, period_end)
        return None, (
            f"Couldn't load the profit and loss from QuickBooks for "
            f"{period_start} to {period_end} — showing saved monthly snapshots instead."
        )
    return _parse_pl_summary(report), None


async def _fetch_aging(
    conn: QboConnection | None,
    db: AsyncSession,
    period_end: date,
    report_name: str,
) -> tuple[list[dict] | None, dict[str, Decimal] | None, str | None]:
    """
    Return (entity_rows, bucket_totals, error). Either the data tuple or
    a friendly error string is non-null.
    """
    if conn is None:
        return None, None, "QuickBooks isn't connected — connect to see aging detail."
    try:
        report = await _qbo_get(
            conn, db, f"/reports/{report_name}",
            params={"report_date": period_end.isoformat(), "aging_method": "Current"},
        )
    except Exception:
        logger.exception("Insights %s pull failed for %s", report_name, period_end)
        return None, None, f"Could not load {report_name} from QuickBooks."
    rows, totals = _parse_aging_rows(report)
    return rows, totals, None


# ── recommendation heuristics ────────────────────────────────────────────────

def act(label: str, *, section: str | None = None, href: str | None = None) -> dict:
    """Where a recommendation sends you.

    `section` jumps within Insights (the rail ids); `href` leaves for another
    module. Every recommendation gets one: naming a problem precisely and then
    leaving the reader to find it is the difference between a report and a tool.
    "36% of AR is over 60 days old" told you to escalate the 61–90 bucket and
    gave you no way to reach it, though the screen listing it already existed.
    """
    return {"label": label, "section": section, "href": href}


def _build_recommendations(payload: dict) -> list[dict]:
    """Surface 0–6 actionable recommendations based on computed KPIs."""
    recs: list[dict] = []

    liq = payload.get("liquidity", {})
    ar  = payload.get("receivables", {})
    ap  = payload.get("payables", {})
    prof = payload.get("profitability", {})
    exp = payload.get("expenses", {})

    runway = liq.get("runway_months")
    if runway is not None and runway < 6:
        recs.append({
            "priority": "high",
            "title":    "Extend runway — under 6 months left",
            "detail":   f"Cash will last about {runway:.1f} months at the current burn. "
                        "Plan a fundraise, cut discretionary spend, or accelerate collections "
                        "in the next 30–60 days.",
            "action":   act("See the cash forecast", section="cash_forecast"),
        })

    dso = ar.get("dso_days")
    if dso is not None and dso > 60:
        recs.append({
            "priority": "high",
            "title":    f"Tighten collections — DSO at {dso:.0f} days",
            "detail":   "Customers are paying slower than industry norms. Review largest "
                        "overdue accounts, send dunning, and consider offering an early-pay "
                        "discount on the top 10 receivables.",
            "action":   act("Open AR aging", href="/app/reconciliations/ar"),
        })

    over_60_pct = ar.get("aging_over_60_pct")
    if over_60_pct is not None and over_60_pct > 25:
        recs.append({
            "priority": "high",
            "title":    f"{over_60_pct:.0f}% of AR is over 60 days old",
            "detail":   "Concentration in the late-aged buckets is a leading indicator of "
                        "write-off risk. Escalate the top customers in the 61–90 and 90+ "
                        "buckets to collections.",
            "action":   act("Open AR aging", href="/app/reconciliations/ar"),
        })

    gm = prof.get("gross_margin_pct")
    gm_prev = prof.get("gross_margin_pct_prior")
    if gm is not None and gm_prev is not None and (gm_prev - gm) > 3:
        recs.append({
            "priority": "medium",
            "title":    f"Gross margin slipped {gm_prev - gm:.1f} pts MoM",
            "detail":   "Could be input cost inflation, discounting, or product mix. Pull "
                        "COGS detail by category to confirm the driver before next pricing review.",
            "action":   act("Break down expenses", section="expenses"),
        })

    nm = prof.get("net_margin_pct")
    if nm is not None and nm < 0:
        recs.append({
            "priority": "high",
            "title":    f"Operating at a {abs(nm):.1f}% net loss",
            "detail":   "Revenue isn't covering total costs. Identify the largest expense "
                        "categories and the biggest MoM movers to find quick savings.",
            "action":   act("Break down expenses", section="expenses"),
        })

    biggest_change = exp.get("biggest_mom_mover")
    if biggest_change and biggest_change.get("change_pct", 0) > 25:
        recs.append({
            "priority": "medium",
            "title":    f"{biggest_change['category']} expense up {biggest_change['change_pct']:.0f}% MoM",
            "detail":   f"Spiked from {_money_str(biggest_change['from'])} to "
                        f"{_money_str(biggest_change['to'])}. Investigate to confirm it's "
                        "intentional (e.g. one-off project) vs. recurring drift.",
            "action":   act("Explain it in flux analysis", href="/app/flux"),
        })

    ap_concentration = ap.get("aging_over_60_pct")
    if ap_concentration is not None and ap_concentration > 25:
        recs.append({
            "priority": "medium",
            "title":    f"{ap_concentration:.0f}% of AP is over 60 days past due",
            "detail":   "Stretched payables can damage supplier relationships. Prioritize "
                        "critical-vendor payments and renegotiate terms where possible.",
            "action":   act("Open AP aging", href="/app/reconciliations/ap"),
        })

    burn = liq.get("monthly_burn")
    if burn is not None and burn > 0 and runway is not None and runway >= 6:
        recs.append({
            "priority": "low",
            "title":    f"Healthy runway but burning {_money_str(burn)}/mo",
            "detail":   "Track burn closely — set a monthly target and review variances "
                        "in the close. Each percentage cut today compounds in runway.",
            "action":   act("Track burn in liquidity", section="liquidity"),
        })

    if not recs:
        recs.append({
            "priority": "low",
            "title":    "Healthy across the board",
            "detail":   "No high-priority risks flagged. Keep watching cash burn and AR "
                        "concentration as you grow.",
            "action":   act("Review liquidity", section="liquidity"),
        })

    return recs[:6]


# ── advisory layer (deterministic, number-driven) ────────────────────────────

def _build_advisory(payload: dict) -> None:
    """Attach decision-grade advisory to each section and a top management
    summary. Fully deterministic + tied to the computed numbers (no AI), so a
    CPA can audit exactly why each statement was made. Mutates `payload`."""
    liq  = payload.get("liquidity", {})
    prof = payload.get("profitability", {})
    ar   = payload.get("receivables", {})
    ap   = payload.get("payables", {})
    exp  = payload.get("expenses", {})
    cf   = payload.get("cash_forecast", {})
    bs   = payload.get("balance_sheet", {})
    gr   = payload.get("growth", {})
    be   = payload.get("breakeven", {})

    runway  = liq.get("runway_months")
    op_burn = liq.get("operating_burn") or 0.0
    op_cf   = liq.get("operating_cash_flow") or 0.0
    cash    = liq.get("cash_balance") or 0.0
    cur_r   = liq.get("current_ratio")
    wc      = liq.get("working_capital") or 0.0
    wc_prior = liq.get("working_capital_prior") or 0.0
    ncm     = liq.get("net_cash_movement") or 0.0
    ccc     = liq.get("cash_conversion_cycle")

    dso      = ar.get("dso_days")
    ar_over60 = ar.get("aging_over_60_pct")
    top_cust = (ar.get("top_customers") or [])
    top_cust0 = top_cust[0] if top_cust else None

    dpo      = ap.get("dpo_days")
    ap_over60 = ap.get("aging_over_60_pct")
    top_vend = (ap.get("top_vendors") or [])
    top_vend0 = top_vend[0] if top_vend else None

    gm       = prof.get("gross_margin_pct")
    gm_prior = prof.get("gross_margin_pct_prior")
    nm       = prof.get("net_margin_pct")
    rev_chg  = prof.get("revenue_change_str")

    # ── Liquidity & cash flow ──
    impl: list[str] = []
    if op_burn > 0 and runway is not None:
        impl.append(
            f"Operations consume about {_money_str(op_burn)}/month; with {_money_str(cash)} in the bank "
            f"that's ~{runway:.1f} months of runway."
        )
    elif op_cf >= 0:
        impl.append(f"Operations threw off ~{_money_str(op_cf)}/month of cash — you're self-funding, not burning.")
    if cur_r is not None:
        cover = "comfortably covers" if cur_r >= 1.5 else "roughly covers" if cur_r >= 1.0 else "does NOT cover"
        impl.append(f"A {cur_r:.2f}× current ratio means current assets {cover} what's due within a year.")
    if op_burn > 0 and abs(ncm - op_burn) > max(1000.0, 0.3 * op_burn):
        impl.append("The gap between operating burn and the actual change in cash is financing "
                    "(loans, raises, or owner draws) — watch it, it can mask the real operating picture.")

    actions: list[str] = []
    if runway is not None and runway < 6:
        actions.append("Start a raise or credit line NOW — these take 2–4 months to close, often longer than your runway.")
        actions.append("Freeze non-critical hiring and cut discretionary spend this month.")
        if top_cust0:
            actions.append(f"Accelerate collections — chasing {top_cust0['name']} ({_money_str(top_cust0['total'])}) directly extends runway.")
    elif runway is not None and runway < 12:
        actions.append("Build a 12-month cash forecast and set a monthly burn target reviewed at each close.")
        actions.append("Secure a credit facility while metrics are strong — cheaper than raising under pressure.")
    elif op_cf > 0:
        actions.append("You're cash-generative: deliberately split surplus between reserves, debt paydown, and growth.")
    if cur_r is not None and cur_r < 1.0:
        actions.append("Lift the current ratio above 1.0× — pull AR collection forward and slow non-critical AP.")

    watch = ["Operating-burn trend month over month — a widening burn shortens runway fast.",
             "The spread between operating burn and net cash movement (your reliance on financing)."]
    if ccc is not None:
        watch.append(f"Cash conversion cycle ({ccc:.0f} days) — each day trimmed frees working capital.")

    risks: list[str] = []
    if runway is not None and runway < 6:
        risks.append(f"Runway under 6 months ({runway:.1f}) — financing risk is the top threat right now.")
    if cur_r is not None and cur_r < 1.0:
        risks.append("Current ratio below 1.0× — exposed if a large payable comes due at once.")
    if wc < 0:
        risks.append("Negative working capital — current obligations exceed current assets.")

    liq["advisory"] = {
        "implications": " ".join(impl) or "Cash position held steady for the period.",
        "actions":      actions or ["Keep the rolling cash forecast current and review burn at each close."],
        "watch":        watch,
        "risks":        risks or ["No acute liquidity risk flagged this period."],
    }

    # ── Receivables ──
    ar_impl: list[str] = []
    if dso is not None:
        ar_impl.append(
            f"You collect in about {dso:.0f} days on average"
            + ("" if dso <= 45 else " — slower than the 30–45 day norm, so cash is sitting in receivables.")
            + ("." if dso <= 45 else "")
        )
    if ar_over60 is not None:
        ar_impl.append(f"{ar_over60:.0f}% of receivables are 60+ days old — that bucket is your write-off exposure.")
    ar_actions: list[str] = []
    if top_cust0:
        ar_actions.append(f"Call your largest balance first: {top_cust0['name']} at {_money_str(top_cust0['total'])}.")
    if dso is not None and dso > 45:
        ar_actions.append("Tighten terms: automated reminders at 7/14/30 days, and consider a 1–2% early-pay discount.")
    if ar_over60 is not None and ar_over60 > 15:
        ar_actions.append("Escalate the 90+ bucket to a payment plan or collections before it becomes a write-off.")
    ar["advisory"] = {
        "implications": " ".join(ar_impl) or "Receivables are turning over cleanly.",
        "actions":      ar_actions or ["Keep dunning current; no overdue concentration to act on."],
        "watch":        ["Customer concentration — over-reliance on one payer is a cash risk.",
                         "The 90+ day bucket (leading indicator of bad debt)."],
        "risks":        ([f"{ar_over60:.0f}% of AR is 60+ days — elevated write-off risk."] if (ar_over60 or 0) > 25 else
                         ["No acute collection risk flagged."]),
    }

    # ── Payables ──
    ap_impl: list[str] = []
    if dpo is not None:
        ap_impl.append(
            f"You pay suppliers in about {dpo:.0f} days"
            + (" — healthy use of supplier credit." if dpo <= 75 else " — stretched, which can strain relationships.")
        )
    if dso is not None and dpo is not None:
        if dpo < dso:
            ap_impl.append(f"You pay faster ({dpo:.0f}d) than you collect ({dso:.0f}d) — you're financing customers; closing that gap frees cash.")
        else:
            ap_impl.append(f"You pay slower ({dpo:.0f}d) than you collect ({dso:.0f}d) — suppliers are helping fund operations.")
    ap_actions: list[str] = []
    if op_burn > 0:
        ap_actions.append("Cash is tight: pay to terms (not early) and sequence vendors by criticality.")
    else:
        ap_actions.append("Cash is healthy: capture early-pay discounts where the implied yield beats your cash return.")
    if ap_over60 is not None and ap_over60 > 25:
        ap_actions.append("Clear or renegotiate the 60+ day payables before they damage supplier standing.")
    if top_vend0:
        ap_actions.append(f"Largest balance: {top_vend0['name']} at {_money_str(top_vend0['total'])} — confirm terms and timing.")
    ap["advisory"] = {
        "implications": " ".join(ap_impl) or "Payables are in normal range.",
        "actions":      ap_actions,
        "watch":        ["60+ day payables (supplier-relationship risk).",
                         "Whether DPO is drifting up because of cash strain vs. deliberate terms."],
        "risks":        ([f"{ap_over60:.0f}% of AP is 60+ days past due — supplier-relationship risk."] if (ap_over60 or 0) > 25 else
                         ["No acute payables risk flagged."]),
    }

    # ── Profitability ──
    pr_impl: list[str] = []
    if gm is not None:
        pr_impl.append(f"Gross margin is {gm:.0f}%"
                       + (f" ({gm - gm_prior:+.1f} pts vs prior)." if gm_prior is not None else "."))
    if nm is not None:
        pr_impl.append(f"Net margin is {nm:.0f}% — "
                       + ("profitable." if nm >= 0 else "you're spending more than you earn."))
    if rev_chg:
        pr_impl.append(f"Revenue moved {rev_chg} vs the prior period.")
    pr_actions: list[str] = []
    if gm is not None and gm_prior is not None and (gm_prior - gm) > 2:
        pr_actions.append("Investigate the margin slip — break COGS down by category to find cost inflation or discounting.")
    if nm is not None and nm < 0:
        pr_actions.append("Path to break-even: rank expenses largest-first and set a target operating-income date.")
    if not pr_actions:
        pr_actions.append("Hold the line on margin — set a floor and review pricing vs. input costs each close.")
    prof["advisory"] = {
        "implications": " ".join(pr_impl) or "Profitability is steady.",
        "actions":      pr_actions,
        "watch":        ["Gross-margin trend (early signal of pricing/cost pressure).",
                         "Operating leverage — are costs scaling slower than revenue?"],
        "risks":        (["Operating at a net loss — every month of loss draws down cash."] if (nm or 0) < 0 else
                         ["No acute profitability risk flagged."]),
    }

    # ── Expenses ──
    mover = exp.get("biggest_mom_mover")
    tops = exp.get("top_categories") or []
    ex_impl: list[str] = []
    if tops:
        ex_impl.append(f"Largest spend category is {tops[0]['category']} ({_money_str(tops[0]['amount'])}).")
    if mover:
        ex_impl.append(f"{mover['category']} moved {mover['change_pct']:+.0f}% vs prior ({_money_str(mover['from'])} → {_money_str(mover['to'])}).")
    exp["advisory"] = {
        "implications": " ".join(ex_impl) or "No outsized expense categories or swings this period.",
        "actions":      ([f"Confirm the {mover['category']} jump is intentional (one-off) vs. recurring drift."] if mover else
                         ["Review the top categories for renegotiation or consolidation opportunities."]),
        "watch":        ["Recurring vs. one-off in the biggest movers.",
                         "Subscription/vendor creep across small line items."],
        "risks":        (["A large recurring expense spike will compress margin if it sticks."] if mover else
                         ["No acute expense risk flagged."]),
    }

    # ── Cash flow forecast ──
    ooc = cf.get("out_of_cash_date")
    r_minus = cf.get("runway_minus_10")
    r_plus = cf.get("runway_plus_10")
    cf_impl = (
        f"On the current operating burn and no new financing, cash runs to zero around {ooc}."
        if ooc else "Operations are self-funding, so there's no projected cash-out date — the forecast trends flat-to-up."
    )
    cf_actions = []
    if ooc and runway is not None and runway < 9:
        cf_actions.append("Begin financing conversations now — a raise/credit line typically takes 2–4 months to close.")
        cf_actions.append("Model a downside case (revenue −20%) and pre-decide the spend cuts that extend runway.")
    elif op_cf < 0:
        cf_actions.append("Set a monthly burn ceiling and track actual-vs-target at each close to defend the forecast.")
    else:
        cf_actions.append("Build a reserve target (e.g. 6 months of operating costs) and route surplus toward it.")
    if r_minus and r_plus:
        cf_actions.append(f"Use the sensitivity: a 10% burn cut buys ~{r_minus - r_plus:.1f} extra months — make that your first lever.")
    cf["advisory"] = {
        "implications": cf_impl,
        "actions":      cf_actions,
        "watch":        ["Whether actual cash tracks the projection — drift means burn is changing.",
                         "Lumpy outflows (tax, annual renewals) that the smooth projection won't show."],
        "risks":        ([f"Projected to run low by {ooc} — financing risk."] if ooc and runway is not None and runway < 6 else
                         ["No near-term cash-out risk on the current trajectory."]),
    }

    # ── Balance sheet & solvency ──
    dte = bs.get("debt_to_equity")
    dta = bs.get("debt_to_assets")
    eq  = bs.get("equity") or 0.0
    bs_impl = []
    if dte is not None:
        lev = "conservatively financed" if dte <= 1 else "moderately leveraged" if dte <= 2 else "highly leveraged"
        bs_impl.append(f"Debt-to-equity of {dte:.2f}× means the business is {lev}.")
    if dta is not None:
        bs_impl.append(f"About {dta * 100:.0f}% of assets are financed by debt.")
    bs_impl.append(f"Net worth (equity) stands at {_money_str(eq)}" + (" — negative, a solvency red flag." if eq < 0 else "."))
    bs_actions = []
    if (dte is not None and dte > 2) or eq < 0:
        bs_actions.append("De-lever: prioritize paying down the most expensive debt and pause new borrowing.")
        bs_actions.append("Rebuild equity — retain earnings or raise before taking on more obligations.")
    elif dte is not None and dte <= 1:
        bs_actions.append("Balance sheet has room — debt is a cheaper growth lever than equity if returns beat the rate.")
    else:
        bs_actions.append("Keep leverage steady; refinance high-rate debt opportunistically.")
    bs["advisory"] = {
        "implications": " ".join(bs_impl),
        "actions":      bs_actions,
        "watch":        ["Equity trend — is net worth building or eroding each month?",
                         "Long-term debt maturities and covenant headroom."],
        "risks":        (["High leverage — limited cushion if results dip or rates rise."] if (dte or 0) > 2 else
                         ["Negative equity — balance-sheet insolvency."] if eq < 0 else
                         ["No acute solvency risk flagged."]),
    }

    # ── Growth & momentum ──
    gmom = gr.get("revenue_growth_mom")
    glev = gr.get("operating_leverage")
    grr  = gr.get("annualized_run_rate")
    gr_impl = []
    if gmom is not None:
        gr_impl.append(f"Revenue {('grew' if gmom >= 0 else 'fell')} {abs(gmom):.1f}% month over month.")
    if grr:
        gr_impl.append(f"That annualizes to a ~{_money_str(grr)} run-rate.")
    if glev is not None:
        gr_impl.append("Costs are growing " + ("slower than revenue — you're getting operating leverage." if glev >= 0
                       else "faster than revenue — operating leverage is negative."))
    gr_actions = []
    if glev is not None and glev < 0:
        gr_actions.append("Reset cost growth below revenue growth — freeze additions until the lines re-cross.")
    if gmom is not None and gmom < 0:
        gr_actions.append("Diagnose the decline: churn, pricing, seasonality, or pipeline — then target the biggest driver.")
    if not gr_actions:
        gr_actions.append("Momentum is constructive — reinvest into the channels that are compounding.")
    gr["advisory"] = {
        "implications": " ".join(gr_impl) or "Not enough history to read momentum yet.",
        "actions":      gr_actions,
        "watch":        ["The 3-month trend, not single-month spikes.",
                         "Operating leverage — costs must scale slower than revenue to reach profitability."],
        "risks":        (["Revenue is contracting — a strategic, not just operational, concern."] if (gmom or 0) < -2 else
                         ["No acute growth risk flagged."]),
    }

    # ── Break-even & margin of safety ──
    mos = be.get("margin_of_safety_pct")
    bev = be.get("break_even_revenue")
    cmp_ = be.get("contribution_margin_pct")
    be_impl = []
    if bev is not None:
        be_impl.append(f"You break even at about {_money_str(bev)} of revenue.")
    if mos is not None:
        be_impl.append(
            f"Current revenue sits {mos:+.0f}% {'above' if mos >= 0 else 'below'} that line"
            + (" — a comfortable cushion." if mos >= 25 else " — a thin cushion." if mos >= 0 else " — you're below break-even.")
        )
    be_actions = []
    if mos is not None and mos < 0:
        be_actions.append("Close the gap to break-even: lead with price/mix (it flows straight to contribution), then trim fixed costs.")
    elif mos is not None and mos < 25:
        be_actions.append("Widen the cushion — a few points of contribution margin move break-even down materially.")
    else:
        be_actions.append("Healthy buffer — you can invest behind growth without risking a loss month.")
    if cmp_ is not None and cmp_ < 40:
        be_actions.append(f"Contribution margin is {cmp_:.0f}% — review pricing and direct-cost inputs to lift it.")
    be["advisory"] = {
        "implications": " ".join(be_impl) or "Need positive gross margin to compute a break-even point.",
        "actions":      be_actions,
        "watch":        ["Fixed-cost creep — it raises the break-even bar every month.",
                         "Contribution margin — the lever that moves break-even fastest."],
        "risks":        (["Operating below break-even — every period at this level is a loss."] if (mos is not None and mos < 0) else
                         ["No acute break-even risk flagged."]),
    }

    # ── Management summary (composite health) ──
    score = 0
    if runway is None and op_cf >= 0:
        score += 25
    elif runway is not None:
        score += 25 if runway >= 12 else 15 if runway >= 6 else 5
    if nm is None:
        score += 12
    else:
        score += 25 if nm >= 15 else 18 if nm >= 5 else 10 if nm >= 0 else 3
    score += 12 if dso is None else (15 if dso <= 30 else 10 if dso <= 60 else 4)
    score += 12 if cur_r is None else (20 if cur_r >= 1.5 else 12 if cur_r >= 1.0 else 4)
    score += 12 if ar_over60 is None else (15 if ar_over60 <= 10 else 9 if ar_over60 <= 25 else 3)
    score = min(100, score)
    health = "strong" if score >= 70 else "watch" if score >= 45 else "at_risk"

    if runway is not None and runway < 6:
        headline = f"Cash is the priority — about {runway:.1f} months of runway at the current operating burn."
    elif nm is not None and nm < 0:
        headline = "Profitability is the priority — the business is running at a net loss this period."
    elif health == "strong":
        headline = "Financially healthy — protect the position and deploy surplus deliberately."
    else:
        headline = "Generally stable with a few areas to tighten this month."

    # Every summary line is {text, action}. They were bare strings, so the
    # sharpest reading in the product — "AR concentration in 60+ days (36%)" —
    # was somewhere to read and nowhere to click. A strength needs no action;
    # a thing to fix or watch does.
    def item(text: str, action: dict | None = None) -> dict:
        return {"text": text, "action": action}

    strengths: list[dict] = []
    if runway is None and op_cf >= 0: strengths.append(item("Operations are cash-generative."))
    if runway is not None and runway >= 12: strengths.append(item(f"Strong runway ({runway:.0f}+ months)."))
    if nm is not None and nm >= 10: strengths.append(item(f"Healthy net margin ({nm:.0f}%)."))
    if cur_r is not None and cur_r >= 1.5: strengths.append(item(f"Solid liquidity (current ratio {cur_r:.2f}×)."))
    if dso is not None and dso <= 30: strengths.append(item(f"Fast collections (DSO {dso:.0f} days)."))
    if wc > 0 and wc >= wc_prior: strengths.append(item("Positive, growing working capital."))

    watch_items: list[dict] = []
    if runway is not None and runway < 12:
        watch_items.append(item(f"Runway: ~{runway:.1f} months.",
                                act("See the cash forecast", section="cash_forecast")))
    if nm is not None and nm < 5:
        watch_items.append(item(f"Thin/negative net margin ({nm:.0f}%).",
                                act("Break down expenses", section="expenses")))
    if dso is not None and dso > 45:
        watch_items.append(item(f"Slow collections (DSO {dso:.0f} days).",
                                act("Open AR aging", href="/app/reconciliations/ar")))
    if cur_r is not None and cur_r < 1.0:
        watch_items.append(item(f"Tight liquidity (current ratio {cur_r:.2f}×).",
                                act("Review liquidity", section="liquidity")))
    if (ar_over60 or 0) > 25:
        watch_items.append(item(f"AR concentration in 60+ days ({ar_over60:.0f}%).",
                                act("Open AR aging", href="/app/reconciliations/ar")))

    # Priority moves = the high/medium recommendations, top 3. They carry the
    # recommendation's own action, so the summary and the risk list agree on
    # where a problem is solved rather than each deciding separately.
    recs = payload.get("recommendations", [])
    priorities = [
        item(r["title"], r.get("action"))
        for r in recs if r.get("priority") in ("high", "medium")
    ][:3]

    payload["management_summary"] = {
        "headline":    headline,
        "health":      health,            # strong | watch | at_risk
        "score":       score,             # 0–100
        "priorities":  priorities or [item("Maintain the close cadence and keep the cash forecast current.")],
        "strengths":   strengths or [item("Books are synced and current.")],
        "watch_items": watch_items or [item("Nothing flagged for active monitoring this period.")],
    }


# ── main entry point ─────────────────────────────────────────────────────────

async def compute_overview(
    db: AsyncSession,
    tenant_id,
    period_end: date,
    *,
    period_start: date | None = None,
    # Ceiling on how many months the charts plot, not a fixed lookback.
    # Generous: books rarely predate the product by three years, and the
    # cap exists to bound the snapshot query and keep a sparkline legible.
    months_history: int = 36,
) -> dict[str, Any]:
    """
    Compute the full insights blob for the requested period_end.

    Returns a JSON-ready dict. Sections that have no data degrade
    gracefully (None / empty arrays + a friendly error string).
    """
    # ── Period scaffolding ──────────────────────────────────────────────────
    # The charts run from the tenant's BOOKS START, not a rolling six months.
    # A fixed lookback hides the beginning of the company's own history and,
    # for a client onboarded three months ago, invented four months of window
    # that never had data. books_start_date is where every other module already
    # begins — recons, close periods, schedules — so the graphs begin there too.
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    books_start = tenant.books_start_date if tenant else None
    first_period = _last_day_of_month(books_start) if books_start else None

    period_ends = history_window(
        period_end, books_start=books_start, max_months=months_history,
    )
    # One month MORE than the history shows, when there is one. A month's P&L
    # activity is its year-to-date minus the previous month's, so the oldest
    # DISPLAYED point needs a month behind it to subtract. Without that basis
    # month it returned its raw year-to-date and the charts plotted nine months
    # of revenue as "Sep" — a spike that rescaled the axis and flattened every
    # real month beside it. The books-start month is the one exception: nothing
    # precedes it, so month_activity takes its year-to-date directly.
    if not period_ends:
        period_ends = [period_end]
    # "May" twice on one axis is ambiguous once the window spans a year
    # boundary, which a books-start-anchored window routinely does.
    _multi_year = period_ends[0].year != period_ends[-1].year
    def _pt_label(p: date) -> str:
        return p.strftime("%b %y") if _multi_year else p.strftime("%b")
    basis = _prior_month_end(period_ends[0])
    charts_start_at_books = first_period is not None and period_ends[0] <= first_period
    if not charts_start_at_books:
        period_ends = [basis, *period_ends]
        history_ends = period_ends[1:]
    else:
        history_ends = list(period_ends)
    prior_pe = period_ends[-2] if len(period_ends) > 1 else None

    # Is the requested window exactly one calendar month? Month-mode selections
    # send a period_start too, so a start date alone does not mean "custom" —
    # only a window that isn't a whole month does. Computed here because the KPI
    # labels below need it, not just the period label at the end.
    is_full_month = (
        period_start is not None
        and period_start.day == 1
        and period_start.year == period_end.year
        and period_start.month == period_end.month
        and period_end == _last_day_of_month(period_end)
    )
    custom_range_active = period_start is not None and not is_full_month

    # Exact length of the window the P&L numbers cover — used so DSO/DPO/DIO
    # annualize against the RIGHT number of days. A custom range uses its real
    # inclusive day count; month mode uses the actual calendar-month length
    # (28–31) rather than a hardcoded 30.
    if period_start is not None:
        days_in_period = max(1, (period_end - period_start).days + 1)
    else:
        days_in_period = calendar.monthrange(period_end.year, period_end.month)[1]
    days_dec = Decimal(days_in_period)

    snaps_by_pe = await _load_snapshots(db, tenant_id, period_ends)
    period_syncs = list((await db.execute(
        select(PeriodSync).where(PeriodSync.period_end.in_(period_ends))
    )).scalars().all())
    sync_by_pe = {ps.period_end: ps for ps in period_syncs}

    # QBO connection (best-effort)
    qbo_conn = (await db.execute(select(QboConnection))).scalars().first()

    # Custom range: pull a live P&L for the exact window. Overrides the
    # snapshot-diff P&L numbers (which always span calendar months).
    #
    # We ALSO pull a comparable prior-period P&L (same length, immediately
    # preceding the custom range) so the "vs prior" KPI insights stay
    # meaningful. Without this second pull, the code falls back to the
    # last calendar-month snapshot — which is the wrong length AND often
    # doesn't exist for custom ranges, so the UI showed "First period —
    # no prior comparison available" even when QBO had the data.
    custom_pl: dict | None = None
    custom_pl_prior: dict | None = None
    custom_pl_error: str | None = None
    # Set when the selected window loaded but its comparative did not: the prior
    # column is then genuinely unknown, not zero and not last calendar month.
    custom_prior_unavailable = False
    if period_start is not None:
        custom_pl, custom_pl_error = await _fetch_pl_summary(qbo_conn, db, period_start, period_end)
        # Same-length window immediately preceding. (period_end - period_start)
        # gives days-between; we add 1 to get inclusive day count, then mirror
        # that span backwards from the day before period_start.
        custom_span_days = (period_end - period_start).days
        custom_prior_end   = period_start - timedelta(days=1)
        custom_prior_start = custom_prior_end - timedelta(days=custom_span_days)
        custom_pl_prior, custom_prior_error = await _fetch_pl_summary(
            qbo_conn, db, custom_prior_start, custom_prior_end,
        )
        # The two windows are separate QBO calls and can fail independently. If
        # the selected window loaded but its comparative didn't, the code below
        # would fall back to the prior CALENDAR MONTH — so a quarter would be
        # compared against one month and the change % stated as fact. Drop the
        # comparison instead, and say why.
        #
        # The prior call's error used to be discarded outright (`, _ =`), which
        # is what made that silent.
        # A parse that doesn't tie to QuickBooks' own net income means a section was
    # missed; every margin below is built on it, so it must not render silently.
    if custom_pl is not None and custom_pl.get("parse_warning"):
        logger.error(
            "Insights: ProfitAndLoss parse did not reconcile for [%s..%s] — %s",
            period_start, period_end, custom_pl["parse_warning"],
        )
        custom_pl_error = custom_pl["parse_warning"]

    if custom_pl is not None and custom_pl_prior is None:
            logger.warning(
                "Insights: selected window [%s..%s] loaded but its comparative "
                "[%s..%s] did not — suppressing the prior comparison rather than "
                "falling back to a calendar month of a different length.",
                period_start, period_end, custom_prior_start, custom_prior_end,
            )
            custom_prior_unavailable = True
            if not custom_pl_error:
                custom_pl_error = (
                    custom_prior_error
                    or "Could not load the comparative period from QuickBooks."
                ) + " Figures for the selected window are correct; the change vs prior is hidden."

    # ── What data actually exists for this period ────────────────────────────
    # `_sum_by_types` over an empty list returns 0, and a screen cannot tell
    # that apart from a balance that genuinely IS zero. Cash rendered as "$0"
    # for a month whose balances never saved reads as a fact rather than a gap.
    # Count what we have so the UI can say "—, not synced" instead.
    data_status = period_data_status(
        snaps_by_pe.get(period_end, []),
        synced=period_end in sync_by_pe,
        period_end=period_end,
    )

    # ── Liquidity & cash flow ─────────────────────────────────────────────────
    def cash_at(pe: date) -> Decimal:
        return _sum_by_types(snaps_by_pe.get(pe, []), CASH_TYPES)

    cash_balance = cash_at(period_end)
    cash_prior   = cash_at(prior_pe) if prior_pe else ZERO

    # Net cash movement: average monthly change in TOTAL cash (last 3 deltas,
    # positive = cash shrinking). This is the literal bank-balance trend; it
    # includes financing (a raise/loan inflates it), so we surface it as a
    # transparent secondary figure — runway is driven by OPERATING burn below.
    cash_deltas: list[Decimal] = []
    for i in range(max(0, len(period_ends) - 4), len(period_ends)):
        if i == 0:
            continue
        cash_deltas.append(cash_at(period_ends[i - 1]) - cash_at(period_ends[i]))
    net_cash_movement = sum(cash_deltas) / len(cash_deltas) if cash_deltas else ZERO

    # YTD net income (presentation). Matches financials/internal.py so the
    # Insights and Financials pages reconcile.
    def ytd_ni(pe: date) -> Decimal:
        rows = snaps_by_pe.get(pe, [])
        return (
            _sum_by_types_presented(rows, INCOME_TYPES)
            - _sum_by_types_presented(rows, COGS_TYPES)
            - _sum_by_types_presented(rows, EXPENSE_TYPES)
            + _sum_by_types_presented(rows, OTHER_INCOME_TYPES)
            - _sum_by_types_presented(rows, OTHER_EXPENSE_TYPES)
        )

    def ytd_depreciation(pe: date) -> Decimal:
        """YTD depreciation / amortization expense (presentation-positive)."""
        total = ZERO
        for r in snaps_by_pe.get(pe, []):
            if r.account_type in (EXPENSE_TYPES | OTHER_EXPENSE_TYPES) and _is_depreciation(r.account_name):
                total += _signed_presentation(r.account_type, r.balance)
        return total

    def _prior_same_year(pe: date) -> date | None:
        """The latest loaded month before `pe` in the same fiscal year — the one
        whose year-to-date gets subtracted to isolate `pe`'s own activity."""
        prior = None
        for p in period_ends:
            if p < pe and p.year == pe.year:
                prior = p
        return prior

    def _ytd_or_none(p: date | None, ytd_func) -> Decimal | None:
        """A month's year-to-date figure, or None when that month has no
        snapshot at all. Summing zero rows gives 0, and 0 is indistinguishable
        from a real zero once it reaches a chart."""
        if p is None or not snaps_by_pe.get(p):
            return None
        return ytd_func(p)

    def month_opt(pe: date, ytd_func) -> Decimal | None:
        """This month's activity, or None when it cannot be derived."""
        prior = _prior_same_year(pe)
        return month_activity(
            pe=pe,
            ytd_current=_ytd_or_none(pe, ytd_func),
            prior_pe=prior,
            ytd_prior=_ytd_or_none(prior, ytd_func),
            is_first_period=first_period is not None and pe == first_period,
        )

    def _month_diff(pe: date, ytd_func) -> Decimal:
        """Scalar form for the KPI arithmetic: unknowable reads as zero. The
        history builders use month_opt instead, so a gap stays a gap there."""
        v = month_opt(pe, ytd_func)
        return v if v is not None else ZERO

    def monthly_ni(pe: date) -> Decimal:
        return _month_diff(pe, ytd_ni)

    # Balance-sheet working-capital magnitudes (presentation-positive).
    def wc_at(pe: date, types: set[str], *, presented: bool) -> Decimal:
        rows = snaps_by_pe.get(pe, [])
        return _sum_by_types_presented(rows, types) if presented else _sum_by_types(rows, types)

    def _prior_in_list(pe: date) -> date | None:
        idx = period_ends.index(pe) if pe in period_ends else -1
        return period_ends[idx - 1] if idx > 0 else None

    def monthly_ocf(pe: date) -> Decimal | None:
        """Indirect-method operating cash flow for the month ending at pe:

          OCF = Net income
              + Depreciation / amortization        (non-cash add-back)
              - Δ Accounts receivable              (a rise ties up cash)
              - Δ Other current assets             (inventory, prepaids)
              + Δ Accounts payable                 (a rise defers an outflow)
              + Δ Other current liabilities        (accrued, deferred rev, CC)

        Δ is between this month-end and the prior month-end snapshot. Returns
        None when there is no prior snapshot to difference against.
        """
        pp = _prior_in_list(pe)
        if pp is None:
            return None
        ni  = monthly_ni(pe)
        dep = _month_diff(pe, ytd_depreciation)
        d_ar  = wc_at(pe, AR_TYPES, presented=False)                   - wc_at(pp, AR_TYPES, presented=False)
        d_oca = wc_at(pe, OTHER_CURRENT_ASSET_TYPES, presented=False)  - wc_at(pp, OTHER_CURRENT_ASSET_TYPES, presented=False)
        d_ap  = wc_at(pe, AP_TYPES, presented=True)                    - wc_at(pp, AP_TYPES, presented=True)
        d_ocl = wc_at(pe, OTHER_CURRENT_LIAB_TYPES, presented=True)    - wc_at(pp, OTHER_CURRENT_LIAB_TYPES, presented=True)
        return ni + dep - d_ar - d_oca + d_ap + d_ocl

    # Trailing operating cash flow + burn rate (3-mo average of months w/ data).
    ocf_series = [(p, monthly_ocf(p)) for p in history_ends]
    recent_ocf = [v for _, v in ocf_series[-3:] if v is not None]
    avg_monthly_ocf = sum(recent_ocf) / len(recent_ocf) if recent_ocf else ZERO
    operating_burn = -avg_monthly_ocf if avg_monthly_ocf < 0 else ZERO  # positive = burning

    runway_months: float | None
    if operating_burn <= 0:
        runway_months = None                       # operations generate cash
    elif cash_balance <= 0:
        runway_months = 0.0
    else:
        runway_months = float((cash_balance / operating_burn).quantize(Decimal("0.1")))

    # Headline OCF KPI: the selected month's OCF when we have clean month-end
    # snapshots; the trailing monthly average for custom windows (no endpoint
    # snapshots) — clearly labelled so it's never a mislabelled number.
    ocf_this = monthly_ocf(period_end)
    ocf_display = ocf_this if (ocf_this is not None and period_start is None) else avg_monthly_ocf

    # Liquidity ratios (point-in-time at period_end).
    current_assets = wc_at(period_end, CURRENT_ASSET_TYPES, presented=False)
    current_liabs  = wc_at(period_end, CURRENT_LIAB_TYPES, presented=True)
    quick_assets   = cash_balance + wc_at(period_end, AR_TYPES, presented=False)
    current_ratio  = float((current_assets / current_liabs).quantize(Decimal("0.01"))) if current_liabs > 0 else None
    quick_ratio    = float((quick_assets / current_liabs).quantize(Decimal("0.01"))) if current_liabs > 0 else None
    working_capital = current_assets - current_liabs
    wc_prior = (
        wc_at(prior_pe, CURRENT_ASSET_TYPES, presented=False)
        - wc_at(prior_pe, CURRENT_LIAB_TYPES, presented=True)
    ) if prior_pe else ZERO

    # `has_data` marks a month with no snapshot. cash_at() sums zero rows to 0,
    # which plotted as a real balance of nothing — a false trough between two
    # months that were merely unsynced.
    cash_history = [
        {
            "period":   p.isoformat(),
            "label":    _pt_label(p),
            "cash":     _to_money(cash_at(p)),
            "ocf":      _to_money(v if v is not None else ZERO),
            "has_data": bool(snaps_by_pe.get(p)),
        }
        for p, v in ocf_series
    ]

    runway_value = (
        f"{runway_months:.1f} months" if runway_months is not None
        else ("Cash-generative" if operating_burn <= 0 else "—")
    )
    liquidity = {
        "cash_balance":          _to_money(cash_balance),
        "cash_balance_prior":    _to_money(cash_prior),
        "cash_change_str":       _change_str(_to_money(cash_balance), _to_money(cash_prior)),
        "operating_burn":        _to_money(operating_burn),
        "net_cash_movement":     _to_money(net_cash_movement),
        "monthly_burn":          _to_money(operating_burn),   # back-compat alias
        "runway_months":         runway_months,
        "operating_cash_flow":   _to_money(ocf_display),
        "current_ratio":         current_ratio,
        "quick_ratio":           quick_ratio,
        "working_capital":       _to_money(working_capital),
        "working_capital_prior": _to_money(wc_prior),
        "cash_conversion_cycle": None,   # filled after AR/AP/inventory below
        "dio_days":              None,
        "history":               cash_history,
        "kpis": [
            {
                "kpi":     "Cash balance",
                # Same rule as the hero tile: with no bank rows there is
                # nothing to total, and "$0" would assert a balance we do not
                # have. The section view must not disagree with the tile.
                "value":   (
                    _money_str(cash_balance) if data_status["cash_available"] else "—"
                ),
                "risk":    "neutral",
                "insight": (
                    (
                        f"Total bank/cash at {period_end.isoformat()}."
                        + (f" {_change_str(float(cash_balance), float(cash_prior))} vs prior month."
                           if cash_prior else "")
                    )
                    if data_status["cash_available"]
                    else (data_status["reason"] or "No bank or cash balances for this period.")
                ),
            },
            {
                "kpi":     "Cash runway",
                "value":   runway_value,
                "risk":    _risk_for("runway_months", runway_months) if runway_months is not None else "green",
                "insight": (
                    f"At the recent operating burn of {_money_str(operating_burn)}/mo, cash lasts "
                    f"~{runway_months:.1f} months. Under 6 = act now, 6–12 = plan, 12+ = healthy."
                    if runway_months is not None
                    else "Operations are generating cash — no runway constraint at this trajectory."
                ),
            },
            {
                "kpi":     "Operating burn (3-mo avg)",
                "value":   _money_str(operating_burn) + "/mo" if operating_burn > 0 else "Cash-generative",
                "risk":    _risk_for("cash_burn", float(operating_burn)),
                "insight": (
                    "Cash consumed by OPERATIONS per month (income + non-cash add-backs ± "
                    "working-capital swings). Excludes loans/raises so a financing inflow "
                    "can't hide an operating burn."
                    if operating_burn > 0
                    else "Operations threw off cash on average over the last 3 months."
                ),
            },
            {
                "kpi":     "Operating cash flow" + ("" if period_start is None else " (3-mo avg)"),
                "value":   _money_str(ocf_display),
                "risk":    _risk_for("operating_cash_flow", float(ocf_display)),
                "insight": (
                    "Indirect method: net income + depreciation − ΔAR − ΔInventory + ΔAP "
                    "+ Δaccrued/deferred. Positive = operations self-fund; negative = the "
                    "gap you're covering from the bank."
                ),
            },
            {
                "kpi":     "Net cash movement (3-mo avg)",
                "value":   (_money_str(-net_cash_movement) + "/mo") if net_cash_movement != 0 else "Flat",
                "risk":    "neutral",
                "insight": (
                    "Actual average change in the bank balance — INCLUDES financing (loans, "
                    "raises, owner draws). Compare to operating burn: a gap means financing "
                    "is moving cash, not the business."
                ),
            },
            {
                "kpi":     "Current ratio",
                "value":   f"{current_ratio:.2f}×" if current_ratio is not None else "—",
                "risk":    _risk_for("current_ratio", current_ratio),
                "insight": (
                    "Current assets ÷ current liabilities. ≥1.5 comfortable, 1.0–1.5 monitor, "
                    "<1.0 means short-term obligations exceed liquid assets."
                    if current_ratio is not None else "No current liabilities to measure against."
                ),
            },
            {
                "kpi":     "Quick ratio (acid test)",
                "value":   f"{quick_ratio:.2f}×" if quick_ratio is not None else "—",
                "risk":    _risk_for("quick_ratio", quick_ratio),
                "insight": (
                    "(Cash + receivables) ÷ current liabilities — can you cover what's due "
                    "without selling inventory? ≥1.0 is healthy."
                    if quick_ratio is not None else "No current liabilities to measure against."
                ),
            },
            {
                "kpi":     "Working capital",
                "value":   _money_str(working_capital),
                "risk":    "green" if working_capital > 0 else "red",
                "insight": (
                    "Current assets − current liabilities = the buffer funding day-to-day "
                    "operations."
                    + (f" {_change_str(_to_money(working_capital), _to_money(wc_prior))} vs prior month."
                       if wc_prior else "")
                ),
            },
        ],
    }

    # ── Profitability ───────────────────────────────────────────────────────
    # GAAP separation: Revenue = Income (operating top-line only);
    # Other Income / Other Expense sit below Operating Income on the P&L.
    def revenue_at(pe: date) -> Decimal:
        return _sum_by_types_presented(snaps_by_pe.get(pe, []), INCOME_TYPES)

    def cogs_at(pe: date) -> Decimal:
        return _sum_by_types_presented(snaps_by_pe.get(pe, []), COGS_TYPES)

    def opex_at(pe: date) -> Decimal:
        return _sum_by_types_presented(snaps_by_pe.get(pe, []), EXPENSE_TYPES)

    def other_income_at(pe: date) -> Decimal:
        return _sum_by_types_presented(snaps_by_pe.get(pe, []), OTHER_INCOME_TYPES)

    def other_expense_at(pe: date) -> Decimal:
        return _sum_by_types_presented(snaps_by_pe.get(pe, []), OTHER_EXPENSE_TYPES)

    def direct_expense_in_opex_at(pe: date) -> Decimal:
        """Sum of Expense-typed accounts that count as 'direct' (excludes COGS,
        which is already a separate bucket). Used to peel direct costs out of
        OpEx so GP can include them."""
        total = ZERO
        for r in snaps_by_pe.get(pe, []):
            if r.account_type in EXPENSE_TYPES and _is_direct_expense(
                r.account_type, r.account_name, r.account_number,
            ):
                total += _signed_presentation(r.account_type, r.balance)
        return total

    def direct_expense_accounts_at(pe: date) -> list[tuple[str, Decimal]]:
        """For transparency: which Expense accounts are being treated as direct."""
        out: list[tuple[str, Decimal]] = []
        # We want the monthly delta, not YTD — find the prior period in the same year.
        prior_p = None
        for p in period_ends:
            if p < pe and p.year == pe.year:
                prior_p = p
        prior_map: dict[str, Decimal] = {}
        if prior_p:
            for r in snaps_by_pe.get(prior_p, []):
                if r.account_type in EXPENSE_TYPES and _is_direct_expense(
                    r.account_type, r.account_name, r.account_number,
                ):
                    prior_map[r.account_name] = _signed_presentation(r.account_type, r.balance)
        for r in snaps_by_pe.get(pe, []):
            if r.account_type in EXPENSE_TYPES and _is_direct_expense(
                r.account_type, r.account_name, r.account_number,
            ):
                ytd = _signed_presentation(r.account_type, r.balance)
                prev = prior_map.get(r.account_name, ZERO) if pe.month != 1 else ZERO
                monthly = ytd - prev
                if monthly != 0:
                    out.append((r.account_name, monthly))
        out.sort(key=lambda x: abs(x[1]), reverse=True)
        return out

    # Was a second, independent copy of the month-diff logic — and carried the
    # same year-to-date-as-a-month bug. One implementation now.
    monthly_metric = _month_diff

    # P&L for the requested window. If period_start was provided AND the live
    # QBO call succeeded, use those exact numbers; otherwise fall back to the
    # snapshot-diff over the calendar month containing period_end.
    direct_expense_accounts: list[dict] = []

    if custom_pl is not None:
        revenue_month = custom_pl["revenue"]
        cogs_month    = custom_pl["cogs"]
        opex_total    = custom_pl["opex"]
        # Classify each expense account from the live P&L. Account numbers
        # aren't on the P&L report so we fall back to name keywords; if we
        # have a snapshot at period_end we look the account_number up there.
        snap_number_by_name: dict[str, str | None] = {}
        for r in snaps_by_pe.get(period_end, []):
            if r.account_type in EXPENSE_TYPES:
                snap_number_by_name[r.account_name] = r.account_number
        direct_in_opex = ZERO
        for name, amt in custom_pl["expense_by_account"].items():
            num = snap_number_by_name.get(name)
            if _is_direct_expense("Expense", name, num):
                direct_in_opex += amt
                direct_expense_accounts.append({"name": name, "amount": _to_money(amt)})
        opex_month    = opex_total - direct_in_opex  # indirect OpEx only
        direct_expenses_month = cogs_month + direct_in_opex
        gross_profit  = revenue_month - direct_expenses_month
        operating_inc = gross_profit - opex_month
        # Other Income / Other Expense are parsed from their own sections now.
        # They used to be hardcoded to zero on this path and net_other derived
        # by subtraction, so the two lines always read $0 for a custom window
        # however much sat in them.
        other_income_month  = custom_pl["other_income"]
        other_expense_month = custom_pl["other_expense"]
        net_other           = other_income_month - other_expense_month
        # QBO's own NetIncome is authoritative when present; it already includes
        # the Other lines.
        net_income    = custom_pl["net_income"] or (operating_inc + net_other)
    else:
        revenue_month       = monthly_metric(period_end, revenue_at)
        cogs_month          = monthly_metric(period_end, cogs_at)
        opex_total          = monthly_metric(period_end, opex_at)
        direct_in_opex      = monthly_metric(period_end, direct_expense_in_opex_at)
        other_income_month  = monthly_metric(period_end, other_income_at)
        other_expense_month = monthly_metric(period_end, other_expense_at)
        opex_month          = opex_total - direct_in_opex  # indirect OpEx only
        direct_expenses_month = cogs_month + direct_in_opex
        gross_profit        = revenue_month - direct_expenses_month
        operating_inc       = gross_profit - opex_month
        net_other           = other_income_month - other_expense_month
        net_income          = operating_inc + net_other
        # Surface which Expense accounts got classified as direct
        direct_expense_accounts = [
            {"name": nm, "amount": _to_money(amt)}
            for nm, amt in direct_expense_accounts_at(period_end)
        ]

    gm_pct = _to_pct(gross_profit, revenue_month)
    op_pct = _to_pct(operating_inc, revenue_month)
    nm_pct = _to_pct(net_income, revenue_month)

    # Prior-period comparison.
    #   - Custom range  → use the same-length window from QBO (apples-to-apples).
    #   - Standard month → fall back to the prior calendar month from snapshots.
    if custom_pl_prior is not None:
        revenue_prior = custom_pl_prior["revenue"]
        gp_prior      = custom_pl_prior["revenue"] - custom_pl_prior["cogs"]
        gm_pct_prior  = _to_pct(gp_prior, revenue_prior) if revenue_prior else None
    elif custom_prior_unavailable:
        # Comparing a custom window against a calendar month of a different
        # length is worse than not comparing: the change % looks authoritative
        # and is arithmetic on two different things.
        revenue_prior = ZERO
        gp_prior      = ZERO
        gm_pct_prior  = None
    else:
        revenue_prior = monthly_metric(prior_pe, revenue_at) if prior_pe else ZERO
        gp_prior      = monthly_metric(prior_pe, revenue_at) - monthly_metric(prior_pe, cogs_at) if prior_pe else ZERO
        gm_pct_prior  = _to_pct(gp_prior, revenue_prior) if prior_pe else None

    # Pre-compute per-period monthly P&L so the history sparkline is consistent
    # and we don't recompute the same diffs four times per row.
    def per_period_pl(p: date) -> dict:
        # month_opt, not monthly_metric: a month that cannot be derived must
        # reach the chart as a gap, not as a zero the reader takes for a fact.
        rev_opt = month_opt(p, revenue_at)
        known   = rev_opt is not None
        rev  = rev_opt if known else ZERO
        cogs = monthly_metric(p, cogs_at)
        opex = monthly_metric(p, opex_at)
        oi   = monthly_metric(p, other_income_at)
        oe   = monthly_metric(p, other_expense_at)
        gp   = rev - cogs
        oi_excl_other = gp - opex  # Operating Income
        ni   = oi_excl_other + (oi - oe)
        return {
            "period":   p.isoformat(),
            "label":    _pt_label(p),
            "revenue":  _to_money(rev),
            "gp":       _to_money(gp),
            "ni":       _to_money(ni),
            "has_data": known,
        }

    revenue_history = [per_period_pl(p) for p in history_ends]

    profitability = {
        "revenue":              _to_money(revenue_month),
        "revenue_prior":        _to_money(revenue_prior),
        "revenue_change_str":   _change_str(_to_money(revenue_month), _to_money(revenue_prior)),
        "cogs":                 _to_money(cogs_month),
        "direct_expenses_extra": _to_money(direct_in_opex),
        "direct_expenses_total": _to_money(cogs_month + direct_in_opex),
        "direct_expense_accounts": direct_expense_accounts,
        "gross_profit":         _to_money(gross_profit),
        "gross_margin_pct":     gm_pct,
        "gross_margin_pct_prior": gm_pct_prior,
        "operating_expenses":   _to_money(opex_month),
        "operating_income":     _to_money(operating_inc),
        "operating_margin_pct": op_pct,
        "other_income":         _to_money(other_income_month),
        "other_expense":        _to_money(other_expense_month),
        "net_other":            _to_money(net_other),
        "net_income":           _to_money(net_income),
        "net_margin_pct":       nm_pct,
        "history":              revenue_history,
        "kpis": [
            {
                # "(month)" was hardcoded, so a Mar 1–15 window or a quarter was
                # still labelled a month while showing that window's figure.
                "kpi":     "Revenue (selected window)" if custom_range_active else "Revenue (month)",
                "value":   _money_str(revenue_month),
                "risk":    "neutral",
                "insight": (
                    # Custom range comparisons are vs the same-length window
                    # immediately preceding; standard month comparisons are
                    # vs the prior calendar month. Phrase accordingly.
                    f"{_change_str(_to_money(revenue_month), _to_money(revenue_prior))} "
                    f"vs prior {'period' if custom_pl is not None else 'month'}."
                    if revenue_prior
                    else (
                        # Distinguish "there is no prior" from "the prior failed
                        # to load" — the second is a fixable, retryable state and
                        # calling it "first period" sends the reader nowhere.
                        "The comparative period couldn't be loaded from QuickBooks, "
                        "so the change vs prior is hidden. The figure itself is correct."
                        if custom_prior_unavailable
                        else "First period — no prior comparison available."
                    )
                ),
            },
            {
                "kpi":     "Direct expenses (COGS + direct costs)",
                "value":   _money_str(cogs_month + direct_in_opex),
                "risk":    "neutral",
                "insight": (
                    f"COGS {_money_str(cogs_month)} + "
                    f"{len(direct_expense_accounts)} direct-cost account"
                    f"{'s' if len(direct_expense_accounts) != 1 else ''} "
                    f"from OpEx ({_money_str(direct_in_opex)}). "
                    + (f"Direct accounts: {', '.join(a['name'] for a in direct_expense_accounts[:3])}"
                       + (f' (+{len(direct_expense_accounts) - 3} more)' if len(direct_expense_accounts) > 3 else '')
                       + ". Classification: account # 5xxx OR direct-cost keywords."
                       if direct_expense_accounts else
                       "No Expense accounts matched the direct-cost heuristic (5xxx number OR keywords).")
                ),
            },
            {
                "kpi":     "Gross profit",
                "value":   _money_str(gross_profit),
                "risk":    _risk_for("gross_margin", gm_pct) if gm_pct is not None else "neutral",
                "insight": (
                    f"Margin {gm_pct:.1f}%. Revenue − (COGS + direct expenses). "
                    + ("Industry-healthy for most software/services." if (gm_pct or 0) >= 60
                       else "Watch input cost and discounting." if (gm_pct or 0) >= 30
                       else "Sub-30% margin — pricing or COGS efficiency needs review.")
                    if gm_pct is not None else "No revenue this period — margin not meaningful."
                ),
            },
            {
                "kpi":     "Operating expenses (indirect)",
                "value":   _money_str(opex_month),
                "risk":    "neutral",
                "insight": (
                    "Overhead expenses below the GP line — SG&A, rent, salaries "
                    "not tied to specific revenue."
                ),
            },
            {
                "kpi":     "Operating income",
                "value":   _money_str(operating_inc),
                "risk":    _risk_for("net_margin", op_pct) if op_pct is not None else "neutral",
                "insight": (
                    f"Operating margin {op_pct:.1f}%. Revenue − COGS − Operating expenses."
                    if op_pct is not None else "Cannot compute margin without revenue."
                ),
            },
            {
                "kpi":     "Other income / (expense), net",
                "value":   _money_str(net_other),
                "risk":    "neutral",
                "insight": (
                    f"Other income {_money_str(other_income_month)} less other expense "
                    f"{_money_str(other_expense_month)}. Sits below Operating Income — "
                    "interest, gains/losses, FX, etc."
                    if (other_income_month or other_expense_month)
                    else "No non-operating income or expense recorded this period."
                ),
            },
            {
                "kpi":     "Net income",
                "value":   _money_str(net_income),
                "risk":    _risk_for("net_margin", nm_pct) if nm_pct is not None else "neutral",
                "insight": (
                    "Negative — burning operating cash."
                    if (nm_pct or 0) < 0
                    else "Positive — generating accounting profit; check OCF for cash conversion."
                ),
            },
        ],
    }

    # ── AR + receivables ────────────────────────────────────────────────────
    # THE LEDGER IS THE BALANCE. This used to prefer the A/R Aging Summary
    # total and fall back to the GL, which made Insights disagree with both
    # QuickBooks' Balance Sheet and Nordavix's own Financial Statements — the
    # aging report and the A/R control account routinely differ in real books
    # (journal entries posted to A/R with no customer, unapplied credits and
    # payments, multi-currency).
    #
    # The aging total is still reported, beside the balance rather than in
    # place of it, with the difference named. That gap is genuinely useful
    # information to a preparer — but only when it is labelled as a subledger
    # variance instead of silently replacing the balance.
    ar_balance_gl = _sum_by_types(snaps_by_pe.get(period_end, []), AR_TYPES)
    ar_aging_sync = sync_by_pe[period_end].ar_aging_total if period_end in sync_by_pe else None
    ar_balance, ar_aging_total, ar_aging_variance = control_account_figures(
        ar_balance_gl, ar_aging_sync,
    )

    # DSO = AR ÷ (revenue for the period ÷ days in the period). Uses the exact
    # window length so a custom range or a 28/31-day month is measured correctly.
    dso_days: float | None
    if revenue_month and revenue_month > 0:
        dso_days = float((Decimal(ar_balance) / (revenue_month / days_dec)).quantize(Decimal("0.1")))
    else:
        dso_days = None

    # Live aging detail (best effort)
    ar_rows, ar_bucket_totals, ar_err = await _fetch_aging(qbo_conn, db, period_end, "AgedReceivables")
    aging_summary: list[dict] = []
    aging_over_60_pct: float | None = None
    if ar_bucket_totals:
        total_aging = sum(ar_bucket_totals.values()) or ZERO
        for b in _BUCKETS:
            amt = ar_bucket_totals.get(b, ZERO)
            pct = _to_pct(amt, total_aging) or 0.0
            aging_summary.append({
                "bucket": _BUCKET_LABELS[b],
                "amount": _to_money(amt),
                "pct":    pct,
            })
        over_60 = ar_bucket_totals["61_90"] + ar_bucket_totals["over_90"]
        aging_over_60_pct = _to_pct(over_60, total_aging)
    top_customers = (ar_rows or [])[:5]

    receivables = {
        "ar_balance":         ar_balance,
        # Subledger comparison — the aging total and how far it sits from the
        # control account. Null when the period was never synced.
        "ar_aging_total":     ar_aging_total,
        "ar_aging_variance":  ar_aging_variance,
        "balance_source":     "General ledger (A/R control account)",
        "dso_days":           dso_days,
        "aging":              aging_summary,
        "aging_over_60_pct":  aging_over_60_pct,
        "top_customers":      top_customers,
        "qbo_error":          ar_err,
        "kpis": [
            {
                "kpi":     "AR balance",
                "value":   _money_str(ar_balance),
                "risk":    "neutral",
                "insight": (
                    "Total receivables owed at period end, per the general "
                    "ledger — the same figure as the Balance Sheet."
                    + (
                        f" The A/R aging totals {_money_str(ar_aging_total)}, "
                        f"a {_money_str(abs(ar_aging_variance))} difference to "
                        "review."
                        if ar_aging_variance is not None
                        and abs(ar_aging_variance) >= 0.01
                        else ""
                    )
                ),
            },
            {
                "kpi":     "DSO (Days Sales Outstanding)",
                "value":   f"{dso_days:.0f} days" if dso_days is not None else "—",
                "risk":    _risk_for("dso", dso_days),
                "insight": (
                    "≤30 = strong; 30–60 = monitor; >60 = collections need attention."
                    if dso_days is not None else "Need revenue to compute DSO."
                ),
            },
            {
                "kpi":     "Concentration in 60+ day buckets",
                "value":   f"{aging_over_60_pct:.0f}%" if aging_over_60_pct is not None else "—",
                "risk":    _risk_for("ar_aging_concentration_over_60", aging_over_60_pct),
                "insight": (
                    "Higher = more write-off risk and longer cash conversion."
                    if aging_over_60_pct is not None
                    else (ar_err or "Aging detail unavailable.")
                ),
            },
            {
                "kpi":     "Top overdue customer",
                "value":   (top_customers[0]["name"] if top_customers else "—"),
                "risk":    "neutral",
                "insight": (
                    f"{_money_str(top_customers[0]['total'])} outstanding"
                    if top_customers else "No detail available — connect QBO or sync this period."
                ),
            },
        ],
    }

    # ── AP + payables ───────────────────────────────────────────────────────
    # Ledger first, aging alongside — same reasoning as A/R above.
    ap_balance_gl = _sum_by_types_presented(snaps_by_pe.get(period_end, []), AP_TYPES)
    ap_aging_sync = sync_by_pe[period_end].ap_aging_total if period_end in sync_by_pe else None
    ap_balance, ap_aging_total, ap_aging_variance = control_account_figures(
        ap_balance_gl, ap_aging_sync,
    )

    # DPO = AP ÷ (COGS for the period ÷ days in the period).
    dpo_days: float | None
    if cogs_month and cogs_month > 0:
        dpo_days = float((Decimal(ap_balance) / (cogs_month / days_dec)).quantize(Decimal("0.1")))
    else:
        dpo_days = None

    ap_rows, ap_bucket_totals, ap_err = await _fetch_aging(qbo_conn, db, period_end, "AgedPayables")
    ap_aging_summary: list[dict] = []
    ap_aging_over_60_pct: float | None = None
    if ap_bucket_totals:
        total_aging = sum(ap_bucket_totals.values()) or ZERO
        for b in _BUCKETS:
            amt = ap_bucket_totals.get(b, ZERO)
            pct = _to_pct(amt, total_aging) or 0.0
            ap_aging_summary.append({
                "bucket": _BUCKET_LABELS[b],
                "amount": _to_money(amt),
                "pct":    pct,
            })
        over_60 = ap_bucket_totals["61_90"] + ap_bucket_totals["over_90"]
        ap_aging_over_60_pct = _to_pct(over_60, total_aging)
    top_vendors = (ap_rows or [])[:5]

    # AP payment lag proxy: weighted avg age (in bucket midpoints) of outstanding AP
    payment_lag: float | None = None
    if ap_bucket_totals and sum(ap_bucket_totals.values()) > 0:
        weights = {"current": 15, "1_30": 30, "31_60": 45, "61_90": 75, "over_90": 120}
        total = sum(ap_bucket_totals.values())
        weighted = sum(float(ap_bucket_totals[b]) * weights[b] for b in _BUCKETS)
        payment_lag = round(weighted / float(total), 1)

    payables = {
        "ap_balance":           ap_balance,
        "ap_aging_total":       ap_aging_total,
        "ap_aging_variance":    ap_aging_variance,
        "balance_source":       "General ledger (A/P control account)",
        "dpo_days":             dpo_days,
        "aging":                ap_aging_summary,
        "aging_over_60_pct":    ap_aging_over_60_pct,
        "top_vendors":          top_vendors,
        "payment_lag_days":     payment_lag,
        "qbo_error":            ap_err,
        "kpis": [
            {
                "kpi":     "AP balance",
                "value":   _money_str(ap_balance),
                "risk":    "neutral",
                "insight": (
                    "Total payables owed at period end, per the general "
                    "ledger — the same figure as the Balance Sheet."
                    + (
                        f" The A/P aging totals {_money_str(ap_aging_total)}, "
                        f"a {_money_str(abs(ap_aging_variance))} difference to "
                        "review."
                        if ap_aging_variance is not None
                        and abs(ap_aging_variance) >= 0.01
                        else ""
                    )
                ),
            },
            {
                "kpi":     "DPO (Days Payable Outstanding)",
                "value":   f"{dpo_days:.0f} days" if dpo_days is not None else "—",
                "risk":    _risk_for("dpo", dpo_days),
                "insight": (
                    "≤45 = strong supplier standing; 45–75 = monitor; >75 = stretched payables."
                    if dpo_days is not None else "Need COGS to compute DPO."
                ),
            },
            {
                "kpi":     "Average payment lag",
                "value":   f"{payment_lag:.0f} days" if payment_lag is not None else "—",
                "risk":    _risk_for("dpo", payment_lag) if payment_lag is not None else "neutral",
                "insight": (
                    "Weighted average age of outstanding invoices. Mirrors DPO when paying on time."
                    if payment_lag is not None else (ap_err or "Aging detail unavailable.")
                ),
            },
            {
                "kpi":     "Top owed vendor",
                "value":   (top_vendors[0]["name"] if top_vendors else "—"),
                "risk":    "neutral",
                "insight": (
                    f"{_money_str(top_vendors[0]['total'])} outstanding"
                    if top_vendors else "No detail available — connect QBO or sync this period."
                ),
            },
        ],
    }

    # ── Cash conversion cycle (CCC = DSO + DIO − DPO) ─────────────────────────
    # Days cash is tied up: time to collect (DSO) + time inventory sits (DIO)
    # − time you take to pay suppliers (DPO). Lower/negative = customers and
    # suppliers fund your working capital. Injected back into the liquidity blob.
    inventory_balance = ZERO
    for r in snaps_by_pe.get(period_end, []):
        if r.account_type in OTHER_CURRENT_ASSET_TYPES and _is_inventory(r.account_name):
            inventory_balance += _signed_presentation(r.account_type, r.balance)
    dio_days: float | None = None
    if cogs_month and cogs_month > 0 and inventory_balance > 0:
        dio_days = float((inventory_balance / (cogs_month / days_dec)).quantize(Decimal("0.1")))
    ccc_days: float | None = None
    if dso_days is not None and dpo_days is not None:
        ccc_days = round(dso_days + (dio_days or 0.0) - dpo_days, 1)
    liquidity["cash_conversion_cycle"] = ccc_days
    liquidity["dio_days"] = dio_days
    if ccc_days is not None:
        liquidity["kpis"].append({
            "kpi":     "Cash conversion cycle",
            "value":   f"{ccc_days:.0f} days",
            "risk":    _risk_for("ccc", ccc_days),
            "insight": (
                f"DSO {dso_days:.0f}" + (f" + DIO {dio_days:.0f}" if dio_days else "")
                + f" − DPO {dpo_days:.0f}. Days cash is locked in working capital between "
                "paying suppliers and collecting from customers. Lower (or negative) is better."
            ),
        })

    # ── Expense monitoring ─────────────────────────────────────────────────
    # "Where did the money go?" — covers OpEx + COGS + Other Expense
    # (interest, fees, losses, …). All three are cash outflows the user
    # wants to monitor in the close review.
    EXP_BREAKDOWN_TYPES = ALL_EXPENSE_TYPES

    def expense_rows(pe: date) -> dict[str, Decimal]:
        """{ account_name → monthly expense magnitude }"""
        prior = None
        for p in period_ends:
            if p < pe and p.year == pe.year:
                prior = p
        prior_snaps = snaps_by_pe.get(prior, []) if prior else []
        prior_map: dict[str, Decimal] = {}
        for r in prior_snaps:
            if r.account_type in EXP_BREAKDOWN_TYPES:
                prior_map[r.account_name] = _signed_presentation(r.account_type, r.balance)

        result: dict[str, Decimal] = {}
        for r in snaps_by_pe.get(pe, []):
            if r.account_type in EXP_BREAKDOWN_TYPES:
                ytd = _signed_presentation(r.account_type, r.balance)
                prev = prior_map.get(r.account_name, ZERO) if pe.month != 1 else ZERO
                result[r.account_name] = ytd - prev
        return result

    # When a custom range is in play, the live QBO P&L gives us exact
    # expense-by-account totals for the window — use those instead of the
    # snapshot-based monthly diff. MoM context (prev_exp) still comes
    # from snapshots: it's "this window vs prior calendar month" only
    # when the window is a calendar month, otherwise we hide the change.
    curr_exp = custom_pl["expense_by_account"] if custom_pl is not None else expense_rows(period_end)
    prev_exp = expense_rows(prior_pe) if (prior_pe and custom_pl is None) else {}

    by_category_list: list[dict] = []
    biggest_mover: dict | None = None
    for name, curr_val in curr_exp.items():
        prev_val = prev_exp.get(name, ZERO)
        change_pct = _to_pct(curr_val - prev_val, prev_val) if prev_val else None
        row = {
            "category":     name,
            "amount":       _to_money(curr_val),
            "prior_amount": _to_money(prev_val),
            "change_pct":   change_pct,
        }
        by_category_list.append(row)
        if change_pct is not None and abs(change_pct) > (biggest_mover["change_pct"] if biggest_mover else 25):
            biggest_mover = {
                "category":    name,
                "from":        _to_money(prev_val),
                "to":          _to_money(curr_val),
                "change_pct":  change_pct,
            }

    by_category_list.sort(key=lambda x: abs(x["amount"]), reverse=True)
    top_categories = by_category_list[:8]
    top_movers = sorted(
        [r for r in by_category_list if r["change_pct"] is not None],
        key=lambda r: abs(r["change_pct"]),
        reverse=True,
    )[:5]

    total_expenses_month = sum((c["amount"] for c in by_category_list), 0.0)

    expenses = {
        "total_expenses":   total_expenses_month,
        "top_categories":   top_categories,
        "top_movers":       top_movers,
        "biggest_mom_mover": biggest_mover,
        "kpis": [
            {
                "kpi":     "Total expenses (all categories)",
                "value":   _money_str(total_expenses_month),
                "risk":    "neutral",
                "insight": "All cash outflows: COGS + Operating expenses + Other expenses (interest, FX losses, etc.) for the period.",
            },
            {
                "kpi":     "Largest expense category",
                "value":   (top_categories[0]["category"] if top_categories else "—"),
                "risk":    "neutral",
                "insight": (
                    f"{_money_str(top_categories[0]['amount'])} — "
                    f"{(top_categories[0]['amount']/total_expenses_month*100):.0f}% of total"
                    if top_categories and total_expenses_month > 0 else "No expense data this period."
                ),
            },
            {
                "kpi":     "Biggest month-over-month mover",
                "value":   (biggest_mover["category"] if biggest_mover else "—"),
                "risk":    _risk_for("expense_change_mom", biggest_mover["change_pct"]) if biggest_mover else "green",
                "insight": (
                    f"{biggest_mover['change_pct']:+.0f}% vs prior month."
                    if biggest_mover else "All categories within ±25% of prior month — no major spikes."
                ),
            },
        ],
    }

    # ── Cash flow forecast (forward projection at operating burn) ─────────────
    HORIZON = 6
    burn = operating_burn  # Decimal; positive = burning
    cf_points = [
        {"month": _add_months(period_end, n).strftime("%b %Y"),
         "projected_cash": _to_money(cash_balance - burn * n)}
        for n in range(0, HORIZON + 1)
    ]
    out_of_cash_label = None
    if burn > 0 and cash_balance > 0 and runway_months is not None:
        out_of_cash_label = _add_months(period_end, int(runway_months)).strftime("%b %Y")

    def _runway_at(b: Decimal) -> float | None:
        return float((cash_balance / b).quantize(Decimal("0.1"))) if (b > 0 and cash_balance > 0) else None
    runway_slower = _runway_at(burn * Decimal("0.9")) if burn > 0 else None   # cut burn 10%
    runway_faster = _runway_at(burn * Decimal("1.1")) if burn > 0 else None   # burn rises 10%
    cash_3 = cash_balance - burn * 3
    cash_6 = cash_balance - burn * 6
    cash_forecast = {
        "horizon_months":     HORIZON,
        "out_of_cash_date":   out_of_cash_label,
        "projected_cash_3mo": _to_money(cash_3),
        "projected_cash_6mo": _to_money(cash_6),
        "runway_minus_10":    runway_slower,
        "runway_plus_10":     runway_faster,
        "points":             cf_points,
        "kpis": [
            {"kpi": "Out of cash by",
             "value": out_of_cash_label or ("Self-funding" if burn <= 0 else "—"),
             "risk": _risk_for("runway_months", runway_months) if runway_months is not None else "green",
             "insight": (f"At {_money_str(burn)}/mo operating burn — and assuming no new financing — cash reaches "
                         f"zero around {out_of_cash_label}. Line up funding well before this."
                         if out_of_cash_label else "Operations fund themselves — no projected cash-out date.")},
            {"kpi": "Projected cash in 3 months", "value": _money_str(cash_3),
             "risk": "red" if cash_3 <= 0 else ("amber" if burn > 0 else "green"),
             "insight": "Bank balance in 3 months if the burn rate holds and you raise nothing."},
            {"kpi": "Projected cash in 6 months", "value": _money_str(cash_6),
             "risk": "red" if cash_6 <= 0 else ("amber" if burn > 0 else "green"),
             "insight": "Bank balance in 6 months on the same assumptions."},
            {"kpi": "Burn sensitivity (±10%)",
             "value": (f"{runway_faster:.1f}–{runway_slower:.1f} mo" if (runway_faster and runway_slower) else "—"),
             "risk": "neutral",
             "insight": (f"Trim burn 10% → ~{runway_slower:.1f} months; let it drift up 10% → ~{runway_faster:.1f} months. "
                         "Small operating changes compound into real runway."
                         if (runway_faster and runway_slower) else "No burn to flex — operations are cash-generative.")},
        ],
    }

    # ── Balance sheet & solvency ──────────────────────────────────────────────
    def _equity_at(p: date) -> Decimal:
        rows = snaps_by_pe.get(p, [])
        return _sum_by_types(rows, ASSET_TYPES) - _sum_by_types_presented(rows, LIAB_TYPES)
    bs_rows = snaps_by_pe.get(period_end, [])
    total_assets = _sum_by_types(bs_rows, ASSET_TYPES)
    total_liabilities = _sum_by_types_presented(bs_rows, LIAB_TYPES)
    equity_nw = total_assets - total_liabilities
    long_term_liab = _sum_by_types_presented(bs_rows, {"Long Term Liability"})
    d_to_e = float((total_liabilities / equity_nw).quantize(Decimal("0.01"))) if equity_nw > 0 else None
    d_to_a = float((total_liabilities / total_assets).quantize(Decimal("0.001"))) if total_assets > 0 else None
    equity_history = [
        {"period": p.isoformat(), "label": _pt_label(p),
         "equity": _to_money(_equity_at(p)), "has_data": bool(snaps_by_pe.get(p))}
        for p in history_ends
    ]
    eq_prior = _equity_at(prior_pe) if prior_pe else ZERO
    balance_sheet = {
        "total_assets":          _to_money(total_assets),
        "total_liabilities":     _to_money(total_liabilities),
        "equity":                _to_money(equity_nw),
        "long_term_liabilities": _to_money(long_term_liab),
        "debt_to_equity":        d_to_e,
        "debt_to_assets":        d_to_a,
        "equity_history":        equity_history,
        "kpis": [
            {"kpi": "Total assets", "value": _money_str(total_assets), "risk": "neutral",
             "insight": "Everything the business owns at period end (cash, receivables, inventory, fixed assets)."},
            {"kpi": "Total liabilities", "value": _money_str(total_liabilities), "risk": "neutral",
             "insight": "Everything the business owes — payables, credit cards, loans, accruals."},
            {"kpi": "Equity (net worth)", "value": _money_str(equity_nw),
             "risk": "green" if equity_nw > 0 else "red",
             "insight": ("Assets − liabilities — the owners' stake."
                         + (f" {_change_str(_to_money(equity_nw), _to_money(eq_prior))} vs prior month." if eq_prior else "")
                         if equity_nw > 0 else "Negative — liabilities exceed assets (balance-sheet insolvency).")},
            {"kpi": "Debt-to-equity", "value": f"{d_to_e:.2f}×" if d_to_e is not None else "—",
             "risk": _risk_for("debt_to_equity", d_to_e),
             "insight": ("Liabilities ÷ equity. ≤1 conservative, 1–2 moderate, >2 highly leveraged."
                         if d_to_e is not None else "No positive equity to measure leverage against.")},
            {"kpi": "Debt-to-assets", "value": f"{d_to_a * 100:.0f}%" if d_to_a is not None else "—",
             "risk": _risk_for("debt_to_assets", d_to_a),
             "insight": ("Share of assets financed by debt. <40% conservative, >60% leveraged."
                         if d_to_a is not None else "No assets to measure against.")},
        ],
    }

    # ── Growth & momentum ─────────────────────────────────────────────────────
    rev_vals = [float(h["revenue"]) for h in revenue_history]   # ascending
    rev_now  = rev_vals[-1] if rev_vals else 0.0
    rev_prev = rev_vals[-2] if len(rev_vals) > 1 else 0.0
    rev_growth_mom = _to_pct(Decimal(str(rev_now - rev_prev)), Decimal(str(rev_prev))) if rev_prev else None
    last3, prev3 = rev_vals[-3:], rev_vals[-6:-3]
    avg_last3 = sum(last3) / len(last3) if last3 else 0.0
    avg_prev3 = sum(prev3) / len(prev3) if prev3 else 0.0
    trend3_growth = _to_pct(Decimal(str(avg_last3 - avg_prev3)), Decimal(str(avg_prev3))) if avg_prev3 else None
    run_rate = float((Decimal(str(revenue_month)) / days_dec * Decimal(365)).quantize(Decimal("0.01")))
    prev_total_exp = float(sum(prev_exp.values())) if prev_exp else 0.0
    exp_growth_mom = _to_pct(Decimal(str(total_expenses_month - prev_total_exp)), Decimal(str(prev_total_exp))) if prev_total_exp else None
    op_leverage = round(rev_growth_mom - exp_growth_mom, 1) if (rev_growth_mom is not None and exp_growth_mom is not None) else None
    growth = {
        "revenue_growth_mom":   rev_growth_mom,
        "trend_3mo_growth":     trend3_growth,
        "annualized_run_rate":  run_rate,
        "expense_growth_mom":   exp_growth_mom,
        "operating_leverage":   op_leverage,
        "history":              revenue_history,
        "kpis": [
            {"kpi": "Revenue growth (MoM)",
             "value": f"{rev_growth_mom:+.1f}%" if rev_growth_mom is not None else "—",
             "risk": _risk_for("revenue_growth", rev_growth_mom),
             "insight": ("Month-over-month top-line change. The momentum signal — sustained negative growth is a strategic flag."
                         if rev_growth_mom is not None else "Need a prior period to measure growth.")},
            {"kpi": "3-month trend",
             "value": f"{trend3_growth:+.1f}%" if trend3_growth is not None else "—",
             "risk": _risk_for("revenue_growth", trend3_growth),
             "insight": "Trailing-3-month average vs the prior 3 months — smooths out one-off spikes."},
            {"kpi": "Annualized run-rate", "value": _money_str(run_rate), "risk": "neutral",
             "insight": "This period's revenue projected to a full year — the headline number for planning and valuation."},
            {"kpi": "Operating leverage",
             "value": f"{op_leverage:+.1f} pts" if op_leverage is not None else "—",
             "risk": _risk_for("operating_leverage", op_leverage),
             "insight": ("Revenue growth − expense growth. Positive = revenue outpacing costs (you're scaling); "
                         "negative = spending faster than you're growing."
                         if op_leverage is not None else "Need prior-period revenue + expense to compute.")},
        ],
    }

    # ── Break-even & margin of safety ─────────────────────────────────────────
    cm_ratio = (gm_pct / 100.0) if gm_pct is not None else None       # contribution-margin ratio ≈ gross margin
    fixed_costs = float(opex_month) + float(other_expense_month)      # indirect OpEx + other expense
    break_even_rev = (fixed_costs / cm_ratio) if (cm_ratio and cm_ratio > 0) else None
    rev_f = float(revenue_month)
    mos_pct = round((rev_f - break_even_rev) / rev_f * 100, 1) if (break_even_rev is not None and rev_f > 0) else None
    breakeven = {
        "break_even_revenue":      _to_money(break_even_rev) if break_even_rev is not None else None,
        "margin_of_safety_pct":    mos_pct,
        "contribution_margin_pct": gm_pct,
        "fixed_costs":             _to_money(fixed_costs),
        "current_revenue":         _to_money(revenue_month),
        "kpis": [
            {"kpi": "Break-even revenue",
             "value": _money_str(break_even_rev) if break_even_rev is not None else "—",
             "risk": "neutral",
             "insight": ("Revenue needed to cover all costs = fixed costs ÷ contribution margin. "
                         "Below this you lose money; above it, every dollar drops to profit faster."
                         if break_even_rev is not None else "Gross margin must be positive to compute a break-even.")},
            {"kpi": "Margin of safety",
             "value": f"{mos_pct:+.0f}%" if mos_pct is not None else "—",
             "risk": _risk_for("margin_of_safety", mos_pct),
             "insight": ("How far current revenue sits above break-even. The cushion before you'd swing to a loss — "
                         "the bigger the safer."
                         if mos_pct is not None else "Need a break-even point to measure the cushion.")},
            {"kpi": "Contribution margin",
             "value": f"{gm_pct:.0f}%" if gm_pct is not None else "—",
             "risk": _risk_for("gross_margin", gm_pct),
             "insight": "Share of each revenue dollar left after direct costs to cover fixed costs + profit. "
                        "Your main pricing/cost lever — a few points move break-even a lot."},
            {"kpi": "Fixed costs (this period)", "value": _money_str(fixed_costs), "risk": "neutral",
             "insight": "Indirect operating + other expenses — the nut you must cover regardless of sales volume."},
        ],
    }

    # Period label: month-year when the range is exactly one calendar
    # month (so "January 2026" stays readable for Month-mode selections),
    # otherwise a date-range string for true custom windows.
    if is_full_month:
        period_label = period_end.strftime("%B %Y")
    elif period_start is not None:
        period_label = f"{period_start.strftime('%b %d, %Y')} – {period_end.strftime('%b %d, %Y')}"
    else:
        period_label = period_end.strftime("%B %Y")

    payload = {
        # Lets cache_is_fresh retire blobs computed by superseded logic, not
        # just blobs built from superseded data.
        "payload_version": INSIGHTS_PAYLOAD_VERSION,
        "period_end":     period_end.isoformat(),
        "period_start":   period_start.isoformat() if period_start else None,
        "period_label":   period_label,
        # `custom_range` reflects whether this is a TRUE custom window
        # (not aligned to a calendar month). Frontend uses this to decide
        # whether to show the "custom-range fallback" banner.
        "custom_range":   custom_range_active,
        "is_full_month":  is_full_month,
        "custom_pl_error": custom_pl_error,
        # Whether the period has balances to report at all — lets the UI show a
        # reason instead of a confident zero.
        "data_status":    data_status,
        "liquidity":      liquidity,
        "cash_forecast":  cash_forecast,
        "balance_sheet":  balance_sheet,
        "growth":         growth,
        "breakeven":      breakeven,
        "receivables":    receivables,
        "payables":       payables,
        "profitability":  profitability,
        "expenses":       expenses,
        "qbo_connected":  qbo_conn is not None,
        # STALENESS KEY. The whole payload is cached in `insights_snapshots`,
        # and nothing used to invalidate it — so a period re-synced from
        # QuickBooks kept serving the figures computed the first time anyone
        # opened it. Recording the sync this compute was based on lets the
        # reader detect that by itself, rather than relying on every future
        # write path remembering to clear a cache.
        "source_synced_at": (
            sync_by_pe[period_end].synced_at.isoformat()
            if period_end in sync_by_pe and sync_by_pe[period_end].synced_at
            else None
        ),
    }

    payload["recommendations"] = _build_recommendations(payload)
    # Decision-grade advisory per section + a top management summary. Reads the
    # recommendations (for the priority list) so it must run after them.
    _build_advisory(payload)
    return payload
