"""
Invariant: financial-statement sign convention (`_signed_for_display`).

Credit-natural accounts (liabilities, equity, income) carry negative signed
balances in the GL snapshot and must be flipped to positive for the statements;
debit-natural accounts (assets, COGS, expenses) pass through unchanged. A
regression that moves a type to the wrong side silently mis-signs the balance
sheet / P&L. The expectations below are hardcoded per account type —
independent of the function's own type sets — so moving a type out of the flip
set (or adding a new credit-natural type without flipping it) fails CI.

Pure (no DB / async), so it also runs standalone:
    python tests/test_sign_conventions.py
"""
from decimal import Decimal

from modules.financials.internal import _signed_for_display

_HUNDRED = Decimal("100")

# Credit-natural → flipped (a +100 GL signed balance displays as -100... and a
# -100 GL balance displays as +100).
_FLIP = [
    "Accounts Payable", "Credit Card", "Other Current Liability",
    "Long Term Liability", "Equity", "Income", "Other Income",
]
# Debit-natural → passes through unchanged.
_PASS = [
    "Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset",
    "Other Asset", "Cost of Goods Sold", "Expense", "Other Expense",
]


def test_credit_natural_types_are_flipped():
    for t in _FLIP:
        assert _signed_for_display(t, _HUNDRED) == Decimal("-100"), t
        assert _signed_for_display(t, Decimal("-100")) == _HUNDRED, t


def test_debit_natural_types_pass_through():
    for t in _PASS:
        assert _signed_for_display(t, _HUNDRED) == _HUNDRED, t
        assert _signed_for_display(t, Decimal("-100")) == Decimal("-100"), t


def test_unknown_type_passes_through_unchanged():
    # An unmapped type is treated debit-natural (not flipped) — locks the default
    # so a new QBO type can't silently flip a balance.
    assert _signed_for_display("Some New QBO Type", _HUNDRED) == _HUNDRED


if __name__ == "__main__":
    test_credit_natural_types_are_flipped()
    test_debit_natural_types_pass_through()
    test_unknown_type_passes_through_unchanged()
    print("SIGN_CONVENTIONS_OK")
