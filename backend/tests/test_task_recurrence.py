"""Recurring manual tasks — when the next occurrence lands.

The rule these pin down: a recurring close task advances only on completion,
period-first, and a monthly series stays on month-end forever. The month-end
cases are the ones that bite — naive `+30 days` or a raw day-of-month copy both
drift a September→February series off the end of the month, which silently
mis-dates every downstream due date.
"""
from datetime import date

import pytest

from modules.tasks.recurrence import (
    VALID_RECURRENCE,
    add_months,
    anchor_error,
    is_month_end,
    months_for,
    next_occurrence,
)

# ── add_months ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("start,months,expected", [
    (date(2026, 1, 15), 1,  date(2026, 2, 15)),
    (date(2026, 1, 31), 1,  date(2026, 2, 28)),   # clamped, not overflowed
    (date(2028, 1, 31), 1,  date(2028, 2, 29)),   # leap year
    (date(2026, 11, 30), 3, date(2027, 2, 28)),   # crosses the year boundary
    (date(2026, 3, 31), 12, date(2027, 3, 31)),
    (date(2026, 12, 31), 1, date(2027, 1, 31)),   # December → January
])
def test_add_months(start, months, expected):
    assert add_months(start, months) == expected


def test_add_months_never_overflows_into_the_next_month():
    """Jan 31 + 1 must not become Mar 3. A period end that slips into the
    following month would file the task under the wrong close entirely."""
    for m in range(1, 25):
        out = add_months(date(2026, 1, 31), m)
        expected_month = (0 + m) % 12 + 1
        assert out.month == expected_month


# ── is_month_end ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("d,expected", [
    (date(2026, 1, 31), True),
    (date(2026, 2, 28), True),
    (date(2028, 2, 28), False),   # 2028 is a leap year — the 29th is month end
    (date(2028, 2, 29), True),
    (date(2026, 4, 30), True),
    (date(2026, 4, 29), False),
])
def test_is_month_end(d, expected):
    assert is_month_end(d) is expected


# ── next_occurrence: the period anchor ──────────────────────────────────────

def test_monthly_advances_the_period_one_month():
    assert next_occurrence("monthly", date(2026, 9, 30), None) == (date(2026, 10, 31), None)


def test_monthly_series_stays_on_month_end_through_february():
    """The regression this file exists for. Feb 28 + 1 month clamps to Mar 28;
    without the month-end correction every later occurrence is three days early
    and the series never recovers."""
    pe = date(2026, 1, 31)
    seen = []
    for _ in range(13):
        pe, _due = next_occurrence("monthly", pe, None)
        seen.append(pe)
    assert seen == [
        date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30), date(2026, 5, 31),
        date(2026, 6, 30), date(2026, 7, 31), date(2026, 8, 31), date(2026, 9, 30),
        date(2026, 10, 31), date(2026, 11, 30), date(2026, 12, 31),
        date(2027, 1, 31), date(2027, 2, 28),
    ]
    assert all(is_month_end(d) for d in seen)


def test_quarterly_and_annual_intervals():
    assert next_occurrence("quarterly", date(2026, 3, 31), None)[0] == date(2026, 6, 30)
    assert next_occurrence("annually", date(2026, 12, 31), None)[0] == date(2027, 12, 31)


def test_due_date_keeps_its_distance_from_the_period():
    """A due date is an override, not a derivation — it must survive the roll
    with its offset intact, not be recomputed to some default."""
    pe, due = next_occurrence("monthly", date(2026, 9, 30), date(2026, 10, 10))
    assert (pe, due) == (date(2026, 10, 31), date(2026, 11, 10))


# ── next_occurrence: the due-date anchor ────────────────────────────────────

def test_no_period_falls_back_to_the_due_date():
    assert next_occurrence("monthly", None, date(2026, 5, 20)) == (None, date(2026, 6, 20))


def test_no_anchor_at_all_yields_nothing():
    assert next_occurrence("monthly", None, None) is None


# ── next_occurrence: non-recurring ──────────────────────────────────────────

@pytest.mark.parametrize("recurrence", [None, "", "weekly", "daily", "MONTHLY"])
def test_unrecognised_or_absent_recurrence_never_advances(recurrence):
    """An unknown value must be inert, not guessed at. A task that silently
    repeats on a cadence nobody chose is worse than one that doesn't repeat."""
    assert next_occurrence(recurrence, date(2026, 9, 30), date(2026, 10, 10)) is None
    assert months_for(recurrence) is None


def test_valid_recurrence_set_is_exactly_what_months_for_knows():
    assert {r for r in VALID_RECURRENCE if months_for(r) is not None} == VALID_RECURRENCE


# ── anchor_error ────────────────────────────────────────────────────────────

def test_one_time_task_needs_no_anchor():
    assert anchor_error(None, None, None) is None


def test_recurring_task_without_an_anchor_is_rejected():
    err = anchor_error("monthly", None, None)
    assert err and "period or a due date" in err


@pytest.mark.parametrize("pe,due", [
    (date(2026, 9, 30), None),
    (None, date(2026, 10, 10)),
    (date(2026, 9, 30), date(2026, 10, 10)),
])
def test_recurring_task_with_either_anchor_is_accepted(pe, due):
    assert anchor_error("monthly", pe, due) is None


def test_unknown_interval_is_rejected_rather_than_stored():
    err = anchor_error("fortnightly", date(2026, 9, 30), None)
    assert err and "monthly" in err
