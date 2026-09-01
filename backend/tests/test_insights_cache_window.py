"""Why Insights stopped using its cache, and the rule that gives it back.

Two correct changes collided. `live_sourced` was set from
`period_start is not None` as a stand-in for "the user picked a custom range",
and later the page began sending period_start on EVERY view — deliberately, so
a month's P&L comes from a real ranged QuickBooks call instead of differencing
snapshots that might be missing.

From that moment the flag meant nothing. Every ordinary month view looked like
a custom range, expired after fifteen minutes, and recomputed itself live —
five sequential QuickBooks reports at a thirty-second timeout each — on
essentially every visit. Nobody changed the cache; the cache simply stopped
applying to anything.

`window_is_perishable` asks the question the flag was pretending to ask. These
tests pin it, because the failure it replaces was invisible: the module still
returned correct figures, just slowly enough that a page looked broken.
"""
from datetime import UTC, date, datetime

import pytest

from modules.insights.service import (
    INSIGHTS_PAYLOAD_VERSION,
    LIVE_CACHE_TTL_SECONDS,
    cache_is_fresh,
    window_is_perishable,
)

TODAY = date(2026, 9, 1)


def w(start, end, today=TODAY):
    return window_is_perishable(start, end, today)


# ── A finished calendar month is not a custom range ────────────────────────

def test_a_completed_month_is_not_perishable():
    """THE REGRESSION. This is the ordinary view — the one a user opens all day
    — and it was being treated as a live custom window."""
    assert w(date(2026, 6, 1), date(2026, 6, 30)) is False


@pytest.mark.parametrize(("y", "m", "last"), [
    (2026, 1, 31), (2026, 2, 28), (2024, 2, 29), (2026, 4, 30), (2026, 12, 31),
])
def test_month_ends_are_recognised_including_february(y, m, last):
    """The whole-month test compares against the real last day, so a 28th, a
    29th, a 30th and a 31st all count as complete months. Hardcoding 30 or 31
    would silently make every February or every short month perishable."""
    assert window_is_perishable(date(y, m, 1), date(y, m, last), date(2027, 1, 1)) is False


def test_a_month_view_with_no_start_is_not_perishable():
    """The pre-change shape, still served to any caller that omits it."""
    assert w(None, date(2026, 6, 30)) is False


# ── What genuinely keeps moving ───────────────────────────────────────────

def test_the_current_month_is_perishable():
    """It changes daily, so a figure computed this morning is not the same one
    this afternoon. This is what the short TTL exists for."""
    assert w(date(2026, 9, 1), date(2026, 9, 30)) is True


def test_a_window_ending_today_is_perishable():
    """Today isn't over. Anything can still post to it."""
    assert w(date(2026, 8, 1), TODAY) is True


def test_a_partial_month_is_perishable():
    assert w(date(2026, 6, 1), date(2026, 6, 10)) is True


def test_a_window_starting_mid_month_is_perishable():
    assert w(date(2026, 6, 15), date(2026, 6, 30)) is True


def test_a_cross_month_range_is_perishable():
    """Thirty days, but not a month — and the sync stamp describes neither of
    the months it straddles."""
    assert w(date(2026, 5, 15), date(2026, 6, 14)) is True


def test_a_multi_month_range_is_perishable():
    """A quarter is not a calendar month, however tidy its edges."""
    assert w(date(2026, 4, 1), date(2026, 6, 30)) is True


def test_perishability_is_about_the_window_not_the_presence_of_a_start():
    """THE BUG IN ONE ASSERTION. Both of these send a period_start; only one of
    them is a custom range. The old flag could not tell them apart."""
    assert w(date(2026, 6, 1), date(2026, 6, 30)) is False
    assert w(date(2026, 6, 1), date(2026, 6, 10)) is True


# ── And the cache actually honours it ─────────────────────────────────────

FRESH = {"payload_version": INSIGHTS_PAYLOAD_VERSION, "source_synced_at": "2026-07-01T00:00:00+00:00"}
NOW = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)
OLD = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)      # a month before NOW


def test_a_settled_month_survives_the_ttl():
    """The point of the fix: an hours-old payload for a closed month is still
    good, because only a re-sync can change what it describes."""
    assert cache_is_fresh(
        FRESH, "2026-07-01T00:00:00+00:00",
        live_sourced=False, computed_at=OLD, now=NOW,
    ) is True


def test_a_perishable_window_still_ages_out():
    """The guard is narrowed, not removed. A custom range computed a month ago
    is not served."""
    assert cache_is_fresh(
        FRESH, "2026-07-01T00:00:00+00:00",
        live_sourced=True, computed_at=OLD, now=NOW,
    ) is False


def test_a_perishable_window_inside_the_ttl_is_still_fresh():
    recent = datetime(2026, 9, 1, 11, 55, tzinfo=UTC)   # 5 minutes old
    assert cache_is_fresh(
        FRESH, "2026-07-01T00:00:00+00:00",
        live_sourced=True, computed_at=recent, now=NOW,
    ) is True


def test_a_resync_still_invalidates_a_settled_month():
    """Narrowing the TTL must not make anything permanent. The sync stamp is
    what catches posted entries, and it still does."""
    assert cache_is_fresh(
        FRESH, "2026-08-15T00:00:00+00:00",     # period re-synced since
        live_sourced=False, computed_at=OLD, now=NOW,
    ) is False


def test_a_payload_version_bump_still_invalidates_a_settled_month():
    """The other half of freshness — a deploy that changes what goes IN the
    payload — is untouched by this."""
    assert cache_is_fresh(
        {**FRESH, "payload_version": INSIGHTS_PAYLOAD_VERSION - 1},
        "2026-07-01T00:00:00+00:00",
        live_sourced=False, computed_at=OLD, now=NOW,
    ) is False


def test_the_ttl_is_still_short_enough_to_mean_something():
    assert 60 <= LIVE_CACHE_TTL_SECONDS <= 3600
