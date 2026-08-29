"""When a workspace fires its daily check.

Scheduling bugs are the kind you find in production three weeks later — a
workspace that never fires, or one that fires twenty-four times a day — and
neither is visible from reading the code. These run a whole day an hour at a
time, and both clock-change weekends, which is where "check every morning"
quietly becomes "check twice" or "skip a day".
"""
from datetime import UTC, datetime, timedelta

import pytest

from modules.gl_accuracy.schedule import is_due, local_now, resolve_zone

NY = "America/New_York"
KOL = "Asia/Kolkata"


def utc(y, m, d, h, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


def run_a_day(tz, check_hour, start_utc, hours=24, last_ok=None):
    """Tick hourly for `hours` and return the UTC hours that fired, applying the
    once-a-day guard exactly as the sweep does."""
    fired, seen = [], last_ok
    for i in range(hours):
        now = start_utc + timedelta(hours=i)
        if is_due(timezone=tz, check_hour=check_hour, last_ok_scan_at=seen, now_utc=now):
            fired.append(now)
            seen = now
    return fired


# ── The basic contract ─────────────────────────────────────────────────────

def test_a_workspace_fires_exactly_once_in_a_day():
    fired = run_a_day(NY, 9, utc(2026, 3, 3, 0))
    assert len(fired) == 1, f"fired {len(fired)} times"


def test_it_fires_at_the_chosen_local_hour_not_a_utc_one():
    """9am in New York is 14:00 UTC in March (EDT)."""
    fired = run_a_day(NY, 9, utc(2026, 3, 20, 0))
    assert fired[0].hour == 13 or fired[0].hour == 14
    assert local_now(fired[0], NY).hour == 9


def test_two_workspaces_in_different_zones_fire_at_different_utc_hours():
    ny = run_a_day(NY, 9, utc(2026, 6, 10, 0))[0]
    kol = run_a_day(KOL, 9, utc(2026, 6, 10, 0))[0]
    assert ny.hour != kol.hour
    assert local_now(ny, NY).hour == 9
    assert local_now(kol, KOL).hour == 9


def test_a_workspace_already_checked_today_does_not_fire_again():
    """The idempotency guard. The cron fires hourly and can be retried; without
    this a workspace would be re-scanned through its whole check hour."""
    today_9am = utc(2026, 6, 10, 13)
    assert is_due(timezone=NY, check_hour=9,
                  last_ok_scan_at=today_9am, now_utc=today_9am) is False


def test_a_check_from_yesterday_does_not_block_today():
    yesterday = utc(2026, 6, 9, 13)
    fired = run_a_day(NY, 9, utc(2026, 6, 10, 0), last_ok=yesterday)
    assert len(fired) == 1


def test_it_never_fires_outside_the_chosen_hour():
    for h in range(24):
        due = is_due(timezone=NY, check_hour=9, last_ok_scan_at=None,
                     now_utc=utc(2026, 6, 10, h))
        assert due == (local_now(utc(2026, 6, 10, h), NY).hour == 9)


# ── Clock changes ──────────────────────────────────────────────────────────

def test_spring_forward_still_fires_once():
    """2026-03-08: US clocks jump 02:00 → 03:00. A 9am check is unaffected, but
    the day is 23 hours long and a naive 24-hour-elapsed guard drifts."""
    fired = run_a_day(NY, 9, utc(2026, 3, 8, 0), hours=48)
    assert len(fired) == 2, "one per day across the short day"


def test_autumn_fall_back_does_not_fire_twice():
    """2026-11-01: 01:00 happens twice. A 1am check is the dangerous case —
    the local hour matches on two different UTC ticks, and only a local-DATE
    guard stops it double-firing."""
    fired = run_a_day(NY, 1, utc(2026, 11, 1, 0), hours=30)
    assert len(fired) == 1, f"fired {len(fired)} times across the repeated hour"


def test_an_hour_that_does_not_exist_simply_skips_that_day():
    """2026-03-08 02:00 America/New_York never happens. A workspace that chose
    2am gets no check that day — and, critically, is not stuck forever: it
    fires again the next day."""
    fired = run_a_day(NY, 2, utc(2026, 3, 8, 0), hours=48)
    assert len(fired) == 1, "skipped the lost hour, resumed the next day"


# ── Degenerate input must not take down the sweep ──────────────────────────

@pytest.mark.parametrize("tz", [None, "", "   ", "Not/AZone", "EST5EDT-nonsense"])
def test_a_missing_or_bogus_timezone_falls_back_to_utc(tz):
    """A typo in one workspace's settings must not raise and stop the sweep for
    every other workspace."""
    assert str(resolve_zone(tz)) == "UTC"
    fired = run_a_day(tz, 9, utc(2026, 6, 10, 0))
    assert len(fired) == 1
    assert fired[0].hour == 9


@pytest.mark.parametrize("hour", [-1, 24, 99, None])
def test_an_out_of_range_hour_never_fires(hour):
    """Better to not run than to run at an hour nobody chose."""
    assert run_a_day(NY, hour, utc(2026, 6, 10, 0)) == []


@pytest.mark.parametrize("hour", [0, 23])
def test_the_edges_of_the_day_are_valid(hour):
    """Midnight and 11pm are ordinary choices. Asserted as once per LOCAL day
    rather than once per window — a 30-hour window legitimately spans two."""
    fired = run_a_day(NY, hour, utc(2026, 6, 10, 0), hours=30)
    assert fired, "an edge hour never fired"
    days = [local_now(f, NY).date() for f in fired]
    assert len(days) == len(set(days)), "fired twice on one local day"
    assert all(local_now(f, NY).hour == hour for f in fired)


def test_a_naive_timestamp_is_treated_as_utc_rather_than_crashing():
    """last_ok_scan_at comes from the database and can arrive naive."""
    naive = datetime(2026, 6, 10, 13)
    assert is_due(timezone=NY, check_hour=9, last_ok_scan_at=naive,
                  now_utc=utc(2026, 6, 10, 13)) is False


# ── Which month gets watched ───────────────────────────────────────────────
# Continuous close and Risk Radar deliberately watch DIFFERENT months:
#
#   * continuous close tracks the month happening NOW — "has anything odd been
#     entered today", answered on a schedule, unattended;
#   * Risk Radar checks the month being CLOSED — "is this clean enough to sign
#     off", answered on whichever period the user selected.
#
# It first borrowed Autopilot's focus_period_for (oldest non-closed FULLY
# ELAPSED month), so an entry made today was never looked at. Then it watched
# both, which doubled the QuickBooks pulls and made the rail's numbers ambiguous
# about which month they described. It watches the current month. Only.

from datetime import date  # noqa: E402

from modules.gl_accuracy.schedule import month_end_of, watch_periods  # noqa: E402

BOOKS = date(2025, 1, 1)


def watch(today, closed=frozenset(), books=BOOKS):
    return watch_periods(books_start=books, closed=set(closed), today=today)


def test_the_current_in_progress_month_is_watched():
    """THE BUG THIS EXISTS FOR. Mid-August, August is the month being tracked."""
    assert watch(date(2026, 8, 20)) == [date(2026, 8, 31)]


def test_the_month_being_closed_is_not_watched_here():
    """July is unclosed and mid-close, and it is still not this feature's job —
    Risk Radar covers it on the period the user has selected. Scanning it here
    would re-derive findings the page already shows, on QuickBooks' dime."""
    assert date(2026, 7, 31) not in watch(date(2026, 8, 20))


def test_exactly_one_month_is_ever_returned():
    assert len(watch(date(2026, 8, 20))) == 1


def test_a_closed_current_month_is_skipped():
    """Nothing continuous to track in a month already signed off."""
    assert watch(date(2026, 8, 20), closed={date(2026, 8, 31)}) == []


def test_nothing_before_the_books_start():
    assert watch(date(2026, 8, 20), books=date(2027, 1, 1)) == []


def test_no_books_start_watches_nothing():
    assert watch(date(2026, 8, 20), books=None) == []


def test_the_first_day_of_a_month_watches_that_month():
    """On the 1st there is almost no activity yet, but the month is live — the
    watch must not have a blind day every month."""
    assert watch(date(2026, 9, 1)) == [date(2026, 9, 30)]


def test_the_last_day_of_a_month_still_watches_that_month():
    assert watch(date(2026, 9, 30)) == [date(2026, 9, 30)]


def test_the_books_start_month_itself_is_watched():
    """A workspace onboarded this month has exactly one month to track."""
    assert watch(date(2026, 8, 20), books=date(2026, 8, 1)) == [date(2026, 8, 31)]


@pytest.mark.parametrize("d,expected", [
    (date(2026, 2, 10), date(2026, 2, 28)),
    (date(2028, 2, 10), date(2028, 2, 29)),
    (date(2026, 12, 1), date(2026, 12, 31)),
])
def test_month_end_of(d, expected):
    assert month_end_of(d) == expected
