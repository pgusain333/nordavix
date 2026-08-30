"""The financial-health score, from a CPA's side of the desk.

REPORTED: a workspace with a NEGATIVE cash balance scored 89/100, was labelled
STRONG, and was advised to "deploy surplus deliberately". Three faults, all the
same mistake — building a judgement as an average.

  * No gates. A weighted sum lets four healthy measures outvote one fatal one.
    An overdrawn bank account is not a quarter of an opinion.
  * Unknowns scored half marks, so a workspace with no data at all scored 73
    and read STRONG on the strength of knowing nothing about it.
  * Cash was scored on the period's FLOW while ignoring the POSITION, which is
    how "operations fund themselves" printed over an overdraft.

These pin each band, each cap, and the arithmetic that ties them together — so
the number can be defended line by line rather than trusted.
"""
import pytest

from modules.insights.service import health_score

HEALTHY = dict(
    cash=250_000, runway_months=18, operating_cash_flow=40_000,
    net_margin_pct=22, current_ratio=2.1, dso_days=24, ar_over_60_pct=4,
)


def score(**over):
    return health_score(**{**HEALTHY, **over})


def band_of(key, result):
    return next(x for x in result["lines"] if x["key"] == key)


# ── The reported case ──────────────────────────────────────────────────────

def test_a_negative_cash_balance_cannot_read_as_healthy():
    """THE BUG. Every other measure strong, the bank overdrawn, and the page
    said 89/STRONG/'deploy surplus'."""
    r = score(cash=-21_200, runway_months=None)
    assert r["band"] == "at_risk"
    assert r["score"] < 45
    assert "negative" in r["headline"].lower()


def test_the_cap_is_shown_alongside_what_it_replaced():
    """A number that disagrees with its own components has to explain itself,
    or it just looks broken."""
    r = score(cash=-21_200, runway_months=None)
    assert r["raw_score"] > r["score"], "the cap did not actually bind"
    assert [c["rule"] for c in r["caps"]] == ["negative_cash"]
    assert "cannot fund itself" in r["caps"][0]["reason"]


def test_a_negative_balance_scores_nothing_on_the_cash_component():
    """Not partial credit. There is no reading of an overdraft that earns
    points toward financial health."""
    line = band_of("cash", score(cash=-1, runway_months=None))
    assert line["points"] == 0
    assert line["band"] == "overdrawn"


def test_positive_operating_cash_flow_does_not_rescue_a_negative_balance():
    """The exact confusion behind the 'Cash-gen · operations fund themselves'
    tile: the month's FLOW was fine and the POSITION was not, and only the flow
    was being scored."""
    flowing = score(cash=-21_200, runway_months=None, operating_cash_flow=50_000)
    assert band_of("cash", flowing)["points"] == 0
    assert flowing["band"] == "at_risk"


# ── Unknowns are excluded, never averaged ──────────────────────────────────

def test_a_workspace_with_no_data_gets_no_score():
    """It used to score 73 — STRONG — for having nothing in it."""
    r = health_score(cash=None, runway_months=None, operating_cash_flow=None,
                     net_margin_pct=None, current_ratio=None,
                     dso_days=None, ar_over_60_pct=None)
    assert r["score"] is None and r["band"] is None
    assert r["measured"] == 0


def test_one_measurable_component_is_not_a_score():
    """A number resting on a single input is a guess with a gauge around it."""
    r = health_score(cash=None, runway_months=None, operating_cash_flow=None,
                     net_margin_pct=30, current_ratio=None,
                     dso_days=None, ar_over_60_pct=None)
    assert r["score"] is None
    assert r["measured"] == 1


def test_a_partial_read_is_rescaled_not_penalised():
    """Two strong measures out of five is still strong — the missing three are
    unknown, not bad, and must not drag the result down either."""
    r = health_score(cash=None, runway_months=None, operating_cash_flow=None,
                     net_margin_pct=22, current_ratio=2.1,
                     dso_days=None, ar_over_60_pct=None)
    assert r["measured"] == 2
    assert r["score"] == 100      # 25/25 + 20/20
    assert r["band"] == "strong"


def test_the_count_of_measures_is_reported():
    """So the reader knows how much of the picture the number covers."""
    r = score()
    assert r["measured"] == 5 and r["of"] == 5


# ── Gates a good average must not outvote ──────────────────────────────────

def test_under_three_months_runway_caps_the_score():
    r = score(cash=10_000, runway_months=1.5)
    assert r["score"] <= 44 and r["band"] == "at_risk"
    assert "going-concern" in r["caps"][0]["reason"]


def test_a_working_capital_deficiency_cannot_be_rated_strong():
    """Current liabilities above current assets means near-term obligations
    depend on new money. That is not 'strong', whatever the margin is.

    Asserted as a BAND, not a number. The ceilings used to be four hand-picked
    figures — 39, 44, 54, 59 — and "why 39?" had no answer beyond "it is below
    45". Each gate now names the band it caps into and the ceiling follows, so
    the test asserts the claim rather than the arithmetic behind it."""
    r = score(current_ratio=0.8)
    assert r["band"] != "strong"
    assert r["caps"][0]["caps_to"] == "watch"


def test_losing_money_and_burning_cash_together_cannot_be_rated_strong():
    """Either alone is a metric; both at once is the balance sheet funding the
    profit and loss."""
    r = score(net_margin_pct=-8, operating_cash_flow=-30_000, runway_months=9)
    assert r["band"] != "strong"
    gate = next(c for c in r["caps"] if c["rule"] == "loss_and_burn")
    assert gate["caps_to"] == "watch"


def test_a_loss_alone_does_not_trigger_the_burn_cap():
    """A loss funded by non-cash charges — depreciation, amortisation — is not
    the same thing, and flagging it as such would cry wolf on every asset-heavy
    client."""
    r = score(net_margin_pct=-8, operating_cash_flow=15_000)
    assert not any(c["rule"] == "loss_and_burn" for c in r["caps"])


def test_the_strictest_cap_wins_when_several_apply():
    r = score(cash=-5_000, runway_months=1.0, current_ratio=0.5)
    assert r["score"] <= 39


# ── The headline can never contradict the components ───────────────────────

def test_the_headline_states_the_binding_constraint():
    """'Financially healthy — deploy surplus' over an overdraft was the whole
    complaint. When a cap binds, it is what the headline is about."""
    assert "negative" in score(cash=-1, runway_months=None)["headline"].lower()
    assert "runway" in score(cash=5_000, runway_months=1)["headline"].lower()


def test_a_genuinely_healthy_business_still_reads_healthy():
    """The gates must not make the score unable to say anything good."""
    r = score()
    assert r["band"] == "strong" and r["score"] >= 70
    assert r["caps"] == []
    assert "healthy" in r["headline"].lower()


# ── Auditability ───────────────────────────────────────────────────────────

def test_every_line_carries_its_value_band_and_basis():
    """The point of the rewrite: a partner asked to defend the number can read
    where each point came from."""
    for line in score()["lines"]:
        assert line["value"], f"{line['key']} has no value shown"
        assert line["band"], f"{line['key']} has no band"
        assert len(line["basis"]) > 30, f"{line['key']}: basis too thin to defend"
        assert 0 <= line["points"] <= line["max_points"]


def test_the_score_equals_its_own_arithmetic():
    """No hidden adjustment between the components and the total."""
    r = score()
    earned = sum(x["points"] for x in r["lines"])
    possible = sum(x["max_points"] for x in r["lines"])
    assert r["raw_score"] == round(100 * earned / possible)
    assert r["score"] == r["raw_score"]      # nothing capped here


@pytest.mark.parametrize("kwargs,expected", [
    (dict(runway_months=24), "12+ months"),
    (dict(runway_months=8), "6–12 months"),
    (dict(runway_months=4), "3–6 months"),
    (dict(runway_months=1), "under 3 months"),
])
def test_runway_bands(kwargs, expected):
    assert band_of("cash", score(**kwargs))["band"] == expected


@pytest.mark.parametrize("nm,expected", [
    (20, "15% or better"), (9, "5–15%"), (2, "0–5%"), (-4, "loss-making"),
])
def test_net_margin_bands(nm, expected):
    assert band_of("profitability", score(net_margin_pct=nm))["band"] == expected


def test_the_score_never_leaves_its_range():
    """Across the corners, including every gate firing at once."""
    for cash in (-100_000, 0, 500_000):
        for rw in (None, 0.5, 30):
            for nm in (-50, 0, 90):
                for cr in (0.1, 1.0, 9.0):
                    r = health_score(
                        cash=cash, runway_months=rw, operating_cash_flow=-1,
                        net_margin_pct=nm, current_ratio=cr,
                        dso_days=45, ar_over_60_pct=15,
                    )
                    assert r["score"] is None or 0 <= r["score"] <= 100


# ── One finding, stated once ───────────────────────────────────────────────
#
# The screen showed "Capped at 39 (the measures alone scored 52)" directly above
# "Capped at 44 (the measures alone scored 52)". Two numbers, the same
# parenthetical twice, and the reader left to work out that the lower one won —
# for what is one underlying fact: a negative balance IS zero runway.

def test_a_negative_balance_does_not_also_report_short_runway():
    """Same fact, once. Cash below zero already means the runway is gone."""
    r = score(cash=-21_200, runway_months=0.0)
    rules = [c["rule"] for c in r["caps"]]
    assert rules == ["negative_cash"], rules


def test_short_runway_is_still_reported_on_its_own():
    """Suppression is scoped to the redundancy — a thin runway with cash still
    in the bank is a distinct finding and must survive."""
    r = score(cash=8_000, runway_months=1.2)
    assert [c["rule"] for c in r["caps"]] == ["short_runway"]


def test_the_binding_cap_comes_first():
    """The UI leads with caps[0] and treats the rest as a footnote, so the
    strictest has to be the one it meets."""
    r = score(cash=8_000, runway_months=1.2, current_ratio=0.6,
              net_margin_pct=-9, operating_cash_flow=-4_000)
    assert len(r["caps"]) > 1
    assert r["caps"][0]["cap"] == min(c["cap"] for c in r["caps"])


def test_a_cap_that_changed_nothing_is_not_reported_as_binding():
    """A ceiling is not a floor. A period already scoring below where the
    scaling would put it is left alone, and the banner must not claim an
    intervention that did not happen — it once said "Held at 44 of 100" over a
    score of 40, contradicting the gauge beside it."""
    r = score(cash=200, runway_months=1.0, current_ratio=0.2,
              net_margin_pct=-80, operating_cash_flow=-50_000,
              dso_days=250, ar_over_60_pct=98)
    assert r["caps"], "the gates should still have fired"
    assert r["score"] == r["raw_score"], f'{r["score"]} vs raw {r["raw_score"]}'
    assert r["capped"] is False
    assert r["ceiling"] is None


def test_a_cap_that_did_bind_says_so():
    r = score(cash=-21_200, runway_months=None)
    assert r["capped"] is True
    assert r["score"] < r["raw_score"]


def test_the_strictest_ceiling_is_the_one_that_applies():
    """Several gates can fire; the tightest governs, and the score lands under
    it rather than under the most lenient one."""
    r = score(cash=-100, runway_months=None, current_ratio=0.4,
              net_margin_pct=-30, operating_cash_flow=-90_000)
    strictest = min(c["cap"] for c in r["caps"])
    assert r["score"] <= strictest
    assert r["ceiling"] in (strictest, None)


# ── A ceiling must not erase the ranking beneath it ────────────────────────
#
# REPORTED: March, April and May all read exactly 39. `min(raw, cap)` flattened
# every capped period onto the cap, so the gate answered the question and then
# discarded everything else — three materially different months scored
# identically. A rating notched down for one condition still ranks within the
# band it lands in.

def _overdrawn(nm, cr, dso):
    return health_score(cash=-21_200, runway_months=None, operating_cash_flow=-5_000,
                        net_margin_pct=nm, current_ratio=cr, dso_days=dso,
                        ar_over_60_pct=10)


def test_capped_periods_still_rank_against_each_other():
    """THE BUG. All three are overdrawn and all three are at risk — and a good
    month under a bad condition is still a better month."""
    march = _overdrawn(22, 2.1, 24)
    april = _overdrawn(4, 1.1, 55)
    may = _overdrawn(-12, 0.7, 80)
    assert march["score"] > april["score"] > may["score"], \
        f'{march["score"]} / {april["score"]} / {may["score"]}'


def test_every_capped_period_stays_in_the_band_the_gate_put_it_in():
    """Ranking within the band must never climb out of it."""
    for nm in range(-40, 60, 7):
        r = _overdrawn(nm, 2.0, 20)
        assert r["score"] <= 39
        assert r["band"] == "at_risk"


def test_the_ceiling_bounds_even_a_flawless_rest_of_business():
    """Everything else perfect, the bank overdrawn: the score stays under the
    ceiling — and cannot even reach it, because the component the gate is about
    scores zero. The gate and the measure agree rather than double-counting."""
    r = health_score(cash=-1, runway_months=None, operating_cash_flow=90_000,
                     net_margin_pct=60, current_ratio=5, dso_days=5,
                     ar_over_60_pct=0)
    assert r["score"] < 39
    assert r["band"] == "at_risk"
    assert band_of("cash", r)["points"] == 0


def test_a_ceiling_never_lifts_a_period_that_was_already_worse():
    """It is a ceiling, not a floor. A period scoring below the cap on its own
    measures must not be raised up to meet it."""
    r = health_score(cash=-1, runway_months=None, operating_cash_flow=-1,
                     net_margin_pct=-90, current_ratio=0.1, dso_days=200,
                     ar_over_60_pct=95)
    assert r["score"] <= r["raw_score"]


def test_the_scaled_score_moves_monotonically_with_the_measures():
    """No cliff: improving a component can never lower the score."""
    prev = -1
    for nm in range(-40, 80, 4):
        s = _overdrawn(nm, 2.0, 20)["score"]
        assert s >= prev, f"score fell from {prev} to {s} as margin improved"
        prev = s


def test_the_two_numbers_are_both_reported():
    """The panel says "the measures came to X; the ceiling for that band is Z,
    and scaled beneath it they give Y" — all three have to be there."""
    from modules.insights.service import WATCH_MIN
    r = _overdrawn(22, 2.1, 24)
    assert r["raw_score"] > r["score"]
    assert r["capped"] is True
    # Derived from the band boundary, not chosen: the top of "at risk".
    assert r["ceiling"] == WATCH_MIN - 1


def test_an_uncapped_period_reports_no_ceiling():
    r = score()
    assert r["ceiling"] is None and r["capped"] is False


# ── The ceilings are derived, not chosen ───────────────────────────────────

def test_every_ceiling_is_the_top_of_the_band_it_caps_into():
    """"Why 39?" had no answer beyond "it is below 45". Now a gate says which
    band a condition rules out and the number follows from the same two
    thresholds the bands themselves use — so there is nowhere left for a
    hand-picked figure to hide."""
    from modules.insights.service import STRONG_MIN, WATCH_MIN, band_for
    cases = [
        score(cash=-1, runway_months=None),
        score(cash=5_000, runway_months=1),
        score(current_ratio=0.8),
        score(net_margin_pct=-8, operating_cash_flow=-30_000, runway_months=9),
    ]
    tops = {"watch": STRONG_MIN - 1, "at_risk": WATCH_MIN - 1}
    for r in cases:
        for c in r["caps"]:
            assert c["cap"] == tops[c["caps_to"]], c
            # And the ceiling really is the top of that band.
            assert band_for(c["cap"]) == c["caps_to"]
            assert band_for(c["cap"] + 1) != c["caps_to"]


def test_a_gate_actually_holds_the_band_it_names():
    """The claim is "cannot be rated better than X". It has to be true even
    when every other measure is perfect."""
    perfect = dict(operating_cash_flow=90_000, net_margin_pct=60,
                   current_ratio=5, dso_days=5, ar_over_60_pct=0)
    r = health_score(cash=-1, runway_months=None, **perfect)
    assert r["band"] == "at_risk"
    r2 = health_score(cash=50_000, runway_months=20,
                      **{**perfect, "current_ratio": 0.8})
    assert r2["band"] in ("watch", "at_risk")
