"""Which year a period belongs to, when the year doesn't start in January.

The close app assumed a calendar year everywhere. Year-to-date figures were
pulled from 1 January, "the first month of the year" meant January, and a
window spanning 31 December was refused as crossing a year boundary. For a
client on a June year end every one of those is wrong — not an error, a
plausible figure computed on a basis nobody chose. The same defect this
codebase keeps producing, at the widest scale it has.

Nordavix Allocate already carries a client's `fiscal_year_end` and reasons
about it correctly (modules/cost_allocation/engine.fiscal_year_bounds). This is
the same convention — "MM-DD", calendar year when absent — expressed for the
question the close app asks, which is the other way round: given a period, when
did its year begin?

Pure. Every caller is a date derivation whose failure mode is a wrong number
rather than an exception, so this is the module to argue with rather than test
through five others.
"""
from __future__ import annotations

import calendar
from datetime import date

# What a workspace with nothing set uses, and what every existing workspace is
# already on. A December year end makes this module a no-op, which is exactly
# what a calendar-year client should get.
DEFAULT_FYE = "12-31"


def parse_fye(fiscal_year_end: str | None) -> tuple[int, int]:
    """"MM-DD" → (month, day), falling back to 31 December.

    Falls back rather than raising: a malformed value in one workspace's
    settings must not break the close for everyone, and a calendar year is the
    right guess when the real answer is unreadable. The cost of the fallback is
    visible — figures come out on a calendar basis — where an exception would
    take the page down.
    """
    month, day = 12, 31
    if fiscal_year_end:
        try:
            m_str, d_str = str(fiscal_year_end).strip().split("-")
            m, d = int(m_str), int(d_str)
            # Validated against a leap year so 02-29 is accepted as a year end.
            if 1 <= m <= 12 and 1 <= d <= calendar.monthrange(2024, m)[1]:
                month, day = m, d
        except (ValueError, TypeError, AttributeError):
            pass
    return month, day


def fiscal_year_start(period_end: date, fiscal_year_end: str | None) -> date:
    """The first day of the fiscal year `period_end` falls in.

    A June year end means the year running 2025-07-01 → 2026-06-30 contains May
    2026, so May's year-to-date starts in JULY OF THE PRIOR CALENDAR YEAR.
    Getting that backwards doesn't fail — it silently reports eleven months of
    the wrong year as this year's performance.

    With the default December year end this returns 1 January of the period's
    own year, which is what every calendar-year workspace already gets.
    """
    m, _d = parse_fye(fiscal_year_end)
    # The fiscal year opens the day after it closes; a year end is a month end,
    # so that is the 1st of the following month.
    start_month = m % 12 + 1
    opened_this_year = (period_end.month, period_end.day) >= (start_month, 1)
    start_year = period_end.year if opened_this_year else period_end.year - 1
    return date(start_year, start_month, 1)


def same_fiscal_year(a: date, b: date, fiscal_year_end: str | None) -> bool:
    """Do these two dates sit in the same fiscal year?

    The question behind every year-to-date subtraction. YTD resets when the
    fiscal year turns, so differencing two YTD figures is only meaningful
    inside one year — and "inside one year" is not "inside one calendar year"
    for anyone on a June or September or April year end.
    """
    return fiscal_year_start(a, fiscal_year_end) == fiscal_year_start(b, fiscal_year_end)


def is_first_month_of_fiscal_year(period_end: date, fiscal_year_end: str | None) -> bool:
    """Is this the opening month of its fiscal year?

    That month needs no prior period to difference against: its year-to-date IS
    its month. Hardcoded as "January" in several places, which quietly made
    every non-calendar client's opening month fall back to a comparison against
    a month in the previous year.
    """
    start = fiscal_year_start(period_end, fiscal_year_end)
    return (period_end.year, period_end.month) == (start.year, start.month)


def fiscal_year_label(period_end: date, fiscal_year_end: str | None) -> str:
    """How to name the year a period belongs to, for a human.

    A calendar year is just "2026". A June year end spans two calendar years
    and has to say so, because "FY2026" alone means different things to
    different firms.
    """
    start = fiscal_year_start(period_end, fiscal_year_end)
    if start.month == 1:
        return str(start.year)
    return f"{start.year}–{start.year + 1}"
