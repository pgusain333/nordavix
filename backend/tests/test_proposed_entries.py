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
from modules.recons.agentic import _schedule_correcting_entry, _schedule_proposed_entries


class _FakeSnap:
    def __init__(self, qid, num, name):
        self.qbo_account_id = qid
        self.account_number = num
        self.account_name = name


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


def test_schedule_correcting_entry_credits_asset_when_gl_too_high():
    # Prepaid: schedule says 1,000 but GL shows 1,240 (amortization not booked).
    # Correcting JE reduces the asset: Dr Amortization expense / Cr Prepaid.
    e = _schedule_correcting_entry(
        schedule_type="prepaid", qid="ACCT1", number="1300",
        name="Prepaid Insurance", sl=Decimal("1000"), gl_balance=Decimal("1240"),
        gap=Decimal("240"),
    )
    lines = normalize_lines(e["lines"])
    assert lines_balanced(lines)
    cr = next(ln for ln in lines if Decimal(ln["credit"]) > 0)
    dr = next(ln for ln in lines if Decimal(ln["debit"]) > 0)
    assert cr["account_qbo_id"] == "ACCT1" and cr["credit"] == "240.00"
    assert dr["account_name"] == "Amortization expense"
    assert e["confidence"] == "medium"   # offset is a placeholder to confirm


def test_schedule_correcting_entry_debits_asset_when_gl_too_low():
    # Schedule says 1,000 but GL shows 760 — asset understated, needs a debit.
    e = _schedule_correcting_entry(
        schedule_type="prepaid", qid="ACCT1", number="1300",
        name="Prepaid Insurance", sl=Decimal("1000"), gl_balance=Decimal("760"),
        gap=Decimal("-240"),
    )
    lines = normalize_lines(e["lines"])
    assert lines_balanced(lines)
    dr = next(ln for ln in lines if Decimal(ln["debit"]) > 0)
    assert dr["account_qbo_id"] == "ACCT1" and dr["debit"] == "240.00"


def test_schedule_proposed_entries_itemized_prepaid():
    # Two prepaid JE lines this period (initial + amortization) → two balanced
    # entries, each using the real offset (expense) account. With two items
    # both new this period this yields four total — what a CPA expects.
    snap = _FakeSnap("PREPAID1", "1300", "Prepaid Insurance")
    sched = {
        "schedule_type": "prepaid",
        "je_items": [
            {"txn_type": "Schedule (Initial)", "amount": "12000.00", "memo": "Annual policy",
             "offset_qbo_account_id": "6000", "offset_account_name": "Insurance expense"},
            {"txn_type": "Schedule (Amortization)", "amount": "-1000.00", "memo": "Annual policy",
             "offset_qbo_account_id": "6000", "offset_account_name": "Insurance expense"},
        ],
    }
    entries = _schedule_proposed_entries(sched=sched, snap=snap)
    assert len(entries) == 2

    # Initial: Dr Prepaid asset / Cr expense (parking).
    init = normalize_lines(entries[0]["lines"])
    assert lines_balanced(init)
    dr = next(ln for ln in init if Decimal(ln["debit"]) > 0)
    assert dr["account_qbo_id"] == "PREPAID1" and dr["debit"] == "12000.00"

    # Amortization: Dr expense / Cr Prepaid asset.
    amort = normalize_lines(entries[1]["lines"])
    assert lines_balanced(amort)
    cr = next(ln for ln in amort if Decimal(ln["credit"]) > 0)
    assert cr["account_qbo_id"] == "PREPAID1" and cr["credit"] == "1000.00"
    dr2 = next(ln for ln in amort if Decimal(ln["debit"]) > 0)
    assert dr2["account_qbo_id"] == "6000"          # real expense offset
    assert entries[1]["confidence"] == "high"       # offset is a real account


def test_schedule_proposed_entries_placeholder_offset_medium():
    # No offset account set → placeholder + medium confidence.
    snap = _FakeSnap("PREPAID1", "1300", "Prepaid Rent")
    sched = {"schedule_type": "prepaid", "je_items": [
        {"txn_type": "Schedule (Amortization)", "amount": "-500.00", "memo": "Rent",
         "offset_qbo_account_id": None, "offset_account_name": None},
    ]}
    entries = _schedule_proposed_entries(sched=sched, snap=snap)
    assert len(entries) == 1
    assert entries[0]["confidence"] == "medium"
    dr = next(ln for ln in normalize_lines(entries[0]["lines"]) if Decimal(ln["debit"]) > 0)
    assert dr["account_qbo_id"] is None and dr["account_name"] == "Amortization expense"


if __name__ == "__main__":
    test_normalize_lines_drops_empty_and_coerces()
    test_lines_balanced()
    test_bank_withdrawal_is_fee_debit_balanced()
    test_bank_deposit_is_income_credit_balanced()
    test_bank_uses_real_offset_account_when_present()
    test_bank_skips_zero_amount()
    test_schedule_correcting_entry_credits_asset_when_gl_too_high()
    test_schedule_correcting_entry_debits_asset_when_gl_too_low()
    test_schedule_proposed_entries_itemized_prepaid()
    test_schedule_proposed_entries_placeholder_offset_medium()
    print("PROPOSED_ENTRIES_OK")
