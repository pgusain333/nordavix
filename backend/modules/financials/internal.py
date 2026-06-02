"""
Build IS / BS from internal GL snapshot data (the gl_balance_snapshots
table populated on every recons sync). Used when the user picks
source=nordavix on the Financial Package page.

Advantages over the live-QBO route:
  • Works while QBO is disconnected — last synced data still renders
  • Respects manual subledger overrides recorded on AccountReviewStatus
  • One DB query vs. multiple QBO API calls — much faster + more
    reliable when QBO is slow
  • Output structure is deterministic (we control the section
    layout) — closer to a real US-GAAP statement than QBO's report

Cash Flow stays QBO-backed for now — building CF properly from
internal data requires beginning + ending BS positions, non-cash
adjustments per account, etc. Defer until requested.

Sign convention:
  Snapshot stores signed balances (debit-positive). For display:
  • Asset accounts: positive normally (show as-is)
  • Liability / Equity: stored negative → flip to positive for display
  • Income / Other Income: stored negative → flip to positive
  • COGS / Expense / Other Expense: stored positive → show as-is
  • Net Income (calculated) = Revenue - COGS - OpEx + OtherInc - OtherExp
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.gl_balance_snapshot import GlBalanceSnapshot

# QBO account-type groupings
_ASSET_TYPES = {"Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset"}
_LIABILITY_TYPES = {"Accounts Payable", "Credit Card",
                     "Other Current Liability", "Long Term Liability"}
_EQUITY_TYPES = {"Equity"}

_CURRENT_ASSET_TYPES = {"Bank", "Accounts Receivable", "Other Current Asset"}
_CURRENT_LIABILITY_TYPES = {"Accounts Payable", "Credit Card", "Other Current Liability"}

_INCOME_TYPES = {"Income"}
_OTHER_INCOME_TYPES = {"Other Income"}
_COGS_TYPES = {"Cost of Goods Sold"}
_EXPENSE_TYPES = {"Expense"}
_OTHER_EXPENSE_TYPES = {"Other Expense"}

# P&L (income-statement) account types — used to decide which accounts get
# period-activity differencing for custom ranges.
_PL_TYPES = (_INCOME_TYPES | _OTHER_INCOME_TYPES | _COGS_TYPES
             | _EXPENSE_TYPES | _OTHER_EXPENSE_TYPES)

# ── Cash-flow classification (indirect method) ───────────────────────────────
_CASH_TYPES = {"Bank"}
_AR_TYPES = {"Accounts Receivable"}
_AP_TYPES = {"Accounts Payable"}
# Non-cash, non-AR current assets (inventory, prepaids, other CA)
_OTHER_CURRENT_ASSET_TYPES = {"Other Current Asset"}
# Non-AP current liabilities (credit cards, accrued, deferred rev, other CL)
_OTHER_CURRENT_LIAB_TYPES = {"Credit Card", "Other Current Liability"}
_FIXED_ASSET_TYPES = {"Fixed Asset"}
_OTHER_ASSET_TYPES = {"Other Asset"}
_LONG_TERM_LIAB_TYPES = {"Long Term Liability"}

_DEPRECIATION_KEYWORDS = ("depreciation", "amortization", "amortisation", "depletion")


def _is_depreciation(account_name: str | None) -> bool:
    """True for depreciation / amortization expense accounts (non-cash)."""
    if not account_name:
        return False
    nm = account_name.lower()
    return any(k in nm for k in _DEPRECIATION_KEYWORDS)


# ── Loading helpers ────────────────────────────────────────────────────────

async def _load_snapshot(
    db: AsyncSession,
    tenant_id: uuid.UUID,   # noqa: ARG001  — tenant filter applied via mixin
    period_end: date,
) -> list[GlBalanceSnapshot]:
    rows = list((await db.execute(
        select(GlBalanceSnapshot).where(GlBalanceSnapshot.period_end == period_end)
        .order_by(GlBalanceSnapshot.account_number, GlBalanceSnapshot.account_name)
    )).scalars().all())
    return rows


async def load_snapshot_on_or_before(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    d: date,
) -> tuple[list[GlBalanceSnapshot], date | None]:
    """Most-recent snapshot whose period_end <= d.

    Returns (rows, snapshot_date) — or ([], None) if no snapshot exists at or
    before d. Used for (a) income-statement period differencing and (b)
    cash-flow *beginning* balances (the BS position at the start of the period).
    """
    pe = (await db.execute(
        select(GlBalanceSnapshot.period_end)
        .where(GlBalanceSnapshot.period_end <= d)
        .order_by(GlBalanceSnapshot.period_end.desc())
        .limit(1)
    )).scalar_one_or_none()
    if pe is None:
        return [], None
    return await _load_snapshot(db, tenant_id, pe), pe


@dataclass
class _PLRow:
    """Drop-in stand-in for a GlBalanceSnapshot row whose `balance` has been
    replaced with *period activity* (end − beginning). Exposes exactly the
    attributes `_build_is_section` reads, so the section builder is unchanged."""
    qbo_account_id: str
    account_number: str | None
    account_name: str
    account_type: str
    balance: Decimal


def _period_pl_rows(
    end_rows: list[GlBalanceSnapshot],
    beg_rows: list[GlBalanceSnapshot] | None,
    same_fiscal_year: bool,
) -> list[_PLRow]:
    """Convert end-of-period snapshot rows into period-activity rows for the
    income statement.

    Snapshot P&L balances are YTD (QBO resets P&L accounts each fiscal year).
    For a custom range starting mid-year, period activity = end − beginning
    (both YTD within the same fiscal year). When the beginning snapshot is in a
    PRIOR fiscal year (e.g. the range starts Jan 1), the end balance already IS
    the period's activity, so we use it as-is. Balance-sheet rows pass through
    untouched (the IS builder ignores them by type)."""
    beg_by_id = {r.qbo_account_id: r.balance for r in (beg_rows or [])}
    out: list[_PLRow] = []
    for r in end_rows:
        bal = r.balance
        if same_fiscal_year and r.account_type in _PL_TYPES:
            bal = r.balance - beg_by_id.get(r.qbo_account_id, Decimal("0"))
        out.append(_PLRow(
            qbo_account_id=r.qbo_account_id,
            account_number=r.account_number,
            account_name=r.account_name,
            account_type=r.account_type,
            balance=bal,
        ))
    return out


def _signed_for_display(account_type: str, balance: Decimal) -> Decimal:
    """Flip credit-natural balances to positive for display."""
    if account_type in (_LIABILITY_TYPES | _EQUITY_TYPES
                         | _INCOME_TYPES | _OTHER_INCOME_TYPES):
        return -balance
    return balance


# ── Output shape ───────────────────────────────────────────────────────────

def _row(label, current, prior, level, kind):
    return {"label": label, "current": str(current) if current is not None else None,
            "prior": str(prior) if prior is not None else None,
            "level": level, "kind": kind}


# ── Balance Sheet ───────────────────────────────────────────────────────────

def _build_bs_section(
    label: str,
    types: set[str],
    cur: list[GlBalanceSnapshot],
    prior: list[GlBalanceSnapshot] | None,
    level: int,
) -> tuple[list[dict], Decimal, Decimal]:
    """Build one BS sub-section (e.g. Current Assets). Returns
    (rows, current_total, prior_total)."""
    cur_rows = [r for r in cur if r.account_type in types]
    prior_by_id = {r.qbo_account_id: r for r in (prior or [])}

    if not cur_rows:
        return [], Decimal("0"), Decimal("0")

    out: list[dict] = [_row(label, None, None, level, "section_header")]
    cur_total  = Decimal("0")
    prior_total= Decimal("0")
    for r in cur_rows:
        cur_v = _signed_for_display(r.account_type, r.balance)
        prior_v: Decimal | None = None
        p = prior_by_id.get(r.qbo_account_id)
        if p is not None:
            prior_v = _signed_for_display(p.account_type, p.balance)
            prior_total += prior_v
        # Skip rows that are zero in both periods to keep the statement clean.
        if cur_v == 0 and (prior_v is None or prior_v == 0):
            continue
        cur_total += cur_v
        prior_dec = prior_v if prior_v is not None else None
        out.append(_row(
            f"{r.account_number + ' · ' if r.account_number else ''}{r.account_name}",
            cur_v.quantize(Decimal("0.01")),
            prior_dec.quantize(Decimal("0.01")) if prior_dec is not None else None,
            level + 1, "data",
        ))
    out.append(_row(
        f"Total {label}",
        cur_total.quantize(Decimal("0.01")),
        prior_total.quantize(Decimal("0.01")),
        level, "total",
    ))
    return out, cur_total, prior_total


async def build_balance_sheet(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    period_end: date,
    comparative_end: date | None,
) -> tuple[list[dict], list[str]]:
    cur   = await _load_snapshot(db, tenant_id, period_end)
    prior = await _load_snapshot(db, tenant_id, comparative_end) if comparative_end else []

    notes: list[str] = []
    if not cur:
        notes.append(
            "No GL snapshot found for this period. Run a sync from the "
            "Reconciliations dashboard at this period-end first."
        )
        return [], notes
    if comparative_end and not prior:
        notes.append(
            f"No GL snapshot for the comparative period ({comparative_end}). "
            "Run a sync at that period-end too to enable the comparison column."
        )

    rows: list[dict] = []
    # ASSETS
    rows.append(_row("Assets", None, None, 0, "section_header"))
    ca_rows, ca_cur, ca_prior   = _build_bs_section("Current Assets", _CURRENT_ASSET_TYPES, cur, prior, 1)
    rows.extend(ca_rows)
    fa_rows, fa_cur, fa_prior   = _build_bs_section("Property, Plant and Equipment, net",
                                                       {"Fixed Asset"}, cur, prior, 1)
    rows.extend(fa_rows)
    oa_rows, oa_cur, oa_prior   = _build_bs_section("Other Assets", {"Other Asset"}, cur, prior, 1)
    rows.extend(oa_rows)
    total_assets       = ca_cur + fa_cur + oa_cur
    total_assets_prior = ca_prior + fa_prior + oa_prior
    rows.append(_row(
        "Total Assets",
        total_assets.quantize(Decimal("0.01")),
        total_assets_prior.quantize(Decimal("0.01")) if prior else None,
        0, "grand_total",
    ))

    # LIABILITIES AND EQUITY
    rows.append(_row("Liabilities and Stockholders' Equity", None, None, 0, "section_header"))
    rows.append(_row("Liabilities", None, None, 1, "section_header"))
    cl_rows, cl_cur, cl_prior   = _build_bs_section("Current Liabilities", _CURRENT_LIABILITY_TYPES,
                                                       cur, prior, 2)
    rows.extend(cl_rows)
    ltl_rows, ltl_cur, ltl_prior= _build_bs_section("Long-Term Liabilities", {"Long Term Liability"},
                                                       cur, prior, 2)
    rows.extend(ltl_rows)
    total_liab       = cl_cur + ltl_cur
    total_liab_prior = cl_prior + ltl_prior
    rows.append(_row(
        "Total Liabilities",
        total_liab.quantize(Decimal("0.01")),
        total_liab_prior.quantize(Decimal("0.01")) if prior else None,
        1, "total",
    ))

    # EQUITY (includes computed YTD Net Income, since QBO's BS does that
    # implicitly to balance the equation — we replicate to match.)
    eq_rows, eq_cur, eq_prior = _build_bs_section("Stockholders' Equity", _EQUITY_TYPES,
                                                   cur, prior, 1)
    # Compute YTD net income from P&L accounts in the same snapshot.
    cur_ni   = _compute_net_income(cur)
    prior_ni = _compute_net_income(prior) if prior else Decimal("0")
    if cur_ni != 0 or prior_ni != 0:
        # Append the implicit "Current Year Net Income" line inside Equity
        # before the Total Equity row. Strip the placeholder "Total
        # Stockholders' Equity" the helper appended so we can re-emit
        # the correct one.
        if eq_rows and eq_rows[-1]["kind"] == "total":
            eq_rows.pop()
        eq_rows.append(_row("Current Year Net Income",
                              cur_ni.quantize(Decimal("0.01")),
                              prior_ni.quantize(Decimal("0.01")) if prior else None,
                              2, "data"))
        eq_total       = eq_cur + cur_ni
        eq_total_prior = eq_prior + prior_ni
        eq_rows.append(_row(
            "Total Stockholders' Equity",
            eq_total.quantize(Decimal("0.01")),
            eq_total_prior.quantize(Decimal("0.01")) if prior else None,
            1, "total",
        ))
        eq_cur, eq_prior = eq_total, eq_total_prior
    rows.extend(eq_rows)

    total_le       = total_liab + eq_cur
    total_le_prior = total_liab_prior + eq_prior
    rows.append(_row(
        "Total Liabilities and Stockholders' Equity",
        total_le.quantize(Decimal("0.01")),
        total_le_prior.quantize(Decimal("0.01")) if prior else None,
        0, "grand_total",
    ))

    # Sanity-check note if the books don't balance
    diff = (total_assets - total_le).quantize(Decimal("0.01"))
    if abs(diff) >= Decimal("1.00"):
        notes.append(
            f"Note: Assets and Liabilities + Equity differ by ${abs(diff):,} — "
            "this usually means the snapshot is missing accounts. Re-sync to refresh."
        )
    return rows, notes


# ── Income Statement ────────────────────────────────────────────────────────

def _compute_net_income(rows: list[GlBalanceSnapshot]) -> Decimal:
    income = sum((-r.balance for r in rows if r.account_type in _INCOME_TYPES), Decimal("0"))
    other_inc = sum((-r.balance for r in rows if r.account_type in _OTHER_INCOME_TYPES), Decimal("0"))
    cogs = sum((r.balance for r in rows if r.account_type in _COGS_TYPES), Decimal("0"))
    expense = sum((r.balance for r in rows if r.account_type in _EXPENSE_TYPES), Decimal("0"))
    other_exp = sum((r.balance for r in rows if r.account_type in _OTHER_EXPENSE_TYPES), Decimal("0"))
    return income + other_inc - cogs - expense - other_exp


def _build_is_section(
    label: str, types: set[str], cur: list[GlBalanceSnapshot],
    prior: list[GlBalanceSnapshot] | None, level: int,
) -> tuple[list[dict], Decimal, Decimal]:
    cur_rows = [r for r in cur if r.account_type in types]
    prior_by_id = {r.qbo_account_id: r for r in (prior or [])}

    if not cur_rows:
        return [], Decimal("0"), Decimal("0")

    out: list[dict] = [_row(label, None, None, level, "section_header")]
    cur_total = Decimal("0")
    prior_total = Decimal("0")
    for r in cur_rows:
        cur_v = _signed_for_display(r.account_type, r.balance)
        prior_v: Decimal | None = None
        p = prior_by_id.get(r.qbo_account_id)
        if p is not None:
            prior_v = _signed_for_display(p.account_type, p.balance)
            prior_total += prior_v
        if cur_v == 0 and (prior_v is None or prior_v == 0):
            continue
        cur_total += cur_v
        out.append(_row(
            f"{r.account_number + ' · ' if r.account_number else ''}{r.account_name}",
            cur_v.quantize(Decimal("0.01")),
            prior_v.quantize(Decimal("0.01")) if prior_v is not None else None,
            level + 1, "data",
        ))
    out.append(_row(
        f"Total {label}",
        cur_total.quantize(Decimal("0.01")),
        prior_total.quantize(Decimal("0.01")),
        level, "total",
    ))
    return out, cur_total, prior_total


async def build_income_statement(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    period_end: date,
    comparative_end: date | None,
    period_start: date | None = None,
    comparative_start: date | None = None,
) -> tuple[list[dict], list[str]]:
    cur   = await _load_snapshot(db, tenant_id, period_end)
    prior = await _load_snapshot(db, tenant_id, comparative_end) if comparative_end else []

    notes: list[str] = []
    if not cur:
        notes.append(
            "No GL snapshot found for this period. Run a sync from the "
            "Reconciliations dashboard at this period-end first."
        )
        return [], notes
    if comparative_end and not prior:
        notes.append(
            f"No GL snapshot for the comparative period ({comparative_end}). "
            "Run a sync at that period-end too to enable the comparison column."
        )

    # Custom range → show period activity (end − beginning) for P&L accounts
    # rather than YTD. Snapshot P&L balances are YTD, so within one fiscal year
    # the range's activity = end snapshot − the snapshot just before the start.
    # When the range starts on Jan 1 (or no prior-year snapshot exists), the end
    # balance already IS the YTD activity, so it's used as-is.
    if period_start is not None:
        beg_rows, beg_date = await load_snapshot_on_or_before(
            db, tenant_id, period_start - timedelta(days=1))
        same_year = beg_date is not None and beg_date.year == period_end.year
        is_jan1 = period_start.month == 1 and period_start.day == 1
        if not is_jan1 and not same_year:
            notes.append(
                "No snapshot before the start date — income-statement figures are "
                "year-to-date through the end date, not the exact range. Sync the "
                "month before the range start for exact period figures."
            )
        cur = _period_pl_rows(cur, beg_rows, same_year)
        if prior:
            cstart = comparative_start or date(comparative_end.year, 1, 1)
            pbeg_rows, pbeg_date = await load_snapshot_on_or_before(
                db, tenant_id, cstart - timedelta(days=1))
            psame = pbeg_date is not None and pbeg_date.year == comparative_end.year
            prior = _period_pl_rows(prior, pbeg_rows, psame)

    rows: list[dict] = []
    rev_rows, rev_cur, rev_prior = _build_is_section("Revenue", _INCOME_TYPES, cur, prior, 0)
    rows.extend(rev_rows)
    cogs_rows, cogs_cur, cogs_prior = _build_is_section("Cost of Sales", _COGS_TYPES, cur, prior, 0)
    rows.extend(cogs_rows)

    # Gross Profit
    gp_cur   = rev_cur - cogs_cur
    gp_prior = rev_prior - cogs_prior
    rows.append(_row("Gross Profit",
                      gp_cur.quantize(Decimal("0.01")),
                      gp_prior.quantize(Decimal("0.01")) if prior else None,
                      0, "computed"))

    opex_rows, opex_cur, opex_prior = _build_is_section("Operating Expenses", _EXPENSE_TYPES, cur, prior, 0)
    rows.extend(opex_rows)

    # Operating Income
    op_cur   = gp_cur - opex_cur
    op_prior = gp_prior - opex_prior
    rows.append(_row("Operating Income",
                      op_cur.quantize(Decimal("0.01")),
                      op_prior.quantize(Decimal("0.01")) if prior else None,
                      0, "computed"))

    oi_rows, oi_cur, oi_prior = _build_is_section("Other Income", _OTHER_INCOME_TYPES, cur, prior, 0)
    rows.extend(oi_rows)
    oe_rows, oe_cur, oe_prior = _build_is_section("Other Expense", _OTHER_EXPENSE_TYPES, cur, prior, 0)
    rows.extend(oe_rows)

    # Net Other Income (Expense)
    net_other_cur   = oi_cur - oe_cur
    net_other_prior = oi_prior - oe_prior
    if net_other_cur != 0 or net_other_prior != 0:
        rows.append(_row("Other Income (Expense), net",
                          net_other_cur.quantize(Decimal("0.01")),
                          net_other_prior.quantize(Decimal("0.01")) if prior else None,
                          0, "computed"))

    # Net Income
    ni_cur   = op_cur + net_other_cur
    ni_prior = op_prior + net_other_prior
    rows.append(_row("Net Income",
                      ni_cur.quantize(Decimal("0.01")),
                      ni_prior.quantize(Decimal("0.01")) if prior else None,
                      0, "grand_total"))
    return rows, notes


# ── Statement of Cash Flows (indirect method) ───────────────────────────────
#
# Built from two GL snapshots — the period-end and the BS position at the start
# of the period (the snapshot just before period_start). Because Assets =
# Liabilities + Equity holds in both snapshots, Operating + Investing +
# Financing equals the change in cash by construction; any residual (missing
# accounts, cross-year retained-earnings rollover, rounding) is shown as a small
# reconciling line so the statement always ties to the actual cash movement.

@dataclass
class _CFFigures:
    net_income:     Decimal
    depreciation:   Decimal
    d_ar:           Decimal
    d_oca:          Decimal
    d_ap:           Decimal
    d_ocl:          Decimal
    op_total:       Decimal
    capex:          Decimal
    d_other_assets: Decimal
    inv_total:      Decimal
    d_ltl:          Decimal
    d_equity:       Decimal
    fin_total:      Decimal
    other_recon:    Decimal
    net_change:     Decimal
    cash_begin:     Decimal
    cash_end:       Decimal


def _presented_sum(rows, types: set[str]) -> Decimal:
    """Sum of presented (positive-natural) balances for the given account types."""
    return sum(
        (_signed_for_display(r.account_type, r.balance) for r in rows if r.account_type in types),
        Decimal("0"),
    )


def _cash_flow_figures(
    end_rows: list,
    beg_rows: list,
    beg_date: date,
    pe: date,
) -> _CFFigures:
    """Decompose one period's indirect cash flow from beginning + ending snapshots."""
    same_year = beg_date.year == pe.year
    # Period net income + depreciation (year-aware P&L activity).
    period_pl = _period_pl_rows(end_rows, beg_rows, same_year)
    ni  = _compute_net_income(period_pl)
    dep = sum(
        (_signed_for_display(r.account_type, r.balance)
         for r in period_pl
         if r.account_type in (_EXPENSE_TYPES | _OTHER_EXPENSE_TYPES)
         and _is_depreciation(r.account_name)),
        Decimal("0"),
    )

    # Working-capital deltas (end − beginning), presented positive.
    d_ar  = _presented_sum(end_rows, _AR_TYPES)                  - _presented_sum(beg_rows, _AR_TYPES)
    d_oca = _presented_sum(end_rows, _OTHER_CURRENT_ASSET_TYPES) - _presented_sum(beg_rows, _OTHER_CURRENT_ASSET_TYPES)
    d_ap  = _presented_sum(end_rows, _AP_TYPES)                  - _presented_sum(beg_rows, _AP_TYPES)
    d_ocl = _presented_sum(end_rows, _OTHER_CURRENT_LIAB_TYPES)  - _presented_sum(beg_rows, _OTHER_CURRENT_LIAB_TYPES)
    op = ni + dep - d_ar - d_oca + d_ap + d_ocl

    # Investing — gross up capex by depreciation (which was added back above).
    d_ppe_net      = _presented_sum(end_rows, _FIXED_ASSET_TYPES) - _presented_sum(beg_rows, _FIXED_ASSET_TYPES)
    capex          = d_ppe_net + dep
    d_other_assets = _presented_sum(end_rows, _OTHER_ASSET_TYPES) - _presented_sum(beg_rows, _OTHER_ASSET_TYPES)
    inv = -capex - d_other_assets

    # Financing — long-term debt + owner equity movements (excl. net income,
    # which is captured in operating and not yet rolled into the equity accounts).
    d_ltl    = _presented_sum(end_rows, _LONG_TERM_LIAB_TYPES) - _presented_sum(beg_rows, _LONG_TERM_LIAB_TYPES)
    d_equity = _presented_sum(end_rows, _EQUITY_TYPES)         - _presented_sum(beg_rows, _EQUITY_TYPES)
    fin = d_ltl + d_equity

    cash_begin    = _presented_sum(beg_rows, _CASH_TYPES)
    cash_end      = _presented_sum(end_rows, _CASH_TYPES)
    actual_change = cash_end - cash_begin
    other_recon   = actual_change - (op + inv + fin)
    net_change    = op + inv + fin + other_recon   # == actual_change by construction

    return _CFFigures(
        net_income=ni, depreciation=dep, d_ar=d_ar, d_oca=d_oca, d_ap=d_ap, d_ocl=d_ocl,
        op_total=op, capex=capex, d_other_assets=d_other_assets, inv_total=inv,
        d_ltl=d_ltl, d_equity=d_equity, fin_total=fin, other_recon=other_recon,
        net_change=net_change, cash_begin=cash_begin, cash_end=cash_end,
    )


def _q(v: Decimal | None) -> Decimal | None:
    return v.quantize(Decimal("0.01")) if v is not None else None


def _assemble_cf_rows(cur: _CFFigures, prior: _CFFigures | None) -> list[dict]:
    rows: list[dict] = []

    def add(label: str, level: int, kind: str, c: Decimal | None, p: Decimal | None) -> None:
        rows.append(_row(label, _q(c), _q(p), level, kind))

    def shown(c: Decimal | None, p: Decimal | None) -> bool:
        return ((c is not None and abs(c) >= Decimal("0.005"))
                or (p is not None and abs(p) >= Decimal("0.005")))

    pp = prior  # shorthand

    # ── Operating ──
    rows.append(_row("Cash Flows from Operating Activities", None, None, 0, "section_header"))
    add("Net income", 1, "data", cur.net_income, pp.net_income if pp else None)
    rows.append(_row("Adjustments to reconcile net income to net cash from operating activities:",
                     None, None, 1, "data"))
    add("Depreciation and amortization", 2, "data", cur.depreciation, pp.depreciation if pp else None)
    rows.append(_row("Changes in operating assets and liabilities:", None, None, 1, "data"))
    add("(Increase) decrease in accounts receivable", 2, "data",
        -cur.d_ar, (-pp.d_ar if pp else None))
    add("(Increase) decrease in inventory and other current assets", 2, "data",
        -cur.d_oca, (-pp.d_oca if pp else None))
    add("Increase (decrease) in accounts payable", 2, "data", cur.d_ap, pp.d_ap if pp else None)
    add("Increase (decrease) in accrued and other current liabilities", 2, "data",
        cur.d_ocl, pp.d_ocl if pp else None)
    add("Net cash provided by (used in) operating activities", 0, "total",
        cur.op_total, pp.op_total if pp else None)

    # ── Investing ──
    rows.append(_row("Cash Flows from Investing Activities", None, None, 0, "section_header"))
    add("Purchases of property and equipment, net", 1, "data", -cur.capex, (-pp.capex if pp else None))
    if shown(-cur.d_other_assets, (-pp.d_other_assets if pp else None)):
        add("(Increase) decrease in other assets", 1, "data",
            -cur.d_other_assets, (-pp.d_other_assets if pp else None))
    add("Net cash provided by (used in) investing activities", 0, "total",
        cur.inv_total, pp.inv_total if pp else None)

    # ── Financing ──
    rows.append(_row("Cash Flows from Financing Activities", None, None, 0, "section_header"))
    if shown(cur.d_ltl, pp.d_ltl if pp else None):
        add("Proceeds from (repayments of) long-term debt", 1, "data",
            cur.d_ltl, pp.d_ltl if pp else None)
    if shown(cur.d_equity, pp.d_equity if pp else None):
        add("Owner contributions (distributions), net", 1, "data",
            cur.d_equity, pp.d_equity if pp else None)
    add("Net cash provided by (used in) financing activities", 0, "total",
        cur.fin_total, pp.fin_total if pp else None)

    # ── Reconciling residual (only when it exists) ──
    if shown(cur.other_recon, pp.other_recon if pp else None):
        add("Effect of other / non-cash reconciling items", 0, "data",
            cur.other_recon, pp.other_recon if pp else None)

    # ── Net change + cash positions ──
    add("Net Increase (Decrease) in Cash and Cash Equivalents", 0, "grand_total",
        cur.net_change, pp.net_change if pp else None)
    add("Cash and Cash Equivalents, Beginning of Period", 0, "total",
        cur.cash_begin, pp.cash_begin if pp else None)
    add("Cash and Cash Equivalents, End of Period", 0, "grand_total",
        cur.cash_end, pp.cash_end if pp else None)
    return rows


async def build_cash_flow(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    period_end: date,
    period_start: date | None = None,
    comparative_end: date | None = None,
    comparative_start: date | None = None,
) -> tuple[list[dict], list[str]]:
    """Indirect-method Statement of Cash Flows from internal snapshots.

    Returns (rows, notes). Returns ([], notes) when the beginning-of-period
    snapshot is missing — the caller then falls back to the live QBO CashFlow
    report so the tab never breaks.
    """
    notes: list[str] = []
    pe = period_end
    ps = period_start or date(pe.year, 1, 1)

    end_rows = await _load_snapshot(db, tenant_id, pe)
    if not end_rows:
        notes.append(
            "No GL snapshot found for this period. Run a sync from the "
            "Reconciliations dashboard at this period-end first."
        )
        return [], notes

    beg_rows, beg_date = await load_snapshot_on_or_before(db, tenant_id, ps - timedelta(days=1))
    if beg_date is None or not beg_rows:
        notes.append(
            "No beginning-of-period snapshot — the Statement of Cash Flows needs "
            "the GL position before the period start. Showing QuickBooks figures instead."
        )
        return [], notes

    cur = _cash_flow_figures(end_rows, beg_rows, beg_date, pe)

    prior: _CFFigures | None = None
    if comparative_end:
        cpe = comparative_end
        cps = comparative_start or date(cpe.year, 1, 1)
        cend_rows = await _load_snapshot(db, tenant_id, cpe)
        cbeg_rows, cbeg_date = await load_snapshot_on_or_before(db, tenant_id, cps - timedelta(days=1))
        if cend_rows and cbeg_date is not None and cbeg_rows:
            prior = _cash_flow_figures(cend_rows, cbeg_rows, cbeg_date, cpe)
        else:
            notes.append("Prior-year cash flow omitted — comparative snapshots not available.")

    if abs(cur.other_recon) >= Decimal("1"):
        notes.append(
            f"A residual of ${cur.other_recon.quantize(Decimal('0.01')):,} was classified "
            "as 'other' so the statement ties to the change in cash — usually a missing "
            "account in the snapshot or a year-end retained-earnings rollover. Re-sync to refresh."
        )

    return _assemble_cf_rows(cur, prior), notes
