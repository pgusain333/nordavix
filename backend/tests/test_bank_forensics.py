"""Transaction-level forensics on cash.

The scanner's twelve detectors had never seen a bank account: `scan_period`
built its account list from `_EXPENSE_TYPES = ("expense", "cost of goods")`, so
every transaction-level check ran on the spend side and stopped. Cash got
balance-level reconciliation and nothing about the transactions themselves —
backwards for the risk, since the bank is the one account where being wrong
costs money rather than tidiness.

These tests exist because a fraud detector's failure mode is asymmetric and
BOTH directions are bad. Miss the real one and the product's core claim is
false. Cry wolf and people stop reading the list — after which the real one is
invisible anyway. So each detector is pinned on what it must catch AND on what
it must leave alone.
"""
from datetime import date
from decimal import Decimal as D

import pytest

from modules.gl_accuracy.bank_engine import (
    APPROVAL_THRESHOLDS,
    DUPLICATE_MIN,
    DUPLICATE_WINDOW_DAYS,
    NEW_PAYEE_MIN,
    as_finding_flag,
    bank_finding_key,
    detect_duplicate_payments,
    detect_new_payee_payments,
    detect_round_dollar,
    detect_sequence_gaps,
    detect_structuring,
    detect_unrecorded_withdrawals,
    detect_weekend_payments,
    run_bank_detectors,
    suppress_weaker_overlaps,
)


def txn(day, amount, payee="Acme Ltd", *, number=None, month=6, inflow=False):
    """A GL bank transaction. Amounts are debit-positive, so cash OUT is
    negative — the same convention the QBO general-ledger pull returns."""
    return {
        "qbo_txn_id": f"t{month}{day}-{amount}-{payee[:3]}",
        "txn_type": "Check", "txn_number": number,
        "txn_date": date(2026, month, day),
        "amount": D(str(amount if inflow else -amount)),
        "memo": "", "entity_name": payee,
        "qbo_account_id": "1", "qbo_account_name": "Operating Cash",
    }


# ── Duplicate payments ────────────────────────────────────────────────────

def test_the_same_invoice_paid_twice_is_caught():
    """The most money-recovering test in accounts payable, and it needs no
    cleverness: an invoice paid twice looks exactly like an invoice paid twice."""
    f = detect_duplicate_payments([txn(4, 1200), txn(7, 1200)])
    assert len(f) == 1
    assert f[0]["severity"] == "high"
    assert "1,200.00" in f[0]["title"]


def test_the_same_amount_to_different_payees_is_not_a_duplicate():
    """Two suppliers can invoice the same round figure in the same week."""
    assert detect_duplicate_payments([txn(4, 1200, "Acme Ltd"), txn(7, 1200, "Bilt Co")]) == []


def test_a_recurring_bill_months_apart_is_not_a_duplicate():
    """THE FALSE POSITIVE THAT WOULD KILL IT. Rent is the same amount every
    month to the same landlord. Flagging that would put a duplicate on every
    close, and the list would stop being read."""
    far = [txn(4, 5000, "Landlord", month=5), txn(4, 5000, "Landlord", month=7)]
    assert detect_duplicate_payments(far) == []


def test_the_window_is_what_separates_the_two():
    inside = [txn(4, 5000, "Landlord"), txn(4 + DUPLICATE_WINDOW_DAYS, 5000, "Landlord")]
    outside = [txn(4, 5000, "Landlord"), txn(4 + DUPLICATE_WINDOW_DAYS + 5, 5000, "Landlord")]
    assert len(detect_duplicate_payments(inside)) == 1
    assert detect_duplicate_payments(outside) == []


def test_small_duplicates_are_beneath_notice():
    small = int(DUPLICATE_MIN) - 1
    assert detect_duplicate_payments([txn(4, small), txn(6, small)]) == []


def test_money_coming_in_is_never_a_duplicate_payment():
    """Two customer receipts of the same amount is a good week, not a finding.
    Every detector here is about outflow; mixing the directions would flag
    ordinary receipts as suspicious."""
    assert detect_duplicate_payments(
        [txn(4, 1200, inflow=True), txn(6, 1200, inflow=True)]) == []


def test_a_duplicate_carries_the_transactions_behind_it():
    """A forensic flag a reviewer cannot inspect is one they can only accept or
    ignore — and the ones they ignore are the ones that mattered."""
    f = detect_duplicate_payments([txn(4, 1200), txn(7, 1200)])[0]
    assert len(f["evidence"]) == 2
    assert all(e["qbo_txn_id"] for e in f["evidence"])


# ── Money that left with no entry in the books ────────────────────────────

def test_an_unmatched_withdrawal_is_reported():
    """The strongest signal available: a payment the books do not know about is
    either an error nobody caught or a payment nobody authorised."""
    lines = [{"qbo_account_id": "1", "txn_date": date(2026, 6, 20),
              "amount": D("-2450"), "description": "ATM WITHDRAWAL",
              "match_status": "unmatched"}]
    f = detect_unrecorded_withdrawals(lines)
    assert len(f) == 1 and f[0]["severity"] == "high"


def test_a_matched_withdrawal_is_not():
    lines = [{"qbo_account_id": "1", "txn_date": date(2026, 6, 20),
              "amount": D("-2450"), "description": "Paid", "match_status": "matched"}]
    assert detect_unrecorded_withdrawals(lines) == []


def test_an_unmatched_deposit_is_a_different_question():
    """Money arriving unexpectedly is a completeness issue for the recon, not a
    fraud finding — and reporting it here would double-report what the
    reconciliation already shows."""
    lines = [{"qbo_account_id": "1", "txn_date": date(2026, 6, 20),
              "amount": D("2450"), "description": "Deposit", "match_status": "unmatched"}]
    assert detect_unrecorded_withdrawals(lines) == []


# ── Payments arranged under an approval limit ─────────────────────────────

def test_repeated_payments_just_under_a_limit_are_flagged():
    """One payment of 4,900 is a payment. Three is a pattern, and it is the
    shape of spend split to avoid a second signature."""
    f = detect_structuring([txn(d, 4900, "Bilt Co") for d in (3, 9, 15)])
    assert len(f) == 1
    assert "5,000" in f[0]["title"]


def test_two_are_not_yet_a_pattern():
    assert detect_structuring([txn(3, 4900, "Bilt Co"), txn(9, 4900, "Bilt Co")]) == []


def test_payments_well_under_the_limit_are_not_structuring():
    """3,000 against a 5,000 limit is just a payment. Only the band immediately
    beneath the threshold means anything."""
    assert detect_structuring([txn(d, 3000, "Bilt Co") for d in (3, 9, 15)]) == []


def test_a_payment_over_the_limit_is_not_structuring():
    """Someone avoiding a limit does not exceed it. Flagging large payments
    here would make every real invoice suspicious."""
    assert detect_structuring([txn(d, 5200, "Bilt Co") for d in (3, 9, 15)]) == []


def test_it_never_accuses():
    """The product cannot know whether a limit was being avoided or a supplier
    simply invoices in that range. A detector that asserts intent is one a firm
    cannot show a client."""
    f = detect_structuring([txn(d, 4900, "Bilt Co") for d in (3, 9, 15)])[0]
    blob = (f["title"] + f["detail"]).lower()
    assert "fraud" not in blob and "deliberate" not in blob
    assert "worth confirming" in blob


@pytest.mark.parametrize("threshold", APPROVAL_THRESHOLDS)
def test_every_declared_threshold_is_actually_checked(threshold):
    just_under = int(threshold * D("0.98"))
    f = detect_structuring([txn(d, just_under, "Bilt Co") for d in (3, 9, 15)])
    assert len(f) >= 1


# ── A new payee, and the rest ─────────────────────────────────────────────

def test_a_large_first_payment_to_a_new_payee_is_flagged():
    """Every fictitious-vendor scheme has a first payment."""
    f = detect_new_payee_payments([txn(6, int(NEW_PAYEE_MIN) + 1, "Newco")], [])
    assert len(f) == 1


def test_a_payee_already_in_the_history_is_not_new():
    hist = [txn(1, 500, "Newco", month=3)]
    assert detect_new_payee_payments([txn(6, 9000, "Newco")], hist) == []


def test_a_small_first_payment_is_not_worth_asking_about():
    assert detect_new_payee_payments([txn(6, int(NEW_PAYEE_MIN) - 1, "Newco")], []) == []


def test_a_new_payee_is_reported_once_not_per_payment():
    """Three payments to one new supplier is one question."""
    txns = [txn(d, 9000, "Newco") for d in (6, 8, 10)]
    assert len(detect_new_payee_payments(txns, [])) == 1


def test_a_gap_in_the_cheque_run_is_flagged():
    """A cheque written and never recorded leaves a hole in the sequence, and
    the hole is the only trace it leaves anywhere."""
    txns = [txn(d, 100, number=str(n)) for d, n in [(1, 1001), (2, 1002), (4, 1004)]]
    f = detect_sequence_gaps(txns)
    assert len(f) == 1 and "1003" in f[0]["detail"]


def test_a_huge_jump_is_a_new_cheque_book_not_a_missing_cheque():
    txns = [txn(d, 100, number=str(n)) for d, n in [(1, 1001), (2, 1002), (4, 5000)]]
    assert detect_sequence_gaps(txns) == []


def test_round_dollar_payments_are_flagged_quietly():
    """Round amounts are normal for transfers, rent and loans — so this is
    reported as unusual, never as irregular."""
    f = detect_round_dollar([txn(4, 3000, "Rent LLC")])
    assert len(f) == 1 and f[0]["severity"] == "low"


def test_an_ordinary_invoice_amount_is_not_round():
    assert detect_round_dollar([txn(4, 3147, "Supplier")]) == []


def test_a_weekend_payment_is_a_question_not_a_finding():
    f = detect_weekend_payments([txn(6, 7000, "Weekend Ltd")])   # 6 Jun 2026 = Saturday
    assert len(f) == 1 and f[0]["severity"] == "low"


def test_a_weekday_payment_is_not():
    assert detect_weekend_payments([txn(4, 7000, "Weekday Ltd")]) == []   # Thursday


# ── Not saying the same thing three times ─────────────────────────────────

def test_a_louder_finding_silences_the_curiosities_about_the_same_money():
    """THE NOISE PROBLEM. A 9,000 payment to a brand-new payee on a Saturday
    was producing three findings — new payee, round dollar, weekend. Each true,
    and together they teach a reviewer to skim, which is exactly how the one
    that mattered gets missed."""
    kinds = {f["kind"] for f in run_bank_detectors([txn(6, 9000, "Newco")], [], [])}
    assert kinds == {"bank_new_payee"}


def test_two_high_findings_on_the_same_money_are_both_kept():
    """Paid three times AND arranged under a limit are two genuine questions
    with two different answers. Suppression only ever removes the quiet ones."""
    txns = [txn(d, 4900, "Bilt Co") for d in (3, 9, 15)]
    kinds = {f["kind"] for f in run_bank_detectors(txns, [], [])}
    assert "bank_duplicate_payment" in kinds and "bank_structuring" in kinds


def test_a_lone_curiosity_survives():
    """Nothing louder covers it, so it stays."""
    kinds = {f["kind"] for f in suppress_weaker_overlaps(detect_round_dollar([txn(4, 3000, "Rent")]))}
    assert kinds == {"bank_round_dollar"}


# ── It joins the existing pipeline rather than a parallel one ─────────────

def test_a_bank_flag_becomes_an_ordinary_finding():
    """The whole design. There is no bank-findings table — a bank flag becomes
    a GlAccuracyFinding, and inherits dispositions, Client Memory, proposed
    entries, Risk Radar, the review memo and its graph edges without any of it
    being rebuilt."""
    f = as_finding_flag(detect_duplicate_payments([txn(4, 1200), txn(7, 1200)])[0])
    assert f["dedupe_key"] and f["posted_account_id"] == "1"
    assert f["posted_account_name"] == "Operating Cash"


def test_a_duplicate_is_review_only_not_a_journal_entry():
    """The answer to paying an invoice twice is to recover the money, not to
    recode it. "flag" is the word the page already understands for that —
    inventing a third one would produce a finding the UI could offer no correct
    action for."""
    f = as_finding_flag(detect_duplicate_payments([txn(4, 1200), txn(7, 1200)])[0])
    assert f["action_kind"] == "flag"


def test_an_unrecorded_withdrawal_DOES_want_an_entry():
    """Here the books are genuinely missing a transaction, so the reviewer
    should get the draft rather than an acknowledgement."""
    lines = [{"qbo_account_id": "1", "txn_date": date(2026, 6, 20),
              "amount": D("-2450"), "description": "ATM WITHDRAWAL",
              "match_status": "unmatched"}]
    f = as_finding_flag(detect_unrecorded_withdrawals(lines)[0])
    assert f["action_kind"] == "reclass"


def test_the_key_is_stable_across_rescans():
    """A re-scan must update a finding, not create a second one — or a
    disposition made last week comes back next week."""
    a = detect_duplicate_payments([txn(4, 1200), txn(7, 1200)])[0]
    b = detect_duplicate_payments([txn(4, 1200), txn(7, 1200), txn(9, 1200)])[0]
    assert bank_finding_key(a) == bank_finding_key(b)


def test_different_problems_get_different_keys():
    a = detect_duplicate_payments([txn(4, 1200, "Acme Ltd"), txn(7, 1200, "Acme Ltd")])[0]
    b = detect_duplicate_payments([txn(4, 1200, "Bilt Co"), txn(7, 1200, "Bilt Co")])[0]
    assert bank_finding_key(a) != bank_finding_key(b)
