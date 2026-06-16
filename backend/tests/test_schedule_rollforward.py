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

from modules.schedules.calc import roll_leases, roll_loans


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
