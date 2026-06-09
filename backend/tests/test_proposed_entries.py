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
    match_entry_to_qbo,
    normalize_lines,
)
from modules.recons.agentic import _schedule_correcting_entry, _schedule_proposed_entries


class _FakeSnap:
    def __init__(self, qid, num, name):
        self.qbo_account_id = qid
        self.account_number = num
        self.account_name = name


class _FakeEntry:
    def __init__(self, lines):
        self.lines = lines


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


def test_loan_monthly_payment_is_three_line_with_interest():
    # A loan period with origination + a principal+interest payment should yield
    # TWO proposed entries: the 2-line origination AND a 3-line monthly payment
    # (Dr loan principal / Dr interest expense / Cr cash). The bare principal
    # je_item must NOT also surface as its own 2-line entry (no double count).
    snap = _FakeSnap("LOAN1", "2700", "Term Loan Payable")
    sched = {
        "schedule_type": "loan",
        "je_items": [
            {"txn_type": "Schedule (Loan Origination)", "amount": "-100000.00",
             "memo": "Loan origination"},
            {"txn_type": "Schedule (Loan Payment)", "amount": "1200.00",
             "memo": "principal payment"},
        ],
        "payment_entries": [
            {"item_id": "x", "date": "2026-03-31", "description": "Term Loan",
             "principal": "1200.00", "interest": "500.00",
             "offset_qbo_account_id": "6500", "offset_account_name": "Interest expense"},
        ],
    }
    entries = _schedule_proposed_entries(sched=sched, snap=snap)
    assert len(entries) == 2, [e["description"] for e in entries]

    # The origination 2-line (Dr cash / Cr loan).
    orig = next(e for e in entries if "Origination" in e["description"])
    olines = normalize_lines(orig["lines"])
    assert lines_balanced(olines)
    assert len(olines) == 2

    # The 3-line monthly payment.
    pay = next(e for e in entries if "payment" in e["description"].lower())
    plines = normalize_lines(pay["lines"])
    assert lines_balanced(plines)
    assert len(plines) == 3, plines
    # Loan liability debited by principal.
    liab = next(ln for ln in plines if ln["account_qbo_id"] == "LOAN1")
    assert liab["debit"] == "1200.00"
    # Interest expense debited to the offset account.
    interest = next(ln for ln in plines if ln["account_qbo_id"] == "6500")
    assert interest["debit"] == "500.00"
    # Cash credited the full payment.
    cash = next(ln for ln in plines if Decimal(ln["credit"]) > 0)
    assert cash["credit"] == "1700.00"
    assert pay["confidence"] == "high"


def test_loan_origination_reclass_not_cash():
    # The loan-origination draft must NOT debit cash — the proceeds are usually
    # already booked and the bank reconciled, so re-debiting cash double-counts.
    # It credits the loan and flags the debit as a reclass to confirm (low conf).
    snap = _FakeSnap("LOAN1", "2700", "Term Loan Payable")
    sched = {
        "schedule_type": "loan",
        "je_items": [
            {"txn_type": "Schedule (Loan Origination)", "amount": "-100000.00",
             "memo": "Loan origination"},
        ],
        "payment_entries": [],
    }
    entries = _schedule_proposed_entries(sched=sched, snap=snap)
    assert len(entries) == 1
    e = entries[0]
    assert e["confidence"] == "low"
    lines = normalize_lines(e["lines"])
    assert lines_balanced(lines)
    # Loan liability credited for the full amount.
    cr = next(ln for ln in lines if Decimal(ln["credit"]) > 0)
    assert cr["account_qbo_id"] == "LOAN1" and cr["credit"] == "100000.00"
    # Debit side is a confirm-placeholder, NOT a posted (real) cash account.
    dr = next(ln for ln in lines if Decimal(ln["debit"]) > 0)
    assert dr["account_qbo_id"] is None
    assert "reclass" in e["rationale"].lower()
    assert "double-count" in e["rationale"].lower()


def test_loan_interest_only_payment_is_two_line():
    # Interest-only period: no principal movement, but the monthly interest
    # must still be proposed as a 2-line Dr interest / Cr cash entry.
    snap = _FakeSnap("LOAN1", "2700", "Term Loan Payable")
    sched = {
        "schedule_type": "loan",
        "je_items": [],
        "payment_entries": [
            {"item_id": "x", "date": "2026-03-31", "description": "IO Loan",
             "principal": "0.00", "interest": "750.00",
             "offset_qbo_account_id": None, "offset_account_name": None},
        ],
    }
    entries = _schedule_proposed_entries(sched=sched, snap=snap)
    assert len(entries) == 1
    plines = normalize_lines(entries[0]["lines"])
    assert lines_balanced(plines)
    assert len(plines) == 2, plines
    dr = next(ln for ln in plines if Decimal(ln["debit"]) > 0)
    assert dr["account_name"] == "Interest expense" and dr["debit"] == "750.00"
    cr = next(ln for ln in plines if Decimal(ln["credit"]) > 0)
    assert cr["credit"] == "750.00"
    assert entries[0]["confidence"] == "medium"   # no real offset account set


def test_match_entry_to_qbo_found():
    # A saved loan-origination reclass matches a real QBO JE with the same lines.
    entry = _FakeEntry([
        {"account_qbo_id": "LOAN1", "debit": "0.00", "credit": "100000.00"},
        {"account_qbo_id": "CASH1", "debit": "100000.00", "credit": "0.00"},
    ])
    jes = [{
        "doc": "JE-7", "id": "55",
        "lines": [
            {"account_id": "CASH1", "posting_type": "Debit", "amount": Decimal("100000.00")},
            {"account_id": "LOAN1", "posting_type": "Credit", "amount": Decimal("100000.00")},
        ],
    }]
    assert match_entry_to_qbo(entry, jes) == "JE-7"


def test_match_entry_to_qbo_not_found_wrong_account():
    # Same amounts, but the debit landed in a different account → no match.
    entry = _FakeEntry([
        {"account_qbo_id": "LOAN1", "debit": "0.00", "credit": "100000.00"},
        {"account_qbo_id": "CASH1", "debit": "100000.00", "credit": "0.00"},
    ])
    jes = [{"doc": "JE-9", "lines": [
        {"account_id": "LOAN1", "posting_type": "Credit", "amount": Decimal("100000.00")},
        {"account_id": "OTHER", "posting_type": "Debit", "amount": Decimal("100000.00")},
    ]}]
    assert match_entry_to_qbo(entry, jes) is None


def test_match_entry_to_qbo_placeholder_matches_on_amount():
    # A placeholder line (no account id) matches any account at that amount+type.
    entry = _FakeEntry([
        {"account_qbo_id": "LOAN1", "debit": "0.00", "credit": "100000.00"},
        {"account_qbo_id": None, "debit": "100000.00", "credit": "0.00"},
    ])
    jes = [{"doc": "JE-3", "lines": [
        {"account_id": "LOAN1", "posting_type": "Credit", "amount": Decimal("100000.00")},
        {"account_id": "CASH1", "posting_type": "Debit", "amount": Decimal("100000.00")},
    ]}]
    assert match_entry_to_qbo(entry, jes) == "JE-3"


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
    test_loan_monthly_payment_is_three_line_with_interest()
    test_loan_origination_reclass_not_cash()
    test_loan_interest_only_payment_is_two_line()
    test_match_entry_to_qbo_found()
    test_match_entry_to_qbo_not_found_wrong_account()
    test_match_entry_to_qbo_placeholder_matches_on_amount()
    print("PROPOSED_ENTRIES_OK")
