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


def test_it_never_fires_before_the_chosen_hour():
    for h in range(24):
        local_hour = local_now(utc(2026, 6, 10, h), NY).hour
        due = is_due(timezone=NY, check_hour=9, last_ok_scan_at=None,
                     now_utc=utc(2026, 6, 10, h))
        if local_hour < 9:
            assert not due, f"fired at {local_hour}:00, before the chosen hour"


# ── The catch-up window ────────────────────────────────────────────────────
#
# GitHub's scheduled workflows are best-effort: they run late under load and are
# sometimes dropped outright. Against a single-hour window a dropped tick meant
# no check that day, silently — for a feature whose entire claim is that it
# checks every day. The window lets a late tick still land, and the once-a-day
# guard keeps it to one check.

def test_a_tick_missed_at_the_chosen_hour_is_caught_up_later():
    """THE FAILURE THIS EXISTS FOR. The 9am tick never arrived; 11am's does."""
    assert is_due(timezone=NY, check_hour=9, last_ok_scan_at=None,
                  now_utc=utc(2026, 6, 10, 15)) is True   # 11:00 EDT


def test_a_caught_up_check_is_late_never_extra():
    """Every hour in the window ticks, and exactly one check comes out of it."""
    fired = run_a_day(NY, 9, utc(2026, 6, 10, 0))
    assert len(fired) == 1, f"the window fired {len(fired)} times"


def test_the_window_closes_and_does_not_run_all_day():
    """An unbounded window would retry a persistently failing workspace fifteen
    times a day on QuickBooks' dime."""
    assert is_due(timezone=NY, check_hour=9, last_ok_scan_at=None,
                  now_utc=utc(2026, 6, 10, 21)) is False  # 17:00 EDT, long past


def test_a_late_evening_check_hour_never_spills_into_tomorrow():
    """23:00 + a 3-hour window would reach 02:00, which the guard reads as a new
    local date — so it would fire again as 'today's' check a few hours later."""
    fired = run_a_day(NY, 23, utc(2026, 6, 10, 0), hours=30)
    days = [local_now(f, NY).date() for f in fired]
    assert len(days) == len(set(days)), "fired twice on one local day"
    assert all(local_now(f, NY).hour == 23 for f in fired), \
        "a 23:00 check ran after midnight"


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


def test_an_hour_that_does_not_exist_is_caught_up_not_lost():
    """2026-03-08 02:00 America/New_York never happens — the clock jumps 01:59
    to 03:00. A 2am workspace used to lose that day entirely; the catch-up
    window lands it at 03:00 instead, and the next day resumes at 2am.

    Once per local day either way — being late is fine, being extra is not."""
    fired = run_a_day(NY, 2, utc(2026, 3, 8, 0), hours=48)
    local = [local_now(f, NY) for f in fired]
    days = [d.date() for d in local]
    assert len(days) == len(set(days)), f"fired twice on one local day: {local}"
    assert len(fired) == 2, "the lost hour cost a whole day's check"
    assert local[0].hour == 3, "did not catch up on the spring-forward day"
    assert local[1].hour == 2


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


# ── When the next check is due ─────────────────────────────────────────────
#
# The rail could only ever say "continuous close · on", while the sweep skipped
# a workspace for five invisible reasons. "On" is a claim; a time you can hold
# a clock up to is a fact, and it is the only way to tell a watch that is
# working from one that has been inert for a week.

from modules.gl_accuracy.schedule import next_due_at  # noqa: E402

IST = "Asia/Kolkata"


def test_before_the_hour_the_check_is_due_today():
    """07:30 IST, checking at 10:00 IST. The answer is when it will RUN — the
    first cron tick at or after 10:00 IST, which is 10:40."""
    due = next_due_at(timezone=IST, check_hour=10, last_ok_scan_at=None,
                      now_utc=utc(2026, 8, 30, 2))          # 07:30 IST
    assert due == utc(2026, 8, 30, 5, 10)                    # 10:40 IST


def test_inside_the_window_the_answer_is_the_next_tick_not_now():
    """THE BUG THIS FIXES. The window is open, so the check is eligible — but
    the sweep is driven by an hourly cron and will not run until the next tick.
    Returning `now` made the rail say "due now" for a check forty minutes away,
    which reads as "this second" and makes a working feature look broken."""
    now = utc(2026, 8, 30, 6)                                # 11:30 IST
    assert next_due_at(timezone=IST, check_hour=10,
                       last_ok_scan_at=None, now_utc=now) == utc(2026, 8, 30, 6, 10)


def test_after_the_window_it_rolls_to_tomorrow():
    due = next_due_at(timezone=IST, check_hour=10, last_ok_scan_at=None,
                      now_utc=utc(2026, 8, 30, 12))          # 17:30 IST
    assert due == utc(2026, 8, 31, 5, 10)                    # 10:40 IST tomorrow


def test_having_run_today_pushes_it_to_tomorrow():
    ran = utc(2026, 8, 30, 4, 30)
    due = next_due_at(timezone=IST, check_hour=10, last_ok_scan_at=ran,
                      now_utc=utc(2026, 8, 30, 5))
    assert due == utc(2026, 8, 31, 5, 10)


def test_an_unset_timezone_reads_the_hour_as_utc():
    """THE BUG THIS EXISTS TO MAKE VISIBLE. A workspace in India sets 10:00,
    never sets a zone, and the check fires at 10:00 UTC — half past three in
    the afternoon. It runs; just not when anyone expected, which is
    indistinguishable from broken and much harder to diagnose."""
    due = next_due_at(timezone=None, check_hour=10, last_ok_scan_at=None,
                      now_utc=utc(2026, 8, 30, 2))
    assert due == utc(2026, 8, 30, 10, 10)                   # 15:40 IST
    # …and with the zone set, the same settings fire five and a half hours earlier.
    assert next_due_at(timezone=IST, check_hour=10, last_ok_scan_at=None,
                       now_utc=utc(2026, 8, 30, 2)) < due


def test_an_out_of_range_hour_has_no_next_time():
    assert next_due_at(timezone=IST, check_hour=99,
                       last_ok_scan_at=None, now_utc=utc(2026, 8, 30, 2)) is None


def test_the_next_time_is_always_in_the_future_or_now():
    """Across a whole day, the answer is never in the past — a rail saying
    'next check in -3 hours' is worse than saying nothing."""
    for h in range(24):
        now = utc(2026, 8, 30, h)
        due = next_due_at(timezone=IST, check_hour=10, last_ok_scan_at=None, now_utc=now)
        assert due is not None and due >= now, f"{h}:00Z -> {due}"


def test_the_answer_is_always_a_moment_the_cron_actually_ticks():
    """The rail quotes this time to the user. A time nothing acts on is worse
    than no time — it invites exactly the "it said 11:00 and nothing happened"
    that this whole line of work started from."""
    from modules.gl_accuracy.schedule import SWEEP_MINUTE
    for h in range(24):
        for tz in (IST, NY, None):
            due = next_due_at(timezone=tz, check_hour=11, last_ok_scan_at=None,
                              now_utc=utc(2026, 8, 30, h))
            assert due is not None and due.minute == SWEEP_MINUTE, f"{h}Z {tz} -> {due}"


def test_the_run_time_is_never_more_than_an_hour_after_the_chosen_hour():
    """Waiting for a tick is fine; waiting two is a schedule nobody chose."""
    for h in range(24):
        now = utc(2026, 8, 30, h)
        due = next_due_at(timezone=IST, check_hour=11, last_ok_scan_at=None, now_utc=now)
        local = local_now(due, IST)
        # Either the chosen hour, or the catch-up window it legitimately lands in.
        assert 11 <= local.hour <= 11 + 3, f"{h}Z -> {local}"


# ── Changing the time takes effect today, not tomorrow ────────────────────
#
# The once-a-day guard is what makes the hourly sweep idempotent, and it is
# right. But it had no idea when the SCHEDULE last changed, so moving the check
# from 10:00 to 14:00 at lunchtime did nothing until the next day: the 10:00 run
# had already happened, the guard read "checked today", and 14:00 was skipped.
# From the outside that is indistinguishable from the feature being broken.

from zoneinfo import ZoneInfo

from modules.gl_accuracy.schedule import effective_last_scan

NY = "America/New_York"


def _utc(y, m, d, h, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=UTC)


def test_a_scan_from_before_the_change_stops_counting():
    ran   = _utc(2026, 9, 1, 14, 0)     # 10:00 New York
    moved = _utc(2026, 9, 1, 16, 0)     # user edits the time at 12:00 NY
    assert effective_last_scan(ran, moved) is None


def test_a_scan_after_the_change_still_counts():
    moved = _utc(2026, 9, 1, 14, 0)
    ran   = _utc(2026, 9, 1, 18, 0)
    assert effective_last_scan(ran, moved) == ran


def test_a_scan_at_the_exact_moment_of_the_change_counts():
    """Only STRICTLY earlier runs are discarded — a tie is not evidence that
    the check predated the schedule."""
    t = _utc(2026, 9, 1, 14, 0)
    assert effective_last_scan(t, t) == t


def test_a_workspace_that_never_changed_its_schedule_is_unaffected():
    """NULL for every existing row, which must read as 'never changed' rather
    than 'changed at the beginning of time' — the latter would discard every
    scan ever and re-check every workspace on deploy."""
    ran = _utc(2026, 9, 1, 14, 0)
    assert effective_last_scan(ran, None) == ran


def test_no_scan_stays_no_scan():
    assert effective_last_scan(None, _utc(2026, 9, 1, 14, 0)) is None


def test_moving_the_hour_forward_makes_today_due_again():
    """THE WHOLE POINT. 10:00 already ran; the user moves the check to 14:00 at
    noon. At 14:00 the same day it must fire."""
    ran_at_ten = _utc(2026, 9, 1, 14, 0)          # 10:00 NY
    moved_at_noon = _utc(2026, 9, 1, 16, 0)       # 12:00 NY
    two_pm_ny = _utc(2026, 9, 1, 18, 5)           # 14:05 NY

    # Without the stamp, the day is already spent.
    assert is_due(timezone=NY, check_hour=14,
                  last_ok_scan_at=ran_at_ten, now_utc=two_pm_ny) is False
    # With it, the new time is honoured the same day.
    assert is_due(timezone=NY, check_hour=14, last_ok_scan_at=ran_at_ten,
                  now_utc=two_pm_ny, schedule_changed_at=moved_at_noon) is True


def test_it_still_only_fires_once_after_the_change():
    """Re-checking must not become re-checking repeatedly. Once a run happens
    under the new schedule, the guard closes again."""
    moved = _utc(2026, 9, 1, 16, 0)
    ran_under_new = _utc(2026, 9, 1, 18, 10)      # 14:10 NY
    later_same_day = _utc(2026, 9, 1, 19, 5)      # 15:05 NY, still in the window
    assert is_due(timezone=NY, check_hour=14, last_ok_scan_at=ran_under_new,
                  now_utc=later_same_day, schedule_changed_at=moved) is False


def test_the_next_due_time_reflects_the_change_too():
    """The rail must not promise tomorrow for a check that will run in ten
    minutes — the number on screen and the sweep's decision come from the same
    rule, so they cannot disagree."""
    ran_at_ten = _utc(2026, 9, 1, 14, 0)
    moved_at_noon = _utc(2026, 9, 1, 16, 0)
    just_before_two = _utc(2026, 9, 1, 17, 55)    # 13:55 NY

    nxt = next_due_at(timezone=NY, check_hour=14, last_ok_scan_at=ran_at_ten,
                      now_utc=just_before_two, schedule_changed_at=moved_at_noon)
    assert nxt is not None
    assert nxt.astimezone(ZoneInfo(NY)).date() == date(2026, 9, 1)
