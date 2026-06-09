"""
Unit tests for the proposed-adjusting-entry service (pure logic — no DB).

Covers the two invariants the whole feature leans on:
  1. A drafted JE is only valid when it balances (Σ debit == Σ credit).
  2. Bank-only items deterministically produce balanced, correctly-directed
     entries, preferring a real offset account from the chart when one exists.

pytest isn't installed in every env, so this also runs standalone:
    python tests/test_proposed_entries.py
"""
from decimal import Decimal

from modules.adjustments.service import (
    build_bank_entries,
    lines_balanced,
    normalize_lines,
)


def test_normalize_lines_drops_empty_and_coerces():
    raw = [
        {"account": "Prepaid Insurance", "debit": "1200.00", "credit": 0},
        {"account_name": "Insurance Expense", "debit": "0", "credit": "1200"},
        {"account_name": "", "debit": "5", "credit": "0"},        # no name → dropped
        {"account_name": "Noise", "debit": 0, "credit": 0},        # no amount → dropped
        "not-a-dict",                                              # junk → dropped
    ]
    lines = normalize_lines(raw)
    assert len(lines) == 2, lines
    assert lines[0]["account_name"] == "Prepaid Insurance"
    assert lines[0]["debit"] == "1200.00" and lines[0]["credit"] == "0.00"
    assert lines[1]["credit"] == "1200.00" and lines[1]["debit"] == "0.00"


def test_lines_balanced():
    balanced = normalize_lines([
        {"account_name": "A", "debit": "100", "credit": "0"},
        {"account_name": "B", "debit": "0", "credit": "100"},
    ])
    assert lines_balanced(balanced)

    # One-sided / mismatched → not balanced.
    assert not lines_balanced(normalize_lines([{"account_name": "A", "debit": "100", "credit": "0"}]))
    assert not lines_balanced(normalize_lines([
        {"account_name": "A", "debit": "100", "credit": "0"},
        {"account_name": "B", "debit": "0", "credit": "90"},
    ]))


_BANK = {"qbo_account_id": "BANK1", "account_number": "1010", "account_name": "Operating Bank", "account_type": "Bank"}


def test_bank_withdrawal_is_fee_debit_balanced():
    entries = build_bank_entries(
        bank_account=_BANK,
        bank_only=[{"amount": Decimal("-25.00"), "description": "Monthly service charge", "bank_ref": "SC"}],
        accounts=[_BANK],
    )
    assert len(entries) == 1
    e = entries[0]
    lines = normalize_lines(e["lines"])
    assert lines_balanced(lines)
    # Fee → Dr expense, Cr the bank account.
    dr = next(ln for ln in lines if Decimal(ln["debit"]) > 0)
    cr = next(ln for ln in lines if Decimal(ln["credit"]) > 0)
    assert dr["account_name"] == "Bank Fees / Service Charges"   # placeholder (no chart match)
    assert cr["account_qbo_id"] == "BANK1"
    assert Decimal(dr["debit"]) == Decimal("25.00")
    assert e["confidence"] == "medium"                            # no real offset matched


def test_bank_deposit_is_income_credit_balanced():
    entries = build_bank_entries(
        bank_account=_BANK,
        bank_only=[{"amount": Decimal("10.50"), "description": "Interest earned", "bank_ref": None}],
        accounts=[_BANK],
    )
    e = entries[0]
    lines = normalize_lines(e["lines"])
    assert lines_balanced(lines)
    dr = next(ln for ln in lines if Decimal(ln["debit"]) > 0)
    cr = next(ln for ln in lines if Decimal(ln["credit"]) > 0)
    assert dr["account_qbo_id"] == "BANK1"                        # cash debited on a deposit
    assert "Interest" in cr["account_name"]
    assert Decimal(cr["credit"]) == Decimal("10.50")


def test_bank_uses_real_offset_account_when_present():
    chart = [
        _BANK,
        {"qbo_account_id": "6010", "account_number": "6010", "account_name": "Bank Service Charges", "account_type": "Expense"},
    ]
    entries = build_bank_entries(
        bank_account=_BANK,
        bank_only=[{"amount": Decimal("-15.00"), "description": "wire fee", "bank_ref": ""}],
        accounts=chart,
    )
    e = entries[0]
    dr = next(ln for ln in normalize_lines(e["lines"]) if Decimal(ln["debit"]) > 0)
    assert dr["account_qbo_id"] == "6010"
    assert dr["account_name"] == "Bank Service Charges"
    assert e["confidence"] == "high"                              # matched a real account


def test_bank_skips_zero_amount():
    entries = build_bank_entries(
        bank_account=_BANK,
        bank_only=[{"amount": Decimal("0.00"), "description": "ignore", "bank_ref": ""}],
        accounts=[_BANK],
    )
    assert entries == []


if __name__ == "__main__":
    test_normalize_lines_drops_empty_and_coerces()
    test_lines_balanced()
    test_bank_withdrawal_is_fee_debit_balanced()
    test_bank_deposit_is_income_credit_balanced()
    test_bank_uses_real_offset_account_when_present()
    test_bank_skips_zero_amount()
    print("PROPOSED_ENTRIES_OK")
