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
from datetime import timedelta as _timedelta
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


def _prepaid_method(item: SchedulePrepaid) -> str:
    """Return the item's amortization method. Defaults to daily_rate
    when the column hasn't been backfilled or any legacy data slips
    through with a NULL — keeps the math behavior stable across the
    migration boundary."""
    m = getattr(item, "amortization_method", None) or "daily_rate"
    return m if m in ("daily_rate", "straight_line") else "daily_rate"


def _prepaid_months_touched(item: SchedulePrepaid) -> int:
    """Count of distinct (year, month) pairs in [start, end]. Used for
    straight-line monthly amortization where each touched month gets
    total / N regardless of how many days within the month the item
    actually covers."""
    s, e = item.start_date, item.end_date
    if e < s:
        return 0
    return (e.year - s.year) * 12 + (e.month - s.month) + 1


def _prepaid_daily_rate(item: SchedulePrepaid) -> Decimal:
    """Total amount divided by inclusive day count over [start, end].

    Defined unconditionally for both methods — the per-item drill-in
    drawer renders it for reference even on straight-line items so the
    user can sanity-check against the JE amount they'd post."""
    total_days = max(1, _days_inclusive(item.start_date, item.end_date))
    return Decimal(item.total_amount) / Decimal(total_days)


def _prepaid_monthly_rate(item: SchedulePrepaid) -> Decimal:
    """Straight-line monthly rate = total / months_touched. Symmetric
    to _prepaid_daily_rate — defined for both methods so the per-item
    drill-in can show both rates and let the user pick which to trust."""
    n = max(1, _prepaid_months_touched(item))
    return Decimal(item.total_amount) / Decimal(n)


def _prepaid_amortized_through_dr(item: SchedulePrepaid, as_of: date) -> Decimal:
    """Daily-rate cumulative — linear per day."""
    if as_of < item.start_date:
        return ZERO
    end_day = min(as_of, item.end_date)
    elapsed_days = _days_inclusive(item.start_date, end_day)
    return _prepaid_daily_rate(item) * Decimal(elapsed_days)


def _prepaid_amortized_through_sl(item: SchedulePrepaid, as_of: date) -> Decimal:
    """Straight-line monthly cumulative — total/N recognized at each
    month-end touched by the item. Past end_date returns full total
    (the "tail" cleans up any rounding from partial last month).

    Cases:
      as_of < start         → 0
      as_of >= end          → total
      start <= as_of < end  → months_passed × monthly_rate, where
                              months_passed = count of month-ends in
                              [start, as_of] (inclusive). A month-end
                              counts when as_of is on or after the
                              last day of that month.
    """
    if as_of < item.start_date:
        return ZERO
    if as_of >= item.end_date:
        return Decimal(item.total_amount)

    months_passed = (as_of.year - item.start_date.year) * 12 + (as_of.month - item.start_date.month)
    last_of_as_of_month = monthrange(as_of.year, as_of.month)[1]
    if as_of.day >= last_of_as_of_month:
        months_passed += 1
    months_passed = max(0, months_passed)
    n = max(1, _prepaid_months_touched(item))
    if months_passed >= n:
        return Decimal(item.total_amount)  # safety: never over-amortize
    return _prepaid_monthly_rate(item) * Decimal(months_passed)


def _prepaid_amortized_through(item: SchedulePrepaid, as_of: date) -> Decimal:
    """Dispatch on amortization_method."""
    if _prepaid_method(item) == "straight_line":
        return _prepaid_amortized_through_sl(item, as_of)
    return _prepaid_amortized_through_dr(item, as_of)


def _prepaid_unamortized_as_of(item: SchedulePrepaid, as_of: date) -> Decimal:
    """How much of the prepaid total is still on the BS as of `as_of`."""
    if as_of < item.start_date:
        return Decimal(item.total_amount)
    if as_of >= item.end_date:
        return ZERO
    amortized = _prepaid_amortized_through(item, as_of)
    return max(ZERO, Decimal(item.total_amount) - amortized)


def _prepaid_period_expense_dr(item: SchedulePrepaid, p_start: date, p_end: date) -> Decimal:
    """Daily-rate expense for [p_start, p_end] = daily_rate × overlap_days."""
    overlap_start = max(p_start, item.start_date)
    overlap_end   = min(p_end,   item.end_date)
    overlap_days  = _days_inclusive(overlap_start, overlap_end)
    if overlap_days == 0:
        return ZERO
    return _prepaid_daily_rate(item) * Decimal(overlap_days)


def _prepaid_period_expense_sl(item: SchedulePrepaid, p_start: date, p_end: date) -> Decimal:
    """Straight-line monthly expense — derived as the DROP in
    unamortized balance between the prior period-end and p_end.

    This guarantees the JE for the period = (beginning - ending), so
    the snapshot's period_expense always matches the per-line sum.
    Avoids any drift from a separately-computed monthly rate.
    """
    if p_end < item.start_date or p_start > item.end_date:
        return ZERO
    prior_end = p_start - _timedelta(days=1)
    beg = _prepaid_unamortized_as_of(item, prior_end)
    end = _prepaid_unamortized_as_of(item, p_end)
    drop = beg - end
    if drop < ZERO:
        return ZERO
    return drop


def _prepaid_period_expense(item: SchedulePrepaid, p_start: date, p_end: date) -> Decimal:
    """
    Expense recognized in the [p_start, p_end] window. Dispatch on the
    item's amortization_method.
    """
    if _prepaid_method(item) == "straight_line":
        return _prepaid_period_expense_sl(item, p_start, p_end)
    return _prepaid_period_expense_dr(item, p_start, p_end)


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
        # Beginning balance = unamortized portion ALREADY on the books at
        # the end of the prior period. CRITICAL guard: an item that starts
        # THIS period (or later) was not yet on the balance sheet then, so
        # its beginning is ZERO and its full cost flows in via `additions`.
        #
        # Without this guard, _prepaid_unamortized_as_of returns the FULL
        # total for a not-yet-started item (its "as_of < start_date"
        # branch returns total, NOT zero — unlike the accrual/lease/loan
        # balance helpers which return zero before their start). That full
        # total then double-counts against `additions`, inflating
        # period_expense: a $12,000 Jan-start prepaid showed
        #   beginning 12,000 + additions 12,000 − ending 11,000 = 13,000
        # of "amortization" in its first month instead of the correct
        #   beginning 0 + additions 12,000 − ending 11,000 = 1,000.
        if it.start_date > prior_period_end:
            beg = ZERO
        else:
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
        # Interest accrual at the monthly rate on the principal outstanding
        # this period. When the loan originated this period (beg == 0), accrue
        # on the newly-booked principal so a mid-period loan still books a
        # month of interest instead of $0.
        if beg > ZERO or booked_this_period > ZERO:
            monthly_rate = Decimal(it.interest_rate_pct) / Decimal("100") / Decimal("12")
            base = beg if beg > ZERO else booked_this_period
            interest += base * monthly_rate
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


# ─── Per-item line helpers for the recon suggestion endpoints ──────────────
#
# These mirror the prepaid/accrual delta model: each item emits one or
# more signed line items per period that the recon's existing
# build-up math (opening + selected_items = SL) consumes directly.
#
# Sign convention is ALWAYS debit-positive (matches QBO TrialBalance
# + the recon's internal storage). The recon UI's flipSign() handles
# credit-natural display for liability accounts.


def _prior_period_end(period_end: date) -> date:
    """Last day of the calendar month ending immediately before period_end's month."""
    p_start, _ = _period_bounds(period_end)
    if p_start.month == 1:
        return date(p_start.year - 1, 12, 31)
    prev = p_start.month - 1
    return date(p_start.year, prev, monthrange(p_start.year, prev)[1])


# Fixed Assets ───
# COST account (qbo_account_id): additions when in_service_date in period,
#                                disposals when disposed_on in period.
# ACC. DEPRECIATION (accumulated_dep_qbo_account_id): negative delta for
# the period's straight-line depreciation (acc-dep is credit-natural; the
# balance grows MORE NEGATIVE in debit-positive terms, hence -value).


def fa_period_depreciation(item: ScheduleFixedAsset, p_start: date, p_end: date) -> Decimal:
    """SL depreciation expense for the days of the period the asset was in service."""
    if item.depreciation_method != "straight_line":
        return ZERO
    if item.useful_life_months <= 0:
        return ZERO
    depreciable = Decimal(item.cost) - Decimal(item.salvage_value)
    if depreciable <= ZERO:
        return ZERO
    monthly = depreciable / Decimal(item.useful_life_months)
    # Day-prorated within the period using the same calendar-day basis
    # as prepaids — cleaner for mid-month in-service dates.
    in_svc = item.in_service_date
    end_of_life = date.fromordinal(
        in_svc.toordinal() + int(item.useful_life_months * 30.4375)  # approximate; precision OK
    )
    if item.disposed_on is not None and item.disposed_on < end_of_life:
        end_of_life = item.disposed_on
    overlap_start = max(p_start, in_svc)
    overlap_end   = min(p_end,   end_of_life)
    days = _days_inclusive(overlap_start, overlap_end)
    if days == 0:
        return ZERO
    days_in_month = monthrange(p_end.year, p_end.month)[1]
    return monthly * (Decimal(days) / Decimal(days_in_month))


def fa_lines_for_account(items, qbo_account_id: str, p_start: date, p_end: date) -> list[dict]:
    """Emit signed delta lines for the account being reconciled."""
    out: list[dict] = []
    for it in items:
        if not it.is_active:
            continue
        # COST account events
        if it.qbo_account_id == qbo_account_id:
            if p_start <= it.in_service_date <= p_end:
                out.append({
                    "item_id":   str(it.id),
                    "line_kind": "addition",
                    "line_date": it.in_service_date.isoformat(),
                    "amount":    str(_q(Decimal(it.cost))),
                    "description": it.description,
                    "vendor":      it.vendor,
                    "reference":   it.reference,
                })
            if it.disposed_on is not None and p_start <= it.disposed_on <= p_end:
                out.append({
                    "item_id":   str(it.id),
                    "line_kind": "disposal",
                    "line_date": it.disposed_on.isoformat(),
                    "amount":    str(_q(-Decimal(it.cost))),
                    "description": it.description,
                    "vendor":      it.vendor,
                    "reference":   it.reference,
                })
        # ACCUMULATED DEPRECIATION account
        if it.accumulated_dep_qbo_account_id == qbo_account_id:
            dep = fa_period_depreciation(it, p_start, p_end)
            if dep > ZERO:
                out.append({
                    "item_id":   str(it.id),
                    "line_kind": "depreciation",
                    "line_date": p_end.isoformat(),
                    "amount":    str(_q(-dep)),  # acc-dep grows credit → debit-positive negative
                    "description": it.description,
                    "vendor":      it.vendor,
                    "reference":   it.reference,
                })
    return out


# Loans ───
# Liability balance shrinks each period by the principal portion of the
# payment. Origination emits a positive delta in debit-positive terms?
# No — loans are credit-natural; the balance starts negative and grows
# less negative as it's paid down. So origination = +principal (credit),
# principal payment = -principal_payment (debit reducing the credit).
# (Recon's flipSign converts these to debit-positive for storage.)


def loan_principal_paid_in_period(item: ScheduleLoan, p_start: date, p_end: date) -> Decimal:
    """Principal paid during [p_start, p_end] = balance_at_start - balance_at_end."""
    # Walk the amort table from loan_date up to each cap to get the balance.
    bal_at_prior = _loan_principal_as_of(item, _prior_period_end(p_end))
    bal_at_now   = _loan_principal_as_of(item, p_end)
    paid = bal_at_prior - bal_at_now
    return max(ZERO, paid)


def loan_lines_for_account(items, qbo_account_id: str, p_start: date, p_end: date) -> list[dict]:
    out: list[dict] = []
    for it in items:
        if not it.is_active:
            continue
        if it.qbo_account_id != qbo_account_id:
            continue
        if p_start <= it.loan_date <= p_end:
            out.append({
                "item_id":     str(it.id),
                "line_kind":   "origination",
                "line_date":   it.loan_date.isoformat(),
                "amount":      str(_q(Decimal(it.original_principal))),
                "description": it.description,
                "vendor":      it.lender,
                "reference":   it.reference,
            })
        # Principal payment for this period
        principal_paid = loan_principal_paid_in_period(it, p_start, p_end)
        if principal_paid > ZERO:
            out.append({
                "item_id":     str(it.id),
                "line_kind":   "principal_payment",
                "line_date":   p_end.isoformat(),
                "amount":      str(_q(-principal_paid)),
                "description": it.description,
                "vendor":      it.lender,
                "reference":   it.reference,
            })
    return out


# Leases ───
# Same model as loans: liability is credit-natural, initial recognition
# is + (credit booked), principal payment is - (reducing credit).
# Only emits lines for ASC 842 leases (where initial_liability is set).


def lease_principal_paid_in_period(item: ScheduleLease, p_start: date, p_end: date) -> Decimal:
    if item.initial_liability is None or item.discount_rate_pct is None:
        return ZERO
    bal_at_prior = _lease_liability_as_of(item, _prior_period_end(p_end))
    bal_at_now   = _lease_liability_as_of(item, p_end)
    paid = bal_at_prior - bal_at_now
    return max(ZERO, paid)


def lease_lines_for_account(items, qbo_account_id: str, p_start: date, p_end: date) -> list[dict]:
    out: list[dict] = []
    for it in items:
        if not it.is_active:
            continue
        if it.initial_liability is None or it.discount_rate_pct is None:
            continue  # cash-basis lease — no BS reconciliation
        if it.qbo_account_id != qbo_account_id:
            continue
        if p_start <= it.lease_start <= p_end:
            out.append({
                "item_id":     str(it.id),
                "line_kind":   "initial",
                "line_date":   it.lease_start.isoformat(),
                "amount":      str(_q(Decimal(it.initial_liability))),
                "description": it.description,
                "vendor":      it.lessor,
                "reference":   it.reference,
            })
        principal_paid = lease_principal_paid_in_period(it, p_start, p_end)
        if principal_paid > ZERO:
            out.append({
                "item_id":     str(it.id),
                "line_kind":   "principal_payment",
                "line_date":   p_end.isoformat(),
                "amount":      str(_q(-principal_paid)),
                "description": it.description,
                "vendor":      it.lessor,
                "reference":   it.reference,
            })
    return out


# ─── Type registry ─────────────────────────────────────────────────────────

SCHEDULE_TYPES = ("prepaid", "accrual", "fixed_asset", "lease", "loan")
