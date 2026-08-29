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
