"""Cross-period arithmetic for the Copilot, and the honesty rules inside it.

The Copilot's other tools all answer "what is X, in this one month," so it had
no way to answer the questions people actually ask a controller — is this
getting better, where does it land, can we hit the number. The risk in adding
that is not arithmetic; it is confident extrapolation. Two points make a line,
a volatile series makes a smooth-looking trend, and any gap divided by any
number of months makes a "plan."

So these tests pin the refusals as hard as the calculations: what the module
declines to say is the part that makes the rest worth trusting.
"""
from datetime import date

import pytest

from modules.assistant.trend import (
    MIN_POINTS,
    bridge_to_target,
    cv,
    direction,
    forecast,
    month_ends_back,
    prior_month_end,
    rank_levers,
    slope,
    total_change_pct,
)

# ── Window construction ───────────────────────────────────────────────────────

def test_prior_month_end_crosses_the_year():
    assert prior_month_end(date(2026, 1, 31)) == date(2025, 12, 31)


def test_prior_month_end_lands_on_february():
    assert prior_month_end(date(2026, 3, 31)) == date(2026, 2, 28)


def test_month_ends_back_is_oldest_first_and_includes_the_latest():
    ends = month_ends_back(date(2026, 6, 30), 3)
    assert ends == [date(2026, 4, 30), date(2026, 5, 31), date(2026, 6, 30)]


def test_month_ends_back_is_capped():
    assert len(month_ends_back(date(2026, 6, 30), 500)) == 24


# ── Direction ─────────────────────────────────────────────────────────────────

def test_two_points_is_not_a_trend():
    """A line through two points is a line through two points. Reporting a
    direction from it would let one noisy month become a narrative."""
    assert direction([100.0, 130.0]) == "insufficient_data"


def test_steady_growth_reads_as_rising():
    assert direction([100.0, 110.0, 120.0, 130.0]) == "rising"


def test_steady_decline_reads_as_falling():
    assert direction([130.0, 120.0, 110.0, 100.0]) == "falling"


def test_small_drift_reads_as_flat_not_rising():
    """Month-to-month noise in a real ledger is routinely 1-2%. If that counted
    as a direction every account on the page would have a story."""
    assert direction([100.0, 101.0, 100.5, 101.5]) == "flat"


def test_a_wild_series_is_volatile_even_when_it_ends_higher():
    """The endpoints rise, but nothing here supports a decision. Calling this
    'rising' is the failure — it invites a plan the data cannot carry."""
    vals = [100.0, 320.0, 40.0, 260.0, 150.0]
    assert total_change_pct(vals) > 0
    assert direction(vals) == "volatile"


# ── Statistics ────────────────────────────────────────────────────────────────

def test_slope_is_the_per_step_change():
    assert slope([100.0, 110.0, 120.0, 130.0]) == pytest.approx(10.0)


def test_slope_refuses_below_the_minimum():
    assert slope([100.0] * (MIN_POINTS - 1)) is None


def test_cv_is_scale_free():
    """A $2k swing on $10k and a $200k swing on $1M are the same instability."""
    small = cv([9000.0, 11000.0, 10000.0])
    large = cv([900000.0, 1100000.0, 1000000.0])
    assert small == pytest.approx(large)


# ── Forecast ──────────────────────────────────────────────────────────────────

def test_forecast_refuses_below_three_months():
    out = forecast([100.0, 120.0], ahead=3)
    assert out["ok"] is False
    assert "at least" in out["reason"]
    assert out["points"] == []


def test_forecast_extrapolates_a_clean_trend():
    out = forecast([100.0, 110.0, 120.0, 130.0], ahead=2)
    assert out["ok"] is True
    assert out["method"] == "trend"
    assert out["points"][0]["value"] == pytest.approx(140.0, abs=0.5)
    assert out["points"][1]["value"] == pytest.approx(150.0, abs=0.5)


def test_a_clean_trend_forecasts_with_a_tight_band():
    out = forecast([100.0, 110.0, 120.0, 130.0], ahead=1)
    p = out["points"][0]
    assert p["high"] - p["low"] < 5.0
    assert out["confidence"] == "high"


def test_a_volatile_series_gets_the_average_not_a_trend_line():
    """The whole point. A straight line through this would produce a specific,
    confident number that the history gives no reason to believe."""
    out = forecast([100.0, 320.0, 40.0, 260.0, 150.0], ahead=3)
    assert out["ok"] is True
    assert out["method"] == "average"
    assert out["confidence"] == "low"


def test_a_volatile_forecast_band_is_visibly_wide():
    out = forecast([100.0, 320.0, 40.0, 260.0, 150.0], ahead=1)
    p = out["points"][0]
    assert p["high"] - p["low"] > 100.0


def test_the_band_widens_with_distance():
    """Month three is a guess about a guess, and should look like one."""
    out = forecast([100.0, 118.0, 119.0, 141.0], ahead=3)
    widths = [p["high"] - p["low"] for p in out["points"]]
    assert widths[0] < widths[1] < widths[2]


# ── The bridge to a target ────────────────────────────────────────────────────

def test_a_target_already_being_beaten_is_on_track():
    out = bridge_to_target(
        target=120_000, current_monthly=20_000, months_remaining=6,
        achieved_to_date=60_000, best_month=25_000,
    )
    assert out["reachable"] == "on_track"


def test_a_target_within_the_best_month_is_a_stretch():
    """They need $30k a month and have hit $34k before. Hard, but real."""
    out = bridge_to_target(
        target=240_000, current_monthly=20_000, months_remaining=6,
        achieved_to_date=60_000, best_month=34_000,
    )
    assert out["required_monthly"] == pytest.approx(30_000)
    assert out["reachable"] == "stretch"


def test_a_target_beyond_the_best_month_ever_is_called_unprecedented():
    """The arithmetic is trivially satisfiable; the business has never done it.
    Anyone can divide a gap by the months left — saying whether the answer is a
    plan or a wish is the part worth having."""
    out = bridge_to_target(
        target=360_000, current_monthly=20_000, months_remaining=6,
        achieved_to_date=60_000, best_month=34_000,
    )
    assert out["required_monthly"] == pytest.approx(50_000)
    assert out["reachable"] == "unprecedented"
    assert "34,000" in out["verdict"]


def test_a_wildly_out_of_reach_target_says_so_rather_than_planning_for_it():
    out = bridge_to_target(
        target=2_000_000, current_monthly=20_000, months_remaining=6,
        achieved_to_date=0, best_month=34_000,
    )
    assert out["reachable"] == "unprecedented_by_far"
    assert "different business" in out["verdict"]


def test_without_history_the_verdict_admits_it_does_not_know():
    out = bridge_to_target(
        target=600_000, current_monthly=20_000, months_remaining=6,
        achieved_to_date=0, best_month=None,
    )
    assert out["reachable"] == "unknown"
    assert "isn't enough history" in out["verdict"]


def test_no_months_left_is_not_an_infinite_run_rate():
    """Dividing by the months remaining is the obvious implementation and it
    raises here. The answer is that the window has closed, not a number."""
    out = bridge_to_target(
        target=500_000, current_monthly=20_000, months_remaining=0,
        achieved_to_date=100_000, best_month=34_000,
    )
    assert out["ok"] is True
    assert out["reachable"] == "no_time"
    assert out["gap"] == pytest.approx(400_000)


def test_a_monthly_run_rate_target_measures_the_run_rate_not_a_cumulative_total():
    out = bridge_to_target(
        target=50_000, current_monthly=30_000, months_remaining=6,
        target_kind="monthly", best_month=42_000,
    )
    assert out["required_monthly"] == pytest.approx(50_000)
    assert out["reachable"] == "unprecedented"


def test_the_shortfall_at_the_current_pace_is_reported():
    out = bridge_to_target(
        target=300_000, current_monthly=20_000, months_remaining=6,
        achieved_to_date=60_000, best_month=34_000,
    )
    assert out["at_current_pace"] == pytest.approx(180_000)
    assert out["shortfall_at_pace"] == pytest.approx(120_000)


# ── Levers ────────────────────────────────────────────────────────────────────

def test_a_lever_too_small_to_close_the_gap_is_marked_as_such():
    """Ranked by size alone, a $5k line and a $200k line look like two options.
    Only one of them can carry a $40k gap."""
    out = rank_levers([{"name": "Software", "monthly_amount": 5_000}], 40_000)
    assert out[0]["feasibility"] == "cannot_close_alone"
    assert out[0]["pct_cut_to_close_gap"] > 100


def test_a_modest_trim_on_a_big_line_is_plausible():
    out = rank_levers([{"name": "Contractors", "monthly_amount": 200_000}], 20_000)
    assert out[0]["pct_cut_to_close_gap"] == pytest.approx(10.0)
    assert out[0]["feasibility"] == "plausible"


def test_rent_is_structural_however_large_it_is():
    """"Reduce rent by 12%" is not a decision anyone can take on a Tuesday."""
    out = rank_levers([{"name": "Office Rent", "monthly_amount": 100_000}], 12_000)
    assert out[0]["structural"] is True
    assert out[0]["feasibility"] == "structural"


def test_depreciation_is_never_offered_as_a_saving():
    out = rank_levers([{"name": "Depreciation Expense", "monthly_amount": 80_000}], 10_000)
    assert out[0]["feasibility"] == "structural"


def test_levers_are_ranked_largest_first():
    out = rank_levers([
        {"name": "Software", "monthly_amount": 5_000},
        {"name": "Payroll", "monthly_amount": 180_000},
        {"name": "Travel", "monthly_amount": 22_000},
    ], 20_000)
    assert [r["name"] for r in out] == ["Payroll", "Travel", "Software"]


def test_a_zero_or_negative_line_is_not_a_lever():
    out = rank_levers([
        {"name": "Refunds", "monthly_amount": -400},
        {"name": "Empty", "monthly_amount": 0},
        {"name": "Real", "monthly_amount": 1_000},
    ], 100)
    assert [r["name"] for r in out] == ["Real"]
