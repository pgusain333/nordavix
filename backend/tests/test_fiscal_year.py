"""When the year doesn't start in January.

Every date derivation in the close app assumed a calendar year: year-to-date
pulled from 1 January, "the first month of the year" meant January, and a
window spanning 31 December was refused as crossing a year boundary. For a
client on a June year end all three are wrong — and wrong in the direction that
produces a plausible figure rather than an error, which is why nobody would
find it by using the product.

Nordavix Allocate already reasons about fiscal_year_end correctly. These pin
the close app's version of the same convention.
"""
from datetime import date

import pytest

from core.fiscal import (
    DEFAULT_FYE,
    fiscal_year_label,
    fiscal_year_start,
    is_first_month_of_fiscal_year,
    parse_fye,
    same_fiscal_year,
)

CAL, JUNE, MARCH = "12-31", "06-30", "03-31"


# ── The default is exactly today's behaviour ──────────────────────────────

@pytest.mark.parametrize("fye", [None, "", DEFAULT_FYE, "  12-31  "])
def test_a_calendar_client_gets_january_as_before(fye):
    """NULL has to mean December, or deploying this would silently re-base every
    existing workspace's year-to-date."""
    assert fiscal_year_start(date(2026, 5, 31), fye) == date(2026, 1, 1)


def test_january_is_the_first_month_for_a_calendar_client():
    assert is_first_month_of_fiscal_year(date(2026, 1, 31), CAL) is True
    assert is_first_month_of_fiscal_year(date(2026, 2, 28), CAL) is False


def test_a_calendar_year_boundary_still_separates_years():
    assert same_fiscal_year(date(2025, 12, 31), date(2026, 1, 31), CAL) is False


# ── A June year end moves every one of those answers ──────────────────────

def test_a_june_year_end_starts_in_the_PRIOR_calendar_year():
    """THE ONE THAT WOULD BE SILENTLY WRONG. May 2026 belongs to the year that
    opened in July 2025, so its year-to-date runs from July — not from January,
    which would report eleven months of the wrong year as this year."""
    assert fiscal_year_start(date(2026, 5, 31), JUNE) == date(2025, 7, 1)


def test_after_the_year_end_it_rolls_forward():
    assert fiscal_year_start(date(2026, 8, 31), JUNE) == date(2026, 7, 1)


def test_the_year_end_month_itself_still_belongs_to_the_closing_year():
    """30 June is the LAST day of the year that opened the previous July, not
    the first of the next one. An off-by-one here shifts a whole month."""
    assert fiscal_year_start(date(2026, 6, 30), JUNE) == date(2025, 7, 1)


def test_the_day_after_opens_the_new_year():
    assert fiscal_year_start(date(2026, 7, 1), JUNE) == date(2026, 7, 1)


def test_july_is_the_first_month_of_a_june_year():
    assert is_first_month_of_fiscal_year(date(2025, 7, 31), JUNE) is True
    assert is_first_month_of_fiscal_year(date(2026, 1, 31), JUNE) is False


def test_the_calendar_new_year_is_NOT_a_fiscal_boundary_for_them():
    """December and January sit in the SAME June-year — so a range crossing 31
    December is perfectly derivable for this client and was being refused."""
    assert same_fiscal_year(date(2025, 12, 31), date(2026, 1, 31), JUNE) is True


def test_but_july_is():
    assert same_fiscal_year(date(2026, 6, 30), date(2026, 7, 31), JUNE) is False


@pytest.mark.parametrize(("fye", "month", "expected_start_month"), [
    ("01-31", 3, 2), ("03-31", 5, 4), ("06-30", 9, 7),
    ("09-30", 11, 10), ("12-31", 5, 1),
])
def test_the_year_opens_the_month_after_it_closes(fye, month, expected_start_month):
    assert fiscal_year_start(date(2026, month, 15), fye).month == expected_start_month


# ── Refusing to fail on bad input ─────────────────────────────────────────

@pytest.mark.parametrize("bad", ["nonsense", "13-01", "06-31", "6/30", "--", "06"])
def test_an_unreadable_year_end_falls_back_rather_than_raising(bad):
    """A malformed value in one workspace's settings must not take the close
    down for it. The fallback is visible — figures come out on a calendar basis
    — where an exception would be a blank page."""
    assert parse_fye(bad) == (12, 31)
    assert fiscal_year_start(date(2026, 5, 31), bad) == date(2026, 1, 1)


def test_a_february_year_end_is_accepted_including_the_29th():
    """Validated against a leap year, so 02-29 is a legal year end rather than
    silently falling back to December."""
    assert parse_fye("02-29") == (2, 29)
    assert parse_fye("02-28") == (2, 28)


# ── Naming it for a human ─────────────────────────────────────────────────

def test_a_calendar_year_is_named_by_its_year():
    assert fiscal_year_label(date(2026, 5, 31), CAL) == "2026"


def test_a_straddling_year_says_both():
    """"FY2026" means different things to different firms. A year that spans
    two calendar years has to name both of them."""
    assert fiscal_year_label(date(2026, 5, 31), JUNE) == "2025–2026"
    assert fiscal_year_label(date(2026, 8, 31), JUNE) == "2026–2027"


def test_march_year_end_works_too():
    assert fiscal_year_start(date(2026, 2, 28), MARCH) == date(2025, 4, 1)
    assert fiscal_year_start(date(2026, 4, 30), MARCH) == date(2026, 4, 1)
