"""Continuous close: a finding's age, and the evidence that we looked.

Risk Radar replaces every OPEN finding on each scan — delete, then re-insert.
That is fine for the finding and was fatal for its age: `created_at` reset every
run, so after a nightly scan a fortnight-old problem looked like it appeared
this morning. Nothing built on top could work — no "4 new since yesterday", no
"first flagged three days ago", no time-to-detection.

`first_seen_at` survives the churn, keyed on finding_key. These tests pin the
rule that makes it true, and the reporting rule that a scan which crashed is
never read as a clean bill of health.
"""
from datetime import UTC, datetime, timedelta

import pytest

D0 = datetime(2026, 3, 10, 9, 0, tzinfo=UTC)


class _Row:
    """Stands in for a persisted GlAccuracyFinding across a re-scan."""

    def __init__(self, key, *, status="open", first_seen_at=None, created_at=D0):
        self.finding_key = key
        self.status = status
        self.first_seen_at = first_seen_at
        self.created_at = created_at


def carry_forward(existing: list[_Row]) -> dict[str, datetime]:
    """The rule under test, extracted exactly as the service applies it: every
    prior row contributes its age, whatever its status."""
    return {
        f.finding_key: (f.first_seen_at or f.created_at)
        for f in existing
        if (f.first_seen_at or f.created_at) is not None
    }


def rescan(existing: list[_Row], keys: list[str], now: datetime):
    """Return (first_seen per key, newly_seen count) for a scan producing `keys`."""
    seen_before = carry_forward(existing)
    out, newly = {}, 0
    for k in keys:
        fs = seen_before.get(k)
        if fs is None:
            fs, newly = now, newly + 1
        out[k] = fs
    return out, newly


# ── The bug this exists for ────────────────────────────────────────────────

def test_a_finding_that_persists_keeps_its_original_age():
    """THE BUG. The row is deleted and re-inserted every scan; if age came from
    the new row, a fortnight-old problem would look like it appeared today."""
    day5 = D0 + timedelta(days=5)
    seen, newly = rescan([_Row("dup:112", first_seen_at=D0)], ["dup:112"], now=day5)
    assert seen["dup:112"] == D0, "age reset on re-scan"
    assert newly == 0, "a persisting finding is not new"


def test_a_genuinely_new_finding_is_stamped_now_and_counted():
    day5 = D0 + timedelta(days=5)
    seen, newly = rescan([_Row("dup:112", first_seen_at=D0)], ["dup:112", "outlier:998"], now=day5)
    assert seen["dup:112"] == D0
    assert seen["outlier:998"] == day5
    assert newly == 1


def test_repeated_scans_with_no_change_report_nothing_new():
    """The quiet day. Three scans, same findings — a daily digest must not
    re-announce the same items every morning."""
    existing = [_Row("a", first_seen_at=D0), _Row("b", first_seen_at=D0)]
    for i in range(1, 4):
        seen, newly = rescan(existing, ["a", "b"], now=D0 + timedelta(days=i))
        assert newly == 0, f"scan {i} re-announced existing findings"
        assert set(seen.values()) == {D0}


def test_age_survives_a_finding_disappearing_and_coming_back():
    """A dismissed finding that re-opens is the same problem returning, not a
    new one — actioned rows contribute their age too, which is why the
    carry-forward map is built from ALL prior rows, not just open ones."""
    seen, newly = rescan(
        [_Row("dup:112", status="dismissed", first_seen_at=D0)],
        ["dup:112"], now=D0 + timedelta(days=9),
    )
    assert seen["dup:112"] == D0
    assert newly == 0


def test_a_row_predating_the_column_falls_back_to_created_at():
    """Migration 080 backfills first_seen_at from created_at; a row that somehow
    still has NULL must not be treated as brand new on the next scan."""
    seen, newly = rescan([_Row("dup:112", first_seen_at=None, created_at=D0)],
                         ["dup:112"], now=D0 + timedelta(days=2))
    assert seen["dup:112"] == D0
    assert newly == 0


def test_every_finding_is_new_on_the_very_first_scan():
    seen, newly = rescan([], ["a", "b", "c"], now=D0)
    assert newly == 3
    assert set(seen.values()) == {D0}


# ── The reporting rule ─────────────────────────────────────────────────────

def summarise(ok, finished_at):
    """What the status strip is allowed to claim, given a run's outcome."""
    if ok is True and finished_at is not None:
        return "checked"
    if ok is False:
        return "failed"
    return "running"


@pytest.mark.parametrize("ok,finished,expected", [
    (True,  D0,   "checked"),
    (False, D0,   "failed"),
    (None,  None, "running"),
    (None,  D0,   "running"),
])
def test_only_a_completed_successful_scan_counts_as_having_checked(ok, finished, expected):
    """A crashed or in-flight scan must never render as a clean bill of health.
    The absence of findings is reassuring only when the check finished."""
    assert summarise(ok, finished) == expected


def test_a_failed_scan_is_not_silently_treated_as_clean():
    assert summarise(False, D0) != "checked"
