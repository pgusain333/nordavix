"""
Invariant: the Autopilot stale-run watchdog (`_run_is_live`).

A run left status='running' after a crash (the process died before setting
finished_at) must NOT count as live forever — otherwise the 409 guard locks the
workspace out of every future run. This locks the staleness rule: a fresh
'running' run is live; one past the threshold is not (so it gets reclaimed and a
new run can start). Pure function, runs standalone:
    python tests/test_autopilot_watchdog.py
"""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from modules.autopilot.router import _STALE_RUN_AFTER, _run_is_live


def _run(status, age):
    return SimpleNamespace(status=status, started_at=datetime.now(UTC) - age)


def test_fresh_running_is_live():
    assert _run_is_live(_run("running", timedelta(minutes=2)), datetime.now(UTC)) is True


def test_stale_running_is_not_live():
    stale = _run("running", _STALE_RUN_AFTER + timedelta(minutes=1))
    assert _run_is_live(stale, datetime.now(UTC)) is False


def test_finished_statuses_are_never_live():
    now = datetime.now(UTC)
    for s in ("completed", "partial", "failed"):
        assert _run_is_live(_run(s, timedelta(minutes=1)), now) is False, s


def test_missing_started_at_is_not_live():
    run = SimpleNamespace(status="running", started_at=None)
    assert _run_is_live(run, datetime.now(UTC)) is False


if __name__ == "__main__":
    test_fresh_running_is_live()
    test_stale_running_is_not_live()
    test_finished_statuses_are_never_live()
    test_missing_started_at_is_not_live()
    print("AUTOPILOT_WATCHDOG_OK")
