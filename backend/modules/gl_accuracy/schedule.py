"""When a workspace is due for its continuous-close check.

The cron ticks hourly and every enabled workspace fires in its own window, so
"check at 9am" means 9am where the books are rather than 9am in Virginia.

Pure on purpose. Scheduling bugs are the kind you discover in production three
weeks later — a workspace that never fires, or one that fires twenty-four times
a day — and neither is visible from reading the code. They are visible from a
test that runs a whole day, or a DST weekend, an hour at a time.
"""
from __future__ import annotations

from datetime import UTC, date, datetime
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


def is_due(
    *,
    timezone: str | None,
    check_hour: int,
    last_ok_scan_at: datetime | None,
    now_utc: datetime,
) -> bool:
    """Should this workspace be checked on this hourly tick?

    Two conditions, both required:

      * it is the workspace's chosen hour, on its own clock;
      * it has not already been checked successfully today, on that same clock.

    The second is what makes the sweep idempotent. The cron fires every hour and
    may be retried; without a once-a-day guard a workspace would be scanned
    repeatedly through its check hour, burning QuickBooks calls and re-notifying
    on findings it already reported.

    Comparing LOCAL dates rather than a 24-hour elapsed window matters on the
    days a clock changes: in a spring-forward the chosen hour may not exist at
    all, and in an autumn fall-back it happens twice. A local-date guard fires
    at most once either way, which is the behaviour a user expects from
    "check my books each morning".
    """
    if check_hour is None or not (0 <= int(check_hour) <= 23):
        return False
    here = local_now(now_utc, timezone)
    if here.hour != int(check_hour):
        return False
    return local_date_of(last_ok_scan_at, timezone) != here.date()
