"""Advice that grades itself.

The advisory module could record that a firm gave advice and never find out
whether the advice worked. A recommendation was one AI sentence with a
hardcoded "medium" priority and a kpi_key nothing ever wrote — while the KPI
trend sat on the same page, six months deep, with no join between them.

`grade_progress` is that join, and these tests are the argument for trusting
it. Its bias is the opposite of the staleness rule in Client Memory: there,
a false alarm destroys the feature, so the rule is shy. Here the danger is
flattery — a grader that rounds a metric going the wrong way into "flat" tells
a firm its advice is fine when it isn't, and that is the one output nobody
would ever check.
"""
import pytest

from modules.advisory.service import (
    KPI_BY_KEY,
    MOVE_TOLERANCE,
    grade_progress,
    normalize_rec_spec,
)


def g(baseline, current, target=None, higher_better=True):
    return grade_progress(
        baseline=baseline, current=current, target=target, higher_better=higher_better,
    )


# ── Direction belongs to the metric, not the caller ────────────────────────

def test_rising_is_progress_for_a_metric_that_should_rise():
    assert g(10.0, 14.0) == "working"


def test_rising_is_a_problem_for_a_metric_that_should_fall():
    """Days sales outstanding going UP is the client paying slower. A grader
    that treats every increase as improvement would congratulate a firm for
    advice that made collections worse."""
    assert g(41.0, 52.0, higher_better=False) == "worsening"


def test_falling_is_progress_when_lower_is_better():
    assert g(52.0, 47.0, higher_better=False) == "working"


@pytest.mark.parametrize("key", sorted(KPI_BY_KEY))
def test_every_catalog_metric_declares_its_direction(key):
    """`higher_better` is what makes direction a property of the metric rather
    than a guess at the call site. A KPI missing it would silently grade
    backwards."""
    assert isinstance(KPI_BY_KEY[key]["higher_better"], bool)


def test_dso_is_the_one_that_should_fall():
    """The catalog's only lower-is-better metric, and the one most likely to be
    got wrong. Pinned so a future edit has to be deliberate."""
    assert KPI_BY_KEY["dso"]["higher_better"] is False


# ── Reaching the target ends the argument ─────────────────────────────────

def test_hitting_the_target_is_achieved_however_small_the_move():
    """The target is the promise that was made. Meeting it is the answer, even
    if the metric barely moved to get there."""
    assert g(44.9, 45.0, target=45.0) == "achieved"


def test_the_target_is_read_in_the_metrics_own_direction():
    """45 is a floor for runway and a ceiling for DSO. Same number, opposite
    tests, and the caller never says which."""
    assert g(30.0, 46.0, target=45.0, higher_better=True) == "achieved"
    assert g(60.0, 44.0, target=45.0, higher_better=False) == "achieved"
    assert g(30.0, 46.0, target=45.0, higher_better=False) == "worsening"


def test_overshooting_the_target_is_still_achieved():
    assert g(20.0, 90.0, target=45.0) == "achieved"


def test_without_a_target_it_grades_on_direction_alone():
    """Some advice is directional — "get this moving" — and inventing a target
    to satisfy the grader would put a number on the page nobody set."""
    assert g(10.0, 12.0, target=None) == "working"


# ── The tolerance, and why it's relative ──────────────────────────────────

def test_a_move_inside_the_tolerance_is_flat_not_progress():
    """Most advice takes a period or two. Calling noise 'working' would make
    every recommendation look like it landed the month it was written."""
    assert g(100.0, 100.0 + 100.0 * MOVE_TOLERANCE / 2) == "flat"


def test_a_move_past_the_tolerance_counts():
    assert g(100.0, 100.0 + 100.0 * MOVE_TOLERANCE * 2) == "working"


def test_the_tolerance_scales_to_the_metric():
    """THE REASON IT IS RELATIVE. A current ratio moving 0.5 is a large fact; a
    cash balance moving 0.5 is nothing. A fixed threshold would call one frozen
    and the other alive."""
    assert g(2.0, 2.5) == "working"            # current ratio: +25%
    assert g(500_000.0, 500_000.5) == "flat"   # cash: +0.0001%


def test_no_movement_at_all_is_flat():
    assert g(12.0, 12.0) == "flat"


def test_a_zero_baseline_treats_any_real_movement_as_movement():
    """A percentage of zero is no threshold at all, so the rule falls back to
    direction rather than dividing its way to nonsense."""
    assert g(0.0, 5.0) == "working"
    assert g(0.0, -5.0) == "worsening"
    assert g(0.0, 0.0) == "flat"


def test_a_negative_baseline_still_measures_distance_from_it():
    """Net income of -20,000 improving to -5,000 is the advice working, even
    though both numbers are losses."""
    assert g(-20_000.0, -5_000.0) == "working"
    assert g(-20_000.0, -30_000.0) == "worsening"


# ── What it refuses to grade ──────────────────────────────────────────────

def test_no_baseline_is_unknown_not_flat():
    """Recommendations written before the metric was ever captured. Reporting
    that honestly beats grading against a number nobody set — and 'flat' would
    quietly file them as neither working nor failing."""
    assert g(None, 40.0) == "unknown"


def test_no_current_reading_is_unknown():
    assert g(40.0, None) == "unknown"


def test_unknown_survives_a_target():
    """A target cannot rescue a missing reading."""
    assert g(None, None, target=45.0) == "unknown"


# ── The AI contract, in both shapes ───────────────────────────────────────

def test_a_bare_string_still_parses():
    """Cached narratives from before the contract change. A schema change that
    blanked a month of advice would be a worse bug than the one it fixed."""
    s = normalize_rec_spec("Tighten collections on the five slowest payers")
    assert s["title"].startswith("Tighten collections")


def test_a_structured_spec_keeps_its_fields():
    s = normalize_rec_spec({
        "title": "Tighten collections", "detail": "52 days, up from 41.",
        "kpi_key": "dso", "priority": "high", "expected_impact": 38000,
        "impact_note": "cash released",
    })
    assert (s["kpi_key"], s["priority"], s["expected_impact"]) == ("dso", "high", 38000.0)


def test_a_kpi_key_outside_the_catalog_is_dropped_not_stored():
    """THE POINT OF CONSTRAINING THE MODEL. A key nothing can resolve would
    grade against nothing while the row looked linked."""
    assert normalize_rec_spec({"title": "x", "kpi_key": "vibes"})["kpi_key"] is None


def test_an_unknown_priority_falls_back_rather_than_raising():
    assert normalize_rec_spec({"title": "x", "priority": "urgent"})["priority"] == "medium"


def test_a_spec_with_no_title_is_dropped():
    """A recommendation is its title; without one there is nothing to track."""
    assert normalize_rec_spec({"detail": "orphan"}) is None
    assert normalize_rec_spec("   ") is None
    assert normalize_rec_spec(None) is None


# ── Linking a metric to advice that already exists ────────────────────────
#
# The scorecard said "10 recommendations aren't tied to a metric, so they can't
# be graded. Link one to start tracking them" — and there was nowhere to do it.
# kpi_key could only be set at creation, so every item written before that
# change was permanently ungradable while the page invited you to fix it.
#
# Linking one late raises a question creation doesn't: measured from WHEN? The
# answer has to be the month the advice was given, not today, or a piece of
# advice that has already worked reads as "no change yet".

def test_a_late_link_still_grades_from_when_the_advice_was_given():
    """Advised in April at 52 days; linked in September. Measuring from the
    April reading shows the work that happened in between."""
    assert grade_progress(baseline=52.0, current=47.0, target=None,
                          higher_better=False) == "working"


def test_measuring_from_today_would_have_erased_that_progress():
    """The same advice, baselined at today's reading instead of April's. It
    grades flat — five days of real improvement reported as nothing. This is
    what makes the baseline choice load-bearing rather than a detail."""
    assert grade_progress(baseline=47.0, current=47.0, target=None,
                          higher_better=False) == "flat"
