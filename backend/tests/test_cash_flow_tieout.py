"""
Synthetic tie-out test for the indirect Statement of Cash Flows.

Exercises the pure decomposition (`_cash_flow_figures`) + row assembly
(`_assemble_cf_rows`) with two fabricated, balanced trial-balance snapshots —
no DB needed. Verifies the two invariants that make the statement trustworthy:

  1. Operating + Investing + Financing + Other == Net change in cash
  2. Beginning cash + Net change == Ending cash

pytest isn't installed in every env, so this also runs standalone:
    python tests/test_cash_flow_tieout.py
"""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from modules.financials.internal import _assemble_cf_rows, _cash_flow_figures


@dataclass
class _FakeRow:
    qbo_account_id: str
    account_number: str | None
    account_name: str
    account_type: str
    balance: Decimal


def _rows(spec: list[tuple[str, str, str, str]]) -> list[_FakeRow]:
    # spec = (id, name, type, amount)
    return [_FakeRow(i, None, n, t, Decimal(a)) for (i, n, t, a) in spec]


# Beginning snapshot — 2026-03-31 (balanced trial balance: Σ signed = 0).
BEG = _rows([
    ("1",  "Operating Bank",        "Bank",                    "100000"),
    ("2",  "Accounts Receivable",   "Accounts Receivable",      "60000"),
    ("3",  "Inventory",             "Other Current Asset",      "25000"),
    ("4",  "Equipment - cost",      "Fixed Asset",              "90000"),
    ("5",  "Accumulated Depr",      "Fixed Asset",             "-20000"),
    ("6",  "Security Deposit",      "Other Asset",               "5000"),
    ("7",  "Accounts Payable",      "Accounts Payable",        "-30000"),
    ("8",  "Accrued Liabilities",   "Other Current Liability", "-15000"),
    ("9",  "Term Loan",             "Long Term Liability",     "-50000"),
    ("10", "Owner Equity",          "Equity",                 "-100000"),
    ("11", "Revenue",               "Income",                 "-120000"),
    ("12", "Cost of Goods Sold",    "Cost of Goods Sold",       "25000"),
    ("13", "Depreciation Expense",  "Expense",                   "6000"),
    ("14", "Salaries Expense",      "Expense",                  "24000"),
])

# Ending snapshot — 2026-04-30 (also balanced). April activity:
#   AR +10k, Inventory -3k, AP +5k, LTL repaid 2k, depreciation +2k,
#   net income +20k, no capex / contributions.
END = _rows([
    ("1",  "Operating Bank",        "Bank",                    "118000"),
    ("2",  "Accounts Receivable",   "Accounts Receivable",      "70000"),
    ("3",  "Inventory",             "Other Current Asset",      "22000"),
    ("4",  "Equipment - cost",      "Fixed Asset",              "90000"),
    ("5",  "Accumulated Depr",      "Fixed Asset",             "-22000"),
    ("6",  "Security Deposit",      "Other Asset",               "5000"),
    ("7",  "Accounts Payable",      "Accounts Payable",        "-35000"),
    ("8",  "Accrued Liabilities",   "Other Current Liability", "-15000"),
    ("9",  "Term Loan",             "Long Term Liability",     "-48000"),
    ("10", "Owner Equity",          "Equity",                 "-100000"),
    ("11", "Revenue",               "Income",                 "-160000"),
    ("12", "Cost of Goods Sold",    "Cost of Goods Sold",       "33000"),
    ("13", "Depreciation Expense",  "Expense",                   "8000"),
    ("14", "Salaries Expense",      "Expense",                  "34000"),
])


def test_cash_flow_components_and_tieout():
    f = _cash_flow_figures(END, BEG, date(2026, 3, 31), date(2026, 4, 30))

    # Component checks (April activity)
    assert f.net_income == Decimal("20000"), f.net_income
    assert f.depreciation == Decimal("2000"), f.depreciation
    assert f.d_ar == Decimal("10000"), f.d_ar
    assert f.d_oca == Decimal("-3000"), f.d_oca
    assert f.d_ap == Decimal("5000"), f.d_ap
    assert f.d_ocl == Decimal("0"), f.d_ocl
    assert f.op_total == Decimal("20000"), f.op_total
    assert f.capex == Decimal("0"), f.capex
    assert f.inv_total == Decimal("0"), f.inv_total
    assert f.d_ltl == Decimal("-2000"), f.d_ltl
    assert f.d_equity == Decimal("0"), f.d_equity
    assert f.fin_total == Decimal("-2000"), f.fin_total

    # Books are balanced + within-year → zero residual.
    assert f.other_recon == Decimal("0"), f.other_recon

    # Invariant 1: sections sum to the net change.
    assert f.op_total + f.inv_total + f.fin_total + f.other_recon == f.net_change

    # Invariant 2: beginning + change == ending, and ending ties to bank delta.
    assert f.cash_begin == Decimal("100000"), f.cash_begin
    assert f.cash_end == Decimal("118000"), f.cash_end
    assert f.net_change == Decimal("18000"), f.net_change
    assert f.cash_begin + f.net_change == f.cash_end


def test_assembled_rows_end_cash_grand_total():
    f = _cash_flow_figures(END, BEG, date(2026, 3, 31), date(2026, 4, 30))
    rows = _assemble_cf_rows(f, None)
    end_cash = [r for r in rows if r["label"] == "Cash and Cash Equivalents, End of Period"]
    assert end_cash and end_cash[0]["kind"] == "grand_total"
    assert end_cash[0]["current"] == "118000.00", end_cash[0]["current"]
    # Net change line present as a grand total.
    net = [r for r in rows if r["label"].startswith("Net Increase")]
    assert net and net[0]["current"] == "18000.00", net


if __name__ == "__main__":
    test_cash_flow_components_and_tieout()
    test_assembled_rows_end_cash_grand_total()
    print("CASH_FLOW_TIEOUT_OK")
