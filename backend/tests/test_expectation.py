"""Unit tests for the captured-judgment matching logic (Client Memory · flux
variance expectations).

`evaluate_expectation` is the safety-critical heart of Slice 2: it decides
whether a confirmed expectation rule fires this period and — crucially — whether
a variance may be marked `pre_explained`. The reputation risk we guard against
is a learned rule SILENTLY explaining a genuinely anomalous movement, so the
"outside tolerance ⇒ NOT pre_explained, flagged as deviating" path is tested as
carefully as the happy path. The function is pure (no DB), so these are plain
fast unit tests.
"""
from datetime import date
from decimal import Decimal

from modules.memory.service import evaluate_expectation


def _rule(**over):
    base = {
        "recurrence": "monthly",
        "expected_balance": "1000",
        "tolerance_pct": 15,
        "explanation": "Annual D&O insurance renewal",
    }
    base.update(over)
    return base


# ── Firing / recurrence ────────────────────────────────────────────────────────

def test_monthly_rule_fires_every_period():
    out = evaluate_expectation(_rule(recurrence="monthly"), date(2026, 3, 31), Decimal("1000"))
    assert out is not None
    assert out["expected_value"] == Decimal("1000")


def test_annual_rule_fires_only_in_its_month():
    rule = _rule(recurrence="annual", month=6)
    assert evaluate_expectation(rule, date(2026, 6, 30), Decimal("1000")) is not None
    # Any other month → the rule does not fire (caller falls back to run-rate).
    assert evaluate_expectation(rule, date(2026, 5, 31), Decimal("1000")) is None
    assert evaluate_expectation(rule, date(2026, 7, 31), Decimal("1000")) is None


def test_annual_rule_without_month_does_not_fire():
    assert evaluate_expectation(_rule(recurrence="annual", month=None), date(2026, 6, 30), Decimal("1000")) is None


def test_unknown_recurrence_does_not_fire():
    assert evaluate_expectation(_rule(recurrence="weekly"), date(2026, 6, 30), Decimal("1000")) is None
    assert evaluate_expectation(_rule(recurrence=None), date(2026, 6, 30), Decimal("1000")) is None


# ── pre_explained tolerance gating (the safety property) ───────────────────────

def test_within_tolerance_is_pre_explained():
    # expected 1000, ±15% → band is [850, 1150]
    out = evaluate_expectation(_rule(), date(2026, 3, 31), Decimal("1100"))
    assert out["pre_explained"] is True
    assert "Confirmed rule" in out["basis"]


def test_outside_tolerance_is_not_pre_explained_and_flags_deviation():
    out = evaluate_expectation(_rule(), date(2026, 3, 31), Decimal("5000"))
    assert out["pre_explained"] is False
    assert "Deviates" in out["basis"]          # never silently explains a real anomaly
    assert out["expected_value"] == Decimal("1000")


def test_exact_tolerance_boundary_is_within():
    # 1000 + 15% = 1150 exactly → within (<=)
    out = evaluate_expectation(_rule(), date(2026, 3, 31), Decimal("1150"))
    assert out["pre_explained"] is True
    out2 = evaluate_expectation(_rule(), date(2026, 3, 31), Decimal("1150.01"))
    assert out2["pre_explained"] is False


def test_zero_tolerance_requires_exact_match():
    out = evaluate_expectation(_rule(tolerance_pct=0), date(2026, 3, 31), Decimal("1000"))
    assert out["pre_explained"] is True
    out2 = evaluate_expectation(_rule(tolerance_pct=0), date(2026, 3, 31), Decimal("1000.01"))
    assert out2["pre_explained"] is False


def test_negative_expected_uses_absolute_tolerance_band():
    # expected -1000, ±15% → band [-1150, -850]
    rule = _rule(expected_balance="-1000")
    assert evaluate_expectation(rule, date(2026, 3, 31), Decimal("-900"))["pre_explained"] is True
    assert evaluate_expectation(rule, date(2026, 3, 31), Decimal("-100"))["pre_explained"] is False


def test_missing_tolerance_defaults_to_15_pct():
    rule = {"recurrence": "monthly", "expected_balance": "1000", "explanation": "x"}
    assert evaluate_expectation(rule, date(2026, 3, 31), Decimal("1140"))["pre_explained"] is True
    assert evaluate_expectation(rule, date(2026, 3, 31), Decimal("1200"))["pre_explained"] is False


# ── Malformed input never raises, never falsely explains ───────────────────────

def test_malformed_value_returns_none():
    assert evaluate_expectation(None, date(2026, 3, 31), Decimal("1000")) is None
    assert evaluate_expectation({}, date(2026, 3, 31), Decimal("1000")) is None
    assert evaluate_expectation(_rule(expected_balance="not-a-number"), date(2026, 3, 31), Decimal("1000")) is None


def test_garbage_tolerance_falls_back_safely():
    # A non-numeric tolerance must not crash; defaults to 15%.
    out = evaluate_expectation(_rule(tolerance_pct="oops"), date(2026, 3, 31), Decimal("1100"))
    assert out is not None and out["pre_explained"] is True


# ── Non-finite / out-of-range guards (would otherwise MASK a real anomaly) ─────

def test_infinite_tolerance_never_pre_explains_an_anomaly():
    # "Infinity" parses cleanly into Decimal and would make the band infinite —
    # silently pre-explaining ANY movement. The gate must reject it and fall back
    # to the 15% default, so a wildly-off actual is NOT pre_explained.
    for bad in ("Infinity", "inf", float("inf")):
        out = evaluate_expectation(_rule(tolerance_pct=bad), date(2026, 3, 31), Decimal("999999999"))
        assert out is not None, f"rule should still fire for tolerance={bad!r}"
        assert out["pre_explained"] is False, f"infinite tolerance masked an anomaly ({bad!r})"
        assert "Deviates" in out["basis"]
    # ...but a small, genuinely-within-15% move is still pre_explained.
    ok = evaluate_expectation(_rule(tolerance_pct="Infinity"), date(2026, 3, 31), Decimal("1100"))
    assert ok["pre_explained"] is True


def test_nan_tolerance_does_not_crash_and_falls_back():
    # NaN parses into Decimal('NaN'); the later `< 0` compare would RAISE
    # InvalidOperation and crash the run. The finiteness guard must catch it.
    out = evaluate_expectation(_rule(tolerance_pct="NaN"), date(2026, 3, 31), Decimal("1100"))
    assert out is not None and out["pre_explained"] is True       # fell back to 15%
    anomaly = evaluate_expectation(_rule(tolerance_pct=float("nan")), date(2026, 3, 31), Decimal("5000"))
    assert anomaly["pre_explained"] is False


def test_tolerance_above_cap_is_clamped_to_200_pct():
    # The capture path clamps to 1..200; the pure gate must never honor a wider
    # band than the product permits, even on a drifted/edited fact.
    rule = _rule(expected_balance="1000", tolerance_pct=100000)
    # 1000 ± 200% → band [-1000, 3000]; 3001 is just outside the clamped band.
    assert evaluate_expectation(rule, date(2026, 3, 31), Decimal("3000"))["pre_explained"] is True
    assert evaluate_expectation(rule, date(2026, 3, 31), Decimal("3000.01"))["pre_explained"] is False


def test_non_string_explanation_does_not_raise():
    # `explanation` lives in a schemaless JSONB blob. A truthy non-string value
    # must be coerced, not crash the documented-PURE function on .strip().
    for bad in (12345, 1.5, ["a", "b"], {"x": 1}, True):
        out = evaluate_expectation(_rule(explanation=bad), date(2026, 3, 31), Decimal("1000"))
        assert out is not None, f"explanation={bad!r} should still evaluate"
        assert out["pre_explained"] is True


def test_non_finite_expected_balance_does_not_fire():
    # A NaN/Infinity expectation is malformed — return None (fall back to
    # run-rate), never poison the tolerance math or the <= compare.
    assert evaluate_expectation(_rule(expected_balance="Infinity"), date(2026, 3, 31), Decimal("1000")) is None
    assert evaluate_expectation(_rule(expected_balance="NaN"), date(2026, 3, 31), Decimal("1000")) is None
