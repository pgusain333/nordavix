"""
Invariant: schedule liability roll-forward (loans + leases) books interest in
the origination / inception month.

backend/modules/schedules/calc.py had (and the lease half had regressed to) a
$0 first-month interest bug: when a loan/lease starts in the reported period the
beginning balance is 0, so `interest += beginning * rate` accrued nothing. Both
now accrue on the newly-recognized principal/liability (the loan fix + C1-5).
This locks that — plus the basic liability roll-forward figures — so the bug
can't silently return. calc.py otherwise has no automated coverage.

Pure (no DB / async), so it also runs standalone:
    python tests/test_schedule_rollforward.py
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from modules.schedules.calc import roll_leases, roll_loans, roll_prepaids


def test_loan_origination_month_accrues_interest():
    # 100k @ 12%/yr, $2,000/mo, originated in the reported month.
    loan = SimpleNamespace(
        is_active=True, original_principal=100000, interest_rate_pct=12,
        term_months=60, monthly_payment=2000, loan_date=date(2025, 3, 1),
        payment_type="amortizing",
    )
    m = roll_loans([loan], date(2025, 3, 31))
    assert m.beginning_balance == Decimal("0"), m.beginning_balance
    assert m.additions == Decimal("100000"), m.additions
    # Interest on the newly-booked principal (100000 * 1%) — never $0.
    assert m.period_expense == Decimal("1000"), m.period_expense
    assert m.payments == Decimal("1000"), m.payments            # principal paid down
    assert m.ending_balance == Decimal("99000"), m.ending_balance


def test_lease_inception_month_accrues_interest():
    # 500k liability @ 6%/yr, $9,000/mo, commencing in the reported month.
    lease = SimpleNamespace(
        is_active=True, initial_liability=500000, discount_rate_pct=6,
        monthly_payment=9000, lease_start=date(2025, 3, 1), lease_end=date(2030, 3, 1),
    )
    m = roll_leases([lease], date(2025, 3, 31))
    assert m.beginning_balance == Decimal("0"), m.beginning_balance
    assert m.additions == Decimal("500000"), m.additions
    # C1-5: inception-month interest on the new liability (500000 * 0.5%) — was $0.
    assert m.period_expense == Decimal("2500"), m.period_expense
    assert m.payments == Decimal("9000"), m.payments
    assert m.ending_balance == Decimal("493500"), m.ending_balance
    # Liability roll-forward ties: end == begin + additions - payment + interest.
    assert (m.beginning_balance + m.additions - m.payments + m.period_expense) == m.ending_balance


def test_ongoing_lease_still_accrues_on_beginning_balance():
    # Same lease commenced two months earlier — the inception fix must not change
    # the ongoing case: interest still accrues on the beginning balance (> 0).
    lease = SimpleNamespace(
        is_active=True, initial_liability=500000, discount_rate_pct=6,
        monthly_payment=9000, lease_start=date(2025, 1, 1), lease_end=date(2030, 1, 1),
    )
    m = roll_leases([lease], date(2025, 3, 31))
    assert m.beginning_balance > Decimal("0"), m.beginning_balance
    assert m.period_expense == Decimal("2434.8375"), m.period_expense


if __name__ == "__main__":
    test_loan_origination_month_accrues_interest()
    test_lease_inception_month_accrues_interest()
    test_ongoing_lease_still_accrues_on_beginning_balance()
    print("SCHEDULE_ROLLFORWARD_OK")


# ─── Prepaids ────────────────────────────────────────────────────────────────
#
# The header above says calc.py "otherwise has no automated coverage", and the
# prepaid half proved it. `_prepaid_unamortized_as_of` returned an item's FULL
# total for a date before it started — a June policy sitting on the May balance
# sheet at its whole cost. `roll_prepaids` had a local guard on its BEGINNING
# balance and none on its ENDING, so on a May close with a $48,000 policy
# starting 1 June the screen read:
#
#     beginning 30,000 · additions 0 · amortization 0 · ending 75,000
#
# The real $3,000 of May amortization computed as 30,000 − 75,000, came out
# negative, hit the never-negative clamp and was reported as zero; the UI then
# drew a $45,000 "other" bar to make the waterfall tie. Committing that pushed
# the inflated ending into the recon as the subledger.
#
# The invariant test below is the one that would have caught it on day one.

def _prepaid(total, start, end, method="straight_line"):
    return SimpleNamespace(
        is_active=True, total_amount=Decimal(str(total)),
        start_date=start, end_date=end, amortization_method=method,
    )


# The exact three items from the report, so a regression reproduces it.
_RENT      = _prepaid(12000, date(2026, 3, 1), date(2027, 2, 28))   # 1,000/mo
_INSURANCE = _prepaid(24000, date(2026, 3, 1), date(2027, 2, 28))   # 2,000/mo
_FUTURE    = _prepaid(48000, date(2026, 6, 1), date(2027, 5, 31))   # 4,000/mo, starts June


def test_a_prepaid_that_has_not_started_is_not_on_the_balance_sheet():
    """The root cause, at the helper. Asking what is on the books in May for a
    policy that starts in June has one answer, and it is nothing."""
    from modules.schedules.calc import _prepaid_unamortized_as_of
    assert _prepaid_unamortized_as_of(_FUTURE, date(2026, 5, 31)) == Decimal("0")


def test_a_future_prepaid_does_not_inflate_this_period_ending_balance():
    """The reported symptom: ending 75,000 on a book that held 27,000."""
    m = roll_prepaids([_RENT, _INSURANCE, _FUTURE], date(2026, 5, 31))
    assert m.ending_balance == Decimal("27000.00"), m.ending_balance


def test_amortization_is_reported_when_items_are_amortizing():
    """It read $0 while two policies were expensing 3,000 between them."""
    m = roll_prepaids([_RENT, _INSURANCE, _FUTURE], date(2026, 5, 31))
    assert m.period_expense == Decimal("3000.00"), m.period_expense


def test_a_future_prepaid_is_not_counted_as_contributing_to_the_period():
    """"3 active items contributing" was printed under a period two of them
    touched. Active is a property of the record; contributing is a property of
    the period, and only the second one belongs in that sentence."""
    m = roll_prepaids([_RENT, _INSURANCE, _FUTURE], date(2026, 5, 31))
    assert m.item_count == 2, m.item_count


def test_the_policy_lands_in_full_the_month_it_starts():
    """June: the 48,000 arrives as an addition and takes its first 4,000 of
    amortization alongside the other two."""
    m = roll_prepaids([_RENT, _INSURANCE, _FUTURE], date(2026, 6, 30))
    assert m.beginning_balance == Decimal("27000.00"), m.beginning_balance
    assert m.additions == Decimal("48000.00"), m.additions
    assert m.period_expense == Decimal("7000.00"), m.period_expense
    assert m.ending_balance == Decimal("68000.00"), m.ending_balance
    assert m.item_count == 3


def test_the_waterfall_always_ties():
    """beginning + additions − expense = ending, with nothing left over.

    THE test. The UI draws any residual as an "± Other" bar so the chart ties
    visually whatever the numbers do, which is exactly how a 45,000 hole went
    unnoticed. Checked across the policy's whole life, including the months
    before it starts and after it ends.
    """
    items = [_RENT, _INSURANCE, _FUTURE]
    for pe in (date(2026, 2, 28), date(2026, 3, 31), date(2026, 5, 31),
               date(2026, 6, 30), date(2026, 12, 31), date(2027, 2, 28),
               date(2027, 5, 31), date(2027, 6, 30)):
        m = roll_prepaids(items, pe)
        residual = (m.beginning_balance + m.additions
                    - m.period_expense - m.payments - m.other - m.ending_balance)
        assert residual == Decimal("0"), f"{pe}: unexplained {residual}"


def test_nothing_is_on_the_books_before_the_first_policy_starts():
    m = roll_prepaids([_RENT, _INSURANCE, _FUTURE], date(2026, 1, 31))
    assert m.beginning_balance == Decimal("0")
    assert m.ending_balance == Decimal("0")
    assert m.period_expense == Decimal("0")
    assert m.item_count == 0


def test_a_finished_policy_leaves_the_balance_sheet():
    """After the last window closes the schedule is empty, not carrying a tail."""
    m = roll_prepaids([_RENT, _INSURANCE, _FUTURE], date(2027, 6, 30))
    assert m.ending_balance == Decimal("0"), m.ending_balance
