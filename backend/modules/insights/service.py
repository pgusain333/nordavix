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
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.gl_balance_snapshot import GlBalanceSnapshot
from models.period_sync import PeriodSync
from models.qbo_connection import QboConnection
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


def _parse_pl_summary(report: dict) -> dict:
    """
    Walk a QBO ProfitAndLoss report and return:
      { revenue, cogs, opex, net_income, expense_by_account: {name: Decimal} }

    The report nests group totals (Income / COGS / Expenses / NetIncome).
    For each group we read the Summary.ColData last numeric cell. For
    Expenses we also collect every leaf account so the Insights page
    can show top-categories + MoM movers over the custom range.
    """
    totals = {"revenue": ZERO, "cogs": ZERO, "opex": ZERO, "net_income": ZERO}
    expense_by_account: dict[str, Decimal] = {}

    def walk(rows: list[dict], inside_expenses: bool = False) -> None:
        for r in rows:
            group = r.get("group") or ""
            row_type = r.get("type") or ""
            summary = (r.get("Summary") or {}).get("ColData") or []

            if group == "Income":
                totals["revenue"] = _last_numeric_cell(summary)
            elif group == "COGS":
                totals["cogs"] = _last_numeric_cell(summary)
            elif group == "Expenses":
                totals["opex"] = _last_numeric_cell(summary)
            elif group == "NetIncome":
                totals["net_income"] = _last_numeric_cell(summary)

            # Collect leaf expense accounts when we're inside the Expenses section.
            if inside_expenses and row_type == "Data":
                col = r.get("ColData") or []
                name = (col[0].get("value") if col else None) or ""
                amt = _last_numeric_cell(col)
                if name and amt != 0:
                    expense_by_account[name] = expense_by_account.get(name, ZERO) + amt

            nested = (r.get("Rows") or {}).get("Row") or []
            if nested:
                walk(nested, inside_expenses=inside_expenses or group == "Expenses")

    walk((report.get("Rows") or {}).get("Row") or [])
    return {**totals, "expense_by_account": expense_by_account}


async def _fetch_pl_summary(
    conn: QboConnection | None,
    db: AsyncSession,
    period_start: date,
    period_end: date,
) -> tuple[dict | None, str | None]:
    """Return (summary, error). Either is non-null."""
    if conn is None:
        return None, "QuickBooks isn't connected — can't compute P&L for the custom range."
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
        return None, f"Could not load ProfitAndLoss from QuickBooks for {period_start} to {period_end}."
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
        })

    dso = ar.get("dso_days")
    if dso is not None and dso > 60:
        recs.append({
            "priority": "high",
            "title":    f"Tighten collections — DSO at {dso:.0f} days",
            "detail":   "Customers are paying slower than industry norms. Review largest "
                        "overdue accounts, send dunning, and consider offering an early-pay "
                        "discount on the top 10 receivables.",
        })

    over_60_pct = ar.get("aging_over_60_pct")
    if over_60_pct is not None and over_60_pct > 25:
        recs.append({
            "priority": "high",
            "title":    f"{over_60_pct:.0f}% of AR is over 60 days old",
            "detail":   "Concentration in the late-aged buckets is a leading indicator of "
                        "write-off risk. Escalate the top customers in the 61–90 and 90+ "
                        "buckets to collections.",
        })

    gm = prof.get("gross_margin_pct")
    gm_prev = prof.get("gross_margin_pct_prior")
    if gm is not None and gm_prev is not None and (gm_prev - gm) > 3:
        recs.append({
            "priority": "medium",
            "title":    f"Gross margin slipped {gm_prev - gm:.1f} pts MoM",
            "detail":   "Could be input cost inflation, discounting, or product mix. Pull "
                        "COGS detail by category to confirm the driver before next pricing review.",
        })

    nm = prof.get("net_margin_pct")
    if nm is not None and nm < 0:
        recs.append({
            "priority": "high",
            "title":    f"Operating at a {abs(nm):.1f}% net loss",
            "detail":   "Revenue isn't covering total costs. Identify the largest expense "
                        "categories and the biggest MoM movers to find quick savings.",
        })

    biggest_change = exp.get("biggest_mom_mover")
    if biggest_change and biggest_change.get("change_pct", 0) > 25:
        recs.append({
            "priority": "medium",
            "title":    f"{biggest_change['category']} expense up {biggest_change['change_pct']:.0f}% MoM",
            "detail":   f"Spiked from {_money_str(biggest_change['from'])} to "
                        f"{_money_str(biggest_change['to'])}. Investigate to confirm it's "
                        "intentional (e.g. one-off project) vs. recurring drift.",
        })

    ap_concentration = ap.get("aging_over_60_pct")
    if ap_concentration is not None and ap_concentration > 25:
        recs.append({
            "priority": "medium",
            "title":    f"{ap_concentration:.0f}% of AP is over 60 days past due",
            "detail":   "Stretched payables can damage supplier relationships. Prioritize "
                        "critical-vendor payments and renegotiate terms where possible.",
        })

    burn = liq.get("monthly_burn")
    if burn is not None and burn > 0 and runway is not None and runway >= 6:
        recs.append({
            "priority": "low",
            "title":    f"Healthy runway but burning {_money_str(burn)}/mo",
            "detail":   "Track burn closely — set a monthly target and review variances "
                        "in the close. Each percentage cut today compounds in runway.",
        })

    if not recs:
        recs.append({
            "priority": "low",
            "title":    "Healthy across the board",
            "detail":   "No high-priority risks flagged. Keep watching cash burn and AR "
                        "concentration as you grow.",
        })

    return recs[:6]


# ── main entry point ─────────────────────────────────────────────────────────

async def compute_overview(
    db: AsyncSession,
    tenant_id,
    period_end: date,
    *,
    period_start: date | None = None,
    months_history: int = 6,
) -> dict[str, Any]:
    """
    Compute the full insights blob for the requested period_end.

    Returns a JSON-ready dict. Sections that have no data degrade
    gracefully (None / empty arrays + a friendly error string).
    """
    # ── Period scaffolding ──────────────────────────────────────────────────
    period_ends: list[date] = [period_end]
    cursor = period_end
    for _ in range(months_history):
        cursor = _prior_month_end(cursor)
        period_ends.append(cursor)
    period_ends.sort()  # ascending: oldest first
    prior_pe = period_ends[-2] if len(period_ends) > 1 else None

    snaps_by_pe = await _load_snapshots(db, tenant_id, period_ends)
    period_syncs = list((await db.execute(
        select(PeriodSync).where(PeriodSync.period_end.in_(period_ends))
    )).scalars().all())
    sync_by_pe = {ps.period_end: ps for ps in period_syncs}

    # QBO connection (best-effort)
    qbo_conn = (await db.execute(select(QboConnection))).scalars().first()

    # Custom range: pull a live P&L for the exact window. Overrides the
    # snapshot-diff P&L numbers (which always span calendar months).
    custom_pl: dict | None = None
    custom_pl_error: str | None = None
    if period_start is not None:
        custom_pl, custom_pl_error = await _fetch_pl_summary(qbo_conn, db, period_start, period_end)

    # ── Liquidity ───────────────────────────────────────────────────────────
    def cash_at(pe: date) -> Decimal:
        return _sum_by_types(snaps_by_pe.get(pe, []), CASH_TYPES)

    cash_balance = cash_at(period_end)
    cash_prior   = cash_at(prior_pe) if prior_pe else ZERO

    # Burn = (cash_prev - cash_curr), averaged over last 3 deltas (positive = burning)
    deltas: list[Decimal] = []
    for i in range(max(0, len(period_ends) - 4), len(period_ends)):
        if i == 0:
            continue
        deltas.append(cash_at(period_ends[i - 1]) - cash_at(period_ends[i]))
    monthly_burn = sum(deltas) / len(deltas) if deltas else ZERO

    runway_months: float | None
    if monthly_burn <= 0:
        runway_months = None  # cash-positive
    elif cash_balance <= 0:
        runway_months = 0.0
    else:
        runway_months = float((cash_balance / monthly_burn).quantize(Decimal("0.1")))

    # OCF proxy: monthly net income (true OCF needs cash-flow statement).
    # NI = Revenue - COGS - OpEx + Other Income - Other Expense — matches the
    # financials/internal.py formula so the two pages reconcile.
    def ytd_ni(pe: date) -> Decimal:
        rows = snaps_by_pe.get(pe, [])
        rev       = _sum_by_types_presented(rows, INCOME_TYPES)
        other_inc = _sum_by_types_presented(rows, OTHER_INCOME_TYPES)
        cogs      = _sum_by_types_presented(rows, COGS_TYPES)
        opex      = _sum_by_types_presented(rows, EXPENSE_TYPES)
        other_exp = _sum_by_types_presented(rows, OTHER_EXPENSE_TYPES)
        return rev - cogs - opex + other_inc - other_exp

    def monthly_ni(pe: date) -> Decimal:
        if pe.month == 1:
            return ytd_ni(pe)
        # find prior period_end in same year
        prior = None
        for p in period_ends:
            if p < pe and p.year == pe.year:
                prior = p
        if prior is None:
            return ytd_ni(pe)
        return ytd_ni(pe) - ytd_ni(prior)

    ocf_proxy = monthly_ni(period_end)

    cash_history = [
        {
            "period": p.isoformat(),
            "label":  p.strftime("%b"),
            "cash":   _to_money(cash_at(p)),
            "ocf":    _to_money(monthly_ni(p)),
        }
        for p in period_ends
    ]

    liquidity = {
        "cash_balance":        _to_money(cash_balance),
        "cash_balance_prior":  _to_money(cash_prior),
        "cash_change_str":     _change_str(_to_money(cash_balance), _to_money(cash_prior)),
        "monthly_burn":        _to_money(monthly_burn),
        "runway_months":       runway_months,
        "operating_cash_flow": _to_money(ocf_proxy),
        "history":             cash_history,
        "kpis": [
            {
                "kpi":     "Cash balance",
                "value":   _money_str(cash_balance),
                "risk":    "neutral",
                "insight": (
                    f"Total of all bank/cash accounts at {period_end.isoformat()}."
                    + (f" {_change_str(float(cash_balance), float(cash_prior))} vs prior month."
                       if cash_prior else "")
                ),
            },
            {
                "kpi":     "Monthly cash burn (3-mo avg)",
                "value":   _money_str(monthly_burn) if monthly_burn > 0 else "Cash positive",
                "risk":    _risk_for("cash_burn", float(monthly_burn)),
                "insight": (
                    "Net cash consumed per month. Negative = cash growing."
                    if monthly_burn > 0
                    else "Cash position grew on average — focus shifts to deploying capital effectively."
                ),
            },
            {
                "kpi":     "Cash runway",
                "value":   f"{runway_months:.1f} months" if runway_months is not None else "Indefinite",
                "risk":    _risk_for("runway_months", runway_months) if runway_months is not None else "green",
                "insight": (
                    "Months of cash remaining at current burn. Under 6 = act now, "
                    "6–12 = plan, 12+ = healthy."
                    if runway_months is not None
                    else "Generating cash; no runway constraint at current trajectory."
                ),
            },
            {
                "kpi":     "Operating cash flow (proxy: monthly net income)",
                "value":   _money_str(ocf_proxy),
                "risk":    _risk_for("operating_cash_flow", float(ocf_proxy)),
                "insight": (
                    "True OCF requires a cash-flow statement. Net income is a useful "
                    "proxy until working-capital movements are pulled."
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

    def monthly_metric(pe: date, ytd_func) -> Decimal:
        if pe.month == 1:
            return ytd_func(pe)
        prior = None
        for p in period_ends:
            if p < pe and p.year == pe.year:
                prior = p
        if prior is None:
            return ytd_func(pe)
        return ytd_func(pe) - ytd_func(prior)

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
        # QBO's own NetIncome already includes Other Income / Other Expense
        net_income    = custom_pl["net_income"] or operating_inc
        other_income_month   = Decimal("0")
        other_expense_month  = Decimal("0")
        net_other            = (net_income - operating_inc) if custom_pl["net_income"] else Decimal("0")
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

    revenue_prior = monthly_metric(prior_pe, revenue_at) if prior_pe else ZERO
    gp_prior      = monthly_metric(prior_pe, revenue_at) - monthly_metric(prior_pe, cogs_at) if prior_pe else ZERO
    gm_pct_prior  = _to_pct(gp_prior, revenue_prior) if prior_pe else None

    # Pre-compute per-period monthly P&L so the history sparkline is consistent
    # and we don't recompute the same diffs four times per row.
    def per_period_pl(p: date) -> dict:
        rev  = monthly_metric(p, revenue_at)
        cogs = monthly_metric(p, cogs_at)
        opex = monthly_metric(p, opex_at)
        oi   = monthly_metric(p, other_income_at)
        oe   = monthly_metric(p, other_expense_at)
        gp   = rev - cogs
        oi_excl_other = gp - opex  # Operating Income
        ni   = oi_excl_other + (oi - oe)
        return {
            "period":  p.isoformat(),
            "label":   p.strftime("%b"),
            "revenue": _to_money(rev),
            "gp":      _to_money(gp),
            "ni":      _to_money(ni),
        }

    revenue_history = [per_period_pl(p) for p in period_ends]

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
                "kpi":     "Revenue (month)",
                "value":   _money_str(revenue_month),
                "risk":    "neutral",
                "insight": (
                    f"{_change_str(_to_money(revenue_month), _to_money(revenue_prior))} vs prior month."
                    if revenue_prior else "First period — no prior comparison available."
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
    ar_balance_gl = _sum_by_types(snaps_by_pe.get(period_end, []), AR_TYPES)
    ar_balance_sync = sync_by_pe[period_end].ar_aging_total if period_end in sync_by_pe else None
    ar_balance = float(ar_balance_sync) if ar_balance_sync is not None else _to_money(ar_balance_gl)

    # DSO using monthly revenue (revenue_month is presentation-positive)
    dso_days: float | None
    if revenue_month and revenue_month > 0:
        dso_days = float((Decimal(ar_balance) / (revenue_month / Decimal(30))).quantize(Decimal("0.1")))
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
                "insight": "Total receivables owed at period end.",
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
    ap_balance_gl = _sum_by_types_presented(snaps_by_pe.get(period_end, []), AP_TYPES)
    ap_balance_sync = sync_by_pe[period_end].ap_aging_total if period_end in sync_by_pe else None
    ap_balance = float(ap_balance_sync) if ap_balance_sync is not None else _to_money(ap_balance_gl)

    dpo_days: float | None
    if cogs_month and cogs_month > 0:
        dpo_days = float((Decimal(ap_balance) / (cogs_month / Decimal(30))).quantize(Decimal("0.1")))
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
                "insight": "Total payables owed at period end.",
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

    # Period label: month-year when the range is exactly one calendar
    # month (so "January 2026" stays readable for Month-mode selections),
    # otherwise a date-range string for true custom windows.
    is_full_month = (
        period_start is not None
        and period_start.day == 1
        and period_start.year == period_end.year
        and period_start.month == period_end.month
        and period_end == _last_day_of_month(period_end)
    )
    if is_full_month:
        period_label = period_end.strftime("%B %Y")
    elif period_start is not None:
        period_label = f"{period_start.strftime('%b %d, %Y')} – {period_end.strftime('%b %d, %Y')}"
    else:
        period_label = period_end.strftime("%B %Y")

    payload = {
        "period_end":     period_end.isoformat(),
        "period_start":   period_start.isoformat() if period_start else None,
        "period_label":   period_label,
        # `custom_range` reflects whether this is a TRUE custom window
        # (not aligned to a calendar month). Frontend uses this to decide
        # whether to show the "custom-range fallback" banner.
        "custom_range":   period_start is not None and not is_full_month,
        "is_full_month":  is_full_month,
        "custom_pl_error": custom_pl_error,
        "liquidity":      liquidity,
        "receivables":    receivables,
        "payables":       payables,
        "profitability":  profitability,
        "expenses":       expenses,
        "qbo_connected":  qbo_conn is not None,
    }

    payload["recommendations"] = _build_recommendations(payload)
    return payload
