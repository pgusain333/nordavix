"""When the daily watch is allowed to send email — and when it must not.

This is the only unattended thing in Nordavix that can reach outside the app, so
the gates matter more than the message. Three of them, all tested here:

  * something new was found (a daily "0 anomalies" is how a channel gets muted),
  * the WORKSPACE asked for email (off by default, or a deploy starts mailing
    every existing customer the next morning),
  * and — enforced elsewhere, in resolve_email_targets — the USER hasn't opted
    out of notification emails.

These call the real `_notify_if_new` with a stub session, so a gate removed from
the function is a failing test rather than an inbox.
"""
from datetime import date

import pytest

from modules.gl_accuracy import continuous as C

PE = date(2026, 8, 31)


class _Cfg:
    def __init__(self, email: bool):
        self.continuous_email = email


class _Tenant:
    id = "11111111-1111-1111-1111-111111111111"
    name = "Niyukti"


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None


class _Session:
    """Answers the recipient lookup and records commits."""

    def __init__(self, users=("u1", "u2")):
        self._users = list(users)
        self.commits = 0
        self.added = []

    async def execute(self, *a, **kw):
        return _Result(self._users)

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.commits += 1


@pytest.fixture
def sent(monkeypatch):
    """Capture digest sends instead of performing them."""
    calls = []

    async def _fake(session, tenant, pe, summary, recipients):
        calls.append({"period": pe, "summary": summary, "recipients": list(recipients)})

    monkeypatch.setattr(C, "_email_digest", _fake)
    return calls


@pytest.fixture(autouse=True)
def _no_real_notifications(monkeypatch):
    """`notify` only adds a row to the session; stub it so the test doesn't need
    the Notification model or a real session identity map."""
    import modules.notifications.service as N
    monkeypatch.setattr(N, "notify", lambda db, **kw: db.add(kw))


async def _run(*, new: int, email: bool, users=("u1", "u2")) -> tuple[_Session, list]:
    s = _Session(users)
    await C._notify_if_new(
        s, _Tenant(), PE,
        {"new": new, "scanned": 1847, "new_keys": [f"k{i}" for i in range(new)]},
        _Cfg(email),
    )
    return s, s.added


# ── Gate 1: something new ──────────────────────────────────────────────────

async def test_a_quiet_day_says_nothing_at_all(sent):
    """Not a quieter email — no email, and no in-app ping either. The silence
    IS the product working, and a daily 'we checked, all fine' is exactly the
    message people build a filter rule for."""
    s, added = await _run(new=0, email=True)
    assert added == [] and s.commits == 0
    assert sent == []


async def test_one_new_item_is_enough_to_speak(sent):
    s, added = await _run(new=1, email=True)
    assert len(added) == 2          # one in-app ping per user
    assert len(sent) == 1


# ── Gate 2: the workspace asked ────────────────────────────────────────────

async def test_email_is_off_by_default(sent):
    """The in-app notification still goes out — that's free and lives in the
    product. The email does not."""
    s, added = await _run(new=3, email=False)
    assert len(added) == 2, "in-app notification should still be created"
    assert sent == [], "emailed a workspace that never asked for email"


async def test_email_goes_out_when_the_workspace_asked(sent):
    await _run(new=3, email=True)
    assert len(sent) == 1
    assert sent[0]["recipients"] == ["u1", "u2"]


# ── The in-app path owns the email path's fate ─────────────────────────────

async def test_an_empty_workspace_is_not_emailed(sent):
    s, added = await _run(new=5, email=True, users=())
    assert added == [] and sent == []


async def test_the_digest_is_told_what_was_new_not_just_how_many(sent):
    """The mail names the items. Passing only a count would leave it saying
    '3 things happened' — which is a notification, not a digest."""
    await _run(new=3, email=True)
    assert sent[0]["summary"]["new_keys"] == ["k0", "k1", "k2"]


async def test_a_failing_email_never_breaks_the_sweep(monkeypatch):
    """One workspace's Resend problem must not stop the tick, and must not undo
    the in-app notification that already committed."""
    async def _boom(*a, **kw):
        raise RuntimeError("resend is down")

    monkeypatch.setattr(C, "_email_digest", _boom)
    s, added = await _run(new=2, email=True)      # must not raise
    assert len(added) == 2 and s.commits == 1


# ── The once-a-day guard must only be fed by the schedule ──────────────────
#
# THE BUG THAT SHIPPED. The guard exists to stop the hourly cron re-running the
# sweep it already ran today. It was reading the last SUCCESSFUL scan of any
# kind — so one press of "Check now", or the automatic pass after a QuickBooks
# sync, satisfied it and suppressed that day's scheduled check. The people who
# lost the feature were the ones using the product most: open it, sync, and the
# 9am watch never fires. Worse, the sync pass usually scans the month being
# CLOSED, so a successful scan of July suppressed the watch on August.

class _ScanRow:
    def __init__(self, trigger, finished_at, ok=True):
        self.trigger = trigger
        self.finished_at = finished_at
        self.ok = ok


class _ScanQueryDb:
    """Answers _last_ok_scan_at, recording the triggers the query filtered on."""

    def __init__(self, rows):
        self.rows = rows
        self.trigger_filters: list[str | None] = []

    async def execute(self, stmt, **kw):
        params = stmt.compile().params
        trig = next((v for k, v in params.items() if k.startswith("trigger")), None)
        self.trigger_filters.append(trig)
        match = [r for r in self.rows
                 if r.ok and (trig is None or r.trigger == trig)]
        match.sort(key=lambda r: r.finished_at, reverse=True)
        return _Result([match[0].finished_at] if match else [])


async def test_a_manual_check_does_not_satisfy_the_daily_guard():
    from datetime import UTC, datetime
    pressed = datetime(2026, 8, 29, 14, 0, tzinfo=UTC)
    db = _ScanQueryDb([_ScanRow("manual", pressed)])
    assert await C._last_ok_scan_at(db, _Tenant.id) is None, \
        "a button press suppressed the day's scheduled check"


async def test_a_post_sync_scan_does_not_satisfy_the_daily_guard():
    from datetime import UTC, datetime
    synced = datetime(2026, 8, 29, 8, 0, tzinfo=UTC)
    db = _ScanQueryDb([_ScanRow("sync", synced)])
    assert await C._last_ok_scan_at(db, _Tenant.id) is None


async def test_the_schedules_own_run_does_satisfy_it():
    from datetime import UTC, datetime
    ran = datetime(2026, 8, 29, 13, 0, tzinfo=UTC)
    db = _ScanQueryDb([_ScanRow("scheduled", ran)])
    assert await C._last_ok_scan_at(db, _Tenant.id) == ran


async def test_a_failed_scheduled_run_leaves_the_workspace_due():
    """Otherwise a workspace whose scans keep failing is skipped forever while
    the strip shows a failure nobody is acting on."""
    from datetime import UTC, datetime
    db = _ScanQueryDb([_ScanRow("scheduled", datetime(2026, 8, 29, 13, tzinfo=UTC), ok=False)])
    assert await C._last_ok_scan_at(db, _Tenant.id) is None


async def test_the_trigger_filter_is_applied_in_sql():
    from datetime import UTC, datetime
    db = _ScanQueryDb([_ScanRow("manual", datetime(2026, 8, 29, 14, tzinfo=UTC))])
    await C._last_ok_scan_at(db, _Tenant.id)
    assert "scheduled" in db.trigger_filters, "the query did not filter on trigger"


async def test_the_busiest_workspace_still_gets_its_daily_check():
    """End to end on the shape that produced the bug: fourteen manual checks
    today, and the schedule has still never run — so it is due."""
    from datetime import UTC, datetime

    from modules.gl_accuracy.schedule import is_due
    today = [_ScanRow("manual", datetime(2026, 8, 29, 10 + i, tzinfo=UTC))
             for i in range(14)]
    last = await C._last_ok_scan_at(_ScanQueryDb(today), _Tenant.id)
    assert is_due(timezone="America/New_York", check_hour=9,
                  last_ok_scan_at=last,
                  now_utc=datetime(2026, 8, 29, 13, tzinfo=UTC)) is True
