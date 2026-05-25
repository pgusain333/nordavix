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
from datetime import date
from decimal import Decimal
from typing import Any

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
