"""When a workspace is due for its continuous-close check.

The cron ticks hourly and every enabled workspace fires in its own window, so
"check at 9am" means 9am where the books are rather than 9am in Virginia.

Pure on purpose. Scheduling bugs are the kind you discover in production three
weeks later — a workspace that never fires, or one that fires twenty-four times
a day — and neither is visible from reading the code. They are visible from a
test that runs a whole day, or a DST weekend, an hour at a time.
"""
from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# What a workspace with no timezone set runs on. Every existing workspace is
# effectively here already, since the cron has always fired at a fixed UTC hour.
DEFAULT_TZ = "UTC"


def resolve_zone(timezone: str | None) -> ZoneInfo:
    """The workspace's zone, falling back to UTC.

    An unknown or malformed name falls back rather than raising: a typo in one
    workspace's settings must not take down the sweep for everyone else. The
    workspace still gets checked, just on UTC's clock.
    """
    try:
        return ZoneInfo((timezone or DEFAULT_TZ).strip() or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo(DEFAULT_TZ)


def local_now(now_utc: datetime, timezone: str | None) -> datetime:
    """`now_utc` as the workspace sees it."""
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=UTC)
    return now_utc.astimezone(resolve_zone(timezone))


def local_date_of(moment: datetime | None, timezone: str | None) -> date | None:
    """The workspace-local calendar date of a UTC instant."""
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(resolve_zone(timezone)).date()


def month_end_of(d: date) -> date:
    """Last day of the month `d` falls in."""
    from calendar import monthrange
    return date(d.year, d.month, monthrange(d.year, d.month)[1])


def watch_periods(
    *,
    books_start: date | None,
    closed: set[date],
    today: date,
) -> list[date]:
    """The month continuous close tracks: today's CALENDAR month. Only.

    Calendar month, not "the month in progress" — that phrase reads as "the
    month whose close is in progress", which is the other feature entirely.
    These two watch different months on purpose, and the close month and the
    calendar month are routinely different: on 20 August you are closing July.

      * CONTINUOUS CLOSE tracks AUGUST — the month transactions are being
        entered into right now. Its question is "has anything odd been entered
        today". It runs on a schedule, unattended.
      * RISK RADAR checks JULY — whichever period the user selected. Its
        question is "is this month clean enough to sign off", and the user
        drives it.

    Scanning the closing month here too would double the QuickBooks pulls to
    re-derive findings Risk Radar already shows on the period the user is
    looking at, and would make the rail's numbers ambiguous about which month
    they describe.

    Empty when the books haven't started, when the current month predates them,
    or when it has somehow been closed already.
    """
    if books_start is None:
        return []
    current = month_end_of(today)
    if current < month_end_of(books_start) or current in closed:
        return []
    return [current]


# How long after the chosen hour a missed tick may still be caught up, in
# whole hours. GitHub's scheduled workflows are best-effort: they run late under
# load and are sometimes dropped outright, and against a single-hour window a
# dropped tick means no check that day, silently, for a feature whose entire
# claim is that it checks every day. Bounded rather than open-ended so a
# workspace whose scans keep failing retries a few times, not fifteen.
CATCH_UP_HOURS = 3


# The minute past each hour the sweep's cron fires, from
# .github/workflows/continuous-close.yml ("10 * * * *"). Duplicated here on
# purpose: the schedule the user is shown has to be the schedule that actually
# runs, and the alternative is a rail that quotes a time nothing acts on.
SWEEP_MINUTE = 10


def next_tick_at(after: datetime) -> datetime:
    """The next hourly cron tick at or after `after`."""
    t = after.replace(minute=SWEEP_MINUTE, second=0, microsecond=0)
    return t if t >= after else t + timedelta(hours=1)


def effective_last_scan(
    last_ok_scan_at: datetime | None,
    schedule_changed_at: datetime | None,
) -> datetime | None:
    """The last scheduled check that counts against the CURRENT schedule.

    A check that ran before the schedule was changed does not satisfy the new
    one. Move the daily check from 10:00 to 14:00 at lunchtime and the 10:00 run
    has already happened — the once-a-day guard would then read "checked today"
    and skip 14:00 entirely, so a setting the user just chose does nothing until
    tomorrow. Nothing on screen would explain the delay, because from the
    outside it looks exactly like the feature not working.

    Changing when you want to be checked is a request to be checked then. So
    scans older than the change are discarded for this purpose only — they stay
    in the run history, they simply stop answering a question about a schedule
    that did not exist when they ran.
    """
    if last_ok_scan_at is None or schedule_changed_at is None:
        return last_ok_scan_at
    if last_ok_scan_at.tzinfo is None:
        last_ok_scan_at = last_ok_scan_at.replace(tzinfo=UTC)
    if schedule_changed_at.tzinfo is None:
        schedule_changed_at = schedule_changed_at.replace(tzinfo=UTC)
    return None if last_ok_scan_at < schedule_changed_at else last_ok_scan_at


def next_due_at(
    *,
    timezone: str | None,
    check_hour: int,
    last_ok_scan_at: datetime | None,
    now_utc: datetime,
    schedule_changed_at: datetime | None = None,
) -> datetime | None:
    """When this workspace will next actually be CHECKED, as a UTC instant.

    Exists because "continuous close · on" was the only thing the rail could
    say, and it kept saying it while the sweep skipped the workspace for any of
    five reasons nobody could see. A time you can hold a clock up to is the
    difference between a claim and a fact.

    Returns when the check will RUN, not when it becomes eligible, and those are
    different by up to an hour. The sweep is driven by an hourly cron; a
    workspace whose chosen hour has just arrived waits for the next tick. The
    first version returned the eligible moment, so the rail said "due now" at
    11:00 for a check that would run at 11:40 — technically true, and read by
    everyone as "this second", which makes a working feature look broken.

    None when the hour is out of range.
    """
    if check_hour is None or not (0 <= int(check_hour) <= 23):
        return None
    last_ok_scan_at = effective_last_scan(last_ok_scan_at, schedule_changed_at)
    if is_due(timezone=timezone, check_hour=check_hour,
              last_ok_scan_at=last_ok_scan_at, now_utc=now_utc):
        return next_tick_at(now_utc)

    zone = resolve_zone(timezone)
    here = local_now(now_utc, timezone)
    hour = int(check_hour)
    ran_today = local_date_of(last_ok_scan_at, timezone) == here.date()

    # Today still, if the hour hasn't come round and nothing has run yet.
    if not ran_today and here.hour < hour:
        target_day = here.date()
    else:
        target_day = here.date() + timedelta(days=1)
    local_target = datetime(
        target_day.year, target_day.month, target_day.day, hour, tzinfo=zone
    )
    return next_tick_at(local_target.astimezone(UTC))


def is_due(
    *,
    timezone: str | None,
    check_hour: int,
    last_ok_scan_at: datetime | None,
    now_utc: datetime,
    schedule_changed_at: datetime | None = None,
) -> bool:
    """Should this workspace be checked on this hourly tick?

    Two conditions, both required:

      * the local clock has reached the chosen hour and is still within the
        catch-up window;
      * the SCHEDULE has not already completed a check today, on that clock —
        counting only checks that ran under the CURRENT schedule, so changing
        the time takes effect the same day rather than tomorrow.

    The second is what makes the sweep idempotent, and it must be fed only by
    scheduled runs — see `_last_ok_scan_at`. Fed by any successful scan, a
    single Check now press suppressed the whole day.

    The window is what makes it reliable. Firing only in the exact hour assumes
    the cron ticks in that hour, and GitHub's does not guarantee that; a late or
    dropped tick simply lost the day. Within the window the once-a-day guard
    still allows exactly one check, so a caught-up run is late, never extra.

    Comparing LOCAL dates rather than a 24-hour elapsed window matters on the
    days a clock changes: in a spring-forward the chosen hour may not exist at
    all, and in an autumn fall-back it happens twice. A local-date guard fires
    at most once either way, which is the behaviour a user expects from
    "check my books each morning".
    """
    if check_hour is None or not (0 <= int(check_hour) <= 23):
        return False
    # A check from before the schedule changed doesn't satisfy the new one.
    last_ok_scan_at = effective_last_scan(last_ok_scan_at, schedule_changed_at)
    start = int(check_hour)
    # The window cannot wrap past midnight, and deliberately doesn't: the lower
    # bound alone rules out every hour before the chosen one, so a 23:00 check
    # only ever matches hour 23. That matters — spilling into 00:00 would land
    # on a date the once-a-day guard reads as tomorrow, and the same night's
    # check would fire twice.
    here = local_now(now_utc, timezone)
    if not (start <= here.hour <= start + CATCH_UP_HOURS):
        return False
    return local_date_of(last_ok_scan_at, timezone) != here.date()
