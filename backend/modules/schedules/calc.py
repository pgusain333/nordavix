"""
Schedule math.

All period-end roll-forward computation lives here so the router stays
thin and the formulas are testable in one place. Every function takes
the current items + a target period_end and returns the snapshot
shape: { beginning, additions, period_expense, payments, other,
ending, item_count }.

Conventions:
  * All amounts are Decimal (never float — accounting precision).
  * "period" means the calendar month ending on period_end.
  * "beginning_balance" = balance on the day BEFORE period_start
    (= last day of prior month). For prepaids and FA that's
    derived from item dates; for loans/leases it's the prior
    period's ending balance.
"""
from __future__ import annotations

from calendar import monthrange
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from models.schedule import (
    ScheduleAccrual,
    ScheduleFixedAsset,
    ScheduleLease,
    ScheduleLoan,
    SchedulePrepaid,
)

ZERO = Decimal("0.00")


def _q(d: Decimal) -> Decimal:
    """Quantize to 2 decimal places — every dollar amount we return."""
    return d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _period_bounds(period_end: date) -> tuple[date, date]:
    """Return (period_start, period_end) for the calendar month ending on period_end.

    Most period_ends are last-of-month, but we tolerate mid-month
    period_ends (e.g., custom close dates) by using period_end as the
    upper bound and the first of THAT month as the lower bound.
    """
    period_start = period_end.replace(day=1)
    return period_start, period_end


# ─── Date math ──────────────────────────────────────────────────────────────


def _months_between(start: date, end: date) -> int:
    """
    Whole months from start through end, inclusive on start.

    Used for amortization elapsed-month counting. e.g.:
      2025-01-15 → 2025-04-15  ==> 3 (Feb, Mar, Apr elapsed; start month not counted)
      2025-01-01 → 2025-01-31  ==> 1 (first month is fully elapsed)
    We count months whose END is on or before `end`.
    """
    if end < start:
        return 0
    months = (end.year - start.year) * 12 + (end.month - start.month)
    # If end's day is past the last-of-month for start, that's a full month.
    # Simpler: if end day >= last-day-of-end-month -> full month elapsed.
    last_of_end = monthrange(end.year, end.month)[1]
    if end.day >= last_of_end:
        months += 1
    return max(0, months)


def _is_active_in_period(item_start: date, item_end: date | None, p_start: date, p_end: date) -> bool:
    """Item overlaps the [p_start, p_end] window?"""
    if item_end is not None and item_end < p_start:
        return False
    return item_start <= p_end


# ─── Snapshot output shape ─────────────────────────────────────────────────


@dataclass
class SnapshotMath:
    beginning_balance: Decimal
    additions:         Decimal
    period_expense:    Decimal
    payments:          Decimal
    other:             Decimal
    ending_balance:    Decimal
    item_count:        int

    def as_dict(self) -> dict:
        return {
            "beginning_balance": str(_q(self.beginning_balance)),
            "additions":         str(_q(self.additions)),
            "period_expense":    str(_q(self.period_expense)),
            "payments":          str(_q(self.payments)),
            "other":             str(_q(self.other)),
            "ending_balance":    str(_q(self.ending_balance)),
            "item_count":        self.item_count,
        }


# ─── Prepaids ──────────────────────────────────────────────────────────────
#
# DAYS-based amortization (not monthly). Each prepaid is amortized
# straight-line by calendar day across [start_date, end_date]. This is
# more precise than calendar-month bucketing — a policy that starts
# mid-month gets exactly the partial slice for that month, and short
# vs long months expense the right proportion of the daily rate.
#
# Convention: both endpoints inclusive. A Jan 1 → Dec 31 policy has
# 365 days; Jan 1 → Jan 31 has 31 days. Daily rate is computed once
# per item and reused for both period_expense and unamortized lookups.


def _days_inclusive(start: date, end: date) -> int:
    """Inclusive day count between start and end. Returns 0 if end < start."""
    if end < start:
        return 0
    return (end - start).days + 1


def _prepaid_daily_rate(item: SchedulePrepaid) -> Decimal:
    """Total amount divided by inclusive day count over [start, end]."""
    total_days = max(1, _days_inclusive(item.start_date, item.end_date))
    return Decimal(item.total_amount) / Decimal(total_days)


def _prepaid_amortized_through(item: SchedulePrepaid, as_of: date) -> Decimal:
    """Cumulative expense recognized from start_date through `as_of`."""
    if as_of < item.start_date:
        return ZERO
    end_day = min(as_of, item.end_date)
    elapsed_days = _days_inclusive(item.start_date, end_day)
    return _prepaid_daily_rate(item) * Decimal(elapsed_days)


def _prepaid_unamortized_as_of(item: SchedulePrepaid, as_of: date) -> Decimal:
    """How much of the prepaid total is still on the BS as of `as_of`."""
    if as_of < item.start_date:
        return Decimal(item.total_amount)
    if as_of >= item.end_date:
        return ZERO
    amortized = _prepaid_amortized_through(item, as_of)
    return max(ZERO, Decimal(item.total_amount) - amortized)


def _prepaid_period_expense(item: SchedulePrepaid, p_start: date, p_end: date) -> Decimal:
    """
    Expense recognized in the [p_start, p_end] window.

    = daily_rate × (days of overlap between [p_start, p_end] and [start_date, end_date])
    """
    overlap_start = max(p_start, item.start_date)
    overlap_end   = min(p_end,   item.end_date)
    overlap_days  = _days_inclusive(overlap_start, overlap_end)
    if overlap_days == 0:
        return ZERO
    return _prepaid_daily_rate(item) * Decimal(overlap_days)


def roll_prepaids(items: Iterable[SchedulePrepaid], period_end: date) -> SnapshotMath:
    p_start, p_end = _period_bounds(period_end)
    prior_end = date(p_start.year, p_start.month, 1)  # day before p_start
    # The "day before p_start" is p_start - 1 day
    if p_start.month == 1:
        prior_period_end = date(p_start.year - 1, 12, 31)
    else:
        prev_month = p_start.month - 1
        prior_period_end = date(p_start.year, prev_month, monthrange(p_start.year, prev_month)[1])
    _ = prior_end  # keep name in scope for clarity

    beginning = ZERO
    ending = ZERO
    additions = ZERO
    active_count = 0
    for it in items:
        if not it.is_active:
            continue
        # Beginning = unamortized at end of prior period
        beg = _prepaid_unamortized_as_of(it, prior_period_end)
        end = _prepaid_unamortized_as_of(it, p_end)
        beginning += beg
        ending += end
        # New prepaids started THIS period contribute as additions
        if p_start <= it.start_date <= p_end:
            additions += Decimal(it.total_amount)
        if end > ZERO or beg > ZERO or (p_start <= it.start_date <= p_end):
            active_count += 1
    # Expense = balance drop NOT explained by new additions
    period_expense = (beginning + additions) - ending
    if period_expense < ZERO:
        period_expense = ZERO  # safety: never negative
    return SnapshotMath(
        beginning_balance=beginning,
        additions=additions,
        period_expense=period_expense,
        payments=ZERO,
        other=ZERO,
        ending_balance=ending,
        item_count=active_count,
    )


# ─── Accruals ───────────────────────────────────────────────────────────────


def _accrual_balance_as_of(item: ScheduleAccrual, as_of: date) -> Decimal:
    """Accrual contributes to the BS balance if accrued by as_of AND not yet reversed."""
    if item.accrual_date > as_of:
        return ZERO
    if item.is_reversed:
        # Manually marked reversed — gone as soon as that flag is set.
        # We don't store the reversal date when flagged, so treat as zero.
        return ZERO
    if item.reverses_on is not None and item.reverses_on <= as_of:
        return ZERO
    return Decimal(item.amount)


def roll_accruals(items: Iterable[ScheduleAccrual], period_end: date) -> SnapshotMath:
    p_start, p_end = _period_bounds(period_end)
    if p_start.month == 1:
        prior_period_end = date(p_start.year - 1, 12, 31)
    else:
        prev_month = p_start.month - 1
        prior_period_end = date(p_start.year, prev_month, monthrange(p_start.year, prev_month)[1])

    beginning = ZERO
    ending = ZERO
    additions = ZERO
    payments = ZERO
    active_count = 0
    for it in items:
        if not it.is_active:
            continue
        beg = _accrual_balance_as_of(it, prior_period_end)
        end = _accrual_balance_as_of(it, p_end)
        beginning += beg
        ending += end
        # New accruals booked this period
        if p_start <= it.accrual_date <= p_end:
            additions += Decimal(it.amount)
        # Reversals this period
        if it.reverses_on is not None and p_start <= it.reverses_on <= p_end:
            payments += Decimal(it.amount)
        if beg > ZERO or end > ZERO or p_start <= it.accrual_date <= p_end:
            active_count += 1
    return SnapshotMath(
        beginning_balance=beginning,
        additions=additions,
        period_expense=ZERO,
        payments=payments,
        other=ZERO,
        ending_balance=ending,
        item_count=active_count,
    )


# ─── Fixed Assets ──────────────────────────────────────────────────────────


def _fa_accumulated_dep_as_of(item: ScheduleFixedAsset, as_of: date) -> Decimal:
    """Accumulated straight-line depreciation through `as_of`."""
    if as_of < item.in_service_date:
        return ZERO
    if item.depreciation_method != "straight_line":
        # Only SL supported in v1 — others return 0 (UI shows N/A).
        return ZERO
    depreciable = Decimal(item.cost) - Decimal(item.salvage_value)
    if depreciable <= ZERO or item.useful_life_months <= 0:
        return ZERO
    monthly = depreciable / Decimal(item.useful_life_months)
    months = _months_between(item.in_service_date, as_of)
    months = min(months, item.useful_life_months)
    # Fully disposed assets — accumulated stops growing; remaining NBV
    # written off via disposal_proceeds. v1 leaves the NBV at disposal
    # as "other" for the disposing period.
    if item.disposed_on is not None and item.disposed_on <= as_of:
        disposal_months = _months_between(item.in_service_date, item.disposed_on)
        months = min(months, disposal_months)
    return monthly * Decimal(months)


def roll_fixed_assets(items: Iterable[ScheduleFixedAsset], period_end: date) -> SnapshotMath:
    """
    For FA the BS account is COST (gross). We report:
      beginning = sum of cost active as of prior period end
      additions = cost placed in service this period
      payments  = cost of assets disposed this period
      ending    = sum of cost still on the books at period_end
      period_expense = period depreciation (informational; lives in
                       the contra-asset Accumulated Depreciation
                       account, separate snapshot if needed)
    """
    p_start, p_end = _period_bounds(period_end)
    if p_start.month == 1:
        prior_period_end = date(p_start.year - 1, 12, 31)
    else:
        prev_month = p_start.month - 1
        prior_period_end = date(p_start.year, prev_month, monthrange(p_start.year, prev_month)[1])

    beginning = ZERO
    ending = ZERO
    additions = ZERO
    disposals = ZERO
    period_dep = ZERO
    item_count = 0
    for it in items:
        if not it.is_active:
            continue
        cost = Decimal(it.cost)
        in_svc_prior = it.in_service_date <= prior_period_end
        in_svc_now   = it.in_service_date <= p_end
        disposed_prior = it.disposed_on is not None and it.disposed_on <= prior_period_end
        disposed_now   = it.disposed_on is not None and it.disposed_on <= p_end

        if in_svc_prior and not disposed_prior:
            beginning += cost
        if in_svc_now and not disposed_now:
            ending += cost
            item_count += 1
        if p_start <= it.in_service_date <= p_end:
            additions += cost
        if it.disposed_on is not None and p_start <= it.disposed_on <= p_end:
            disposals += cost

        # Period depreciation — only if asset was in service for any
        # part of the period and not fully depreciated yet.
        dep_prior = _fa_accumulated_dep_as_of(it, prior_period_end)
        dep_now   = _fa_accumulated_dep_as_of(it, p_end)
        period_dep += (dep_now - dep_prior)

    return SnapshotMath(
        beginning_balance=beginning,
        additions=additions,
        period_expense=period_dep,
        payments=disposals,
        other=ZERO,
        ending_balance=ending,
        item_count=item_count,
    )


# ─── Leases ────────────────────────────────────────────────────────────────


def _lease_liability_as_of(item: ScheduleLease, as_of: date) -> Decimal:
    """
    ASC 842 liability roll-forward. If discount_rate_pct + initial_liability
    aren't set we treat the lease as cash-basis and report 0 liability.
    """
    if item.initial_liability is None or item.discount_rate_pct is None:
        return ZERO
    if as_of < item.lease_start:
        return ZERO
    if as_of >= item.lease_end:
        return ZERO
    monthly_rate = Decimal(item.discount_rate_pct) / Decimal("100") / Decimal("12")
    bal = Decimal(item.initial_liability)
    pay = Decimal(item.monthly_payment)
    # Step month-by-month from lease_start to as_of
    months_elapsed = _months_between(item.lease_start, as_of)
    for _ in range(months_elapsed):
        interest = bal * monthly_rate
        principal = pay - interest
        bal = max(ZERO, bal - principal)
        if bal <= ZERO:
            break
    return bal


def roll_leases(items: Iterable[ScheduleLease], period_end: date) -> SnapshotMath:
    """
    The qbo_account_id on a Lease item points to the LIABILITY account.
    Report liability roll-forward: beginning, + new additions, − payments,
    + interest accretion. Period_expense = interest expense for the period.
    """
    p_start, p_end = _period_bounds(period_end)
    if p_start.month == 1:
        prior_period_end = date(p_start.year - 1, 12, 31)
    else:
        prev_month = p_start.month - 1
        prior_period_end = date(p_start.year, prev_month, monthrange(p_start.year, prev_month)[1])

    beginning = ZERO
    ending = ZERO
    additions = ZERO
    payments = ZERO
    interest = ZERO
    item_count = 0
    for it in items:
        if not it.is_active:
            continue
        if it.initial_liability is None or it.discount_rate_pct is None:
            # Cash-basis lease — no BS liability. Track payments
            # only (operational info).
            if _is_active_in_period(it.lease_start, it.lease_end, p_start, p_end):
                payments += Decimal(it.monthly_payment)
                item_count += 1
            continue
        beg = _lease_liability_as_of(it, prior_period_end)
        end = _lease_liability_as_of(it, p_end)
        beginning += beg
        ending += end
        # Initial recognition (this period == lease_start month)
        if p_start <= it.lease_start <= p_end:
            additions += Decimal(it.initial_liability)
        # Payment + interest for this period (if active)
        if _is_active_in_period(it.lease_start, it.lease_end, p_start, p_end):
            payments += Decimal(it.monthly_payment)
            monthly_rate = Decimal(it.discount_rate_pct) / Decimal("100") / Decimal("12")
            interest += beg * monthly_rate
            item_count += 1
    return SnapshotMath(
        beginning_balance=beginning,
        additions=additions,
        period_expense=interest,
        payments=payments,
        other=ZERO,
        ending_balance=ending,
        item_count=item_count,
    )


# ─── Loans ─────────────────────────────────────────────────────────────────


def _loan_principal_as_of(item: ScheduleLoan, as_of: date) -> Decimal:
    """Outstanding principal balance as of `as_of`."""
    if as_of < item.loan_date:
        return ZERO
    monthly_rate = Decimal(item.interest_rate_pct) / Decimal("100") / Decimal("12")
    bal = Decimal(item.original_principal)
    months_elapsed = _months_between(item.loan_date, as_of)
    months_elapsed = min(months_elapsed, item.term_months)

    if item.payment_type == "interest_only":
        # Principal only paid at maturity
        if months_elapsed >= item.term_months:
            return ZERO
        return bal
    if item.payment_type == "balloon":
        # Treat as amortizing for simplicity; refinement in a later PR.
        pass

    pay = Decimal(item.monthly_payment) if item.monthly_payment is not None else ZERO
    if pay <= ZERO:
        return bal
    for _ in range(months_elapsed):
        interest = bal * monthly_rate
        principal = pay - interest
        bal = max(ZERO, bal - principal)
        if bal <= ZERO:
            break
    return bal


def roll_loans(items: Iterable[ScheduleLoan], period_end: date) -> SnapshotMath:
    p_start, p_end = _period_bounds(period_end)
    if p_start.month == 1:
        prior_period_end = date(p_start.year - 1, 12, 31)
    else:
        prev_month = p_start.month - 1
        prior_period_end = date(p_start.year, prev_month, monthrange(p_start.year, prev_month)[1])

    beginning = ZERO
    ending = ZERO
    additions = ZERO
    payments = ZERO  # principal paydown this period
    interest = ZERO
    item_count = 0
    for it in items:
        if not it.is_active:
            continue
        beg = _loan_principal_as_of(it, prior_period_end)
        end = _loan_principal_as_of(it, p_end)
        beginning += beg
        ending += end
        if p_start <= it.loan_date <= p_end:
            additions += Decimal(it.original_principal)
        # principal paid this period = beg + additions_this_period - end
        booked_this_period = Decimal(it.original_principal) if (p_start <= it.loan_date <= p_end) else ZERO
        period_principal = (beg + booked_this_period) - end
        if period_principal > ZERO:
            payments += period_principal
        # Interest accrual on opening balance at monthly rate
        if beg > ZERO or booked_this_period > ZERO:
            monthly_rate = Decimal(it.interest_rate_pct) / Decimal("100") / Decimal("12")
            interest += beg * monthly_rate
        if beg > ZERO or end > ZERO or booked_this_period > ZERO:
            item_count += 1
    return SnapshotMath(
        beginning_balance=beginning,
        additions=additions,
        period_expense=interest,
        payments=payments,
        other=ZERO,
        ending_balance=ending,
        item_count=item_count,
    )


# ─── Type registry ─────────────────────────────────────────────────────────

SCHEDULE_TYPES = ("prepaid", "accrual", "fixed_asset", "lease", "loan")
