"""Every finding has somewhere to go, and it goes somewhere real.

Insights names problems precisely — "36% of AR is over 60 days old", "Tighten
collections — DSO at 137 days" — and used to leave the reader to find them. The
detail text even said "escalate the 61–90 bucket" while the screen listing that
bucket sat one unmentioned click away.

A link is only useful if it lands. These pin the two ways it can fail silently:
a recommendation with no action at all, and an action pointing at a section id
or route that does not exist.
"""
import pathlib
import re

import pytest

from modules.insights.service import _build_recommendations, act

# Rail ids in the Insights page's SECTIONS registry. An action naming anything
# else selects a pane that isn't there.
FRONTEND = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src"
INSIGHTS_PAGE = FRONTEND / "modules" / "insights" / "pages" / "InsightsPage.tsx"
APP_TSX = FRONTEND / "App.tsx"


def _rail_section_ids() -> set[str]:
    """Parse the SECTIONS registry the page actually renders."""
    src = INSIGHTS_PAGE.read_text(encoding="utf-8")
    block = src[src.index("const SECTIONS = ["):src.index("] as const")]
    return set(re.findall(r'\{\s*id:\s*"([a-z_]+)"', block))


def _app_routes() -> set[str]:
    """Every `/app/...` path the router declares, as full paths."""
    src = APP_TSX.read_text(encoding="utf-8")
    return {f"/app/{p}" for p in re.findall(r'<Route\s+path="([^"*:]+)"', src)}


# A payload that trips every rule at once, so all branches emit.
EVERY_RISK = {
    "liquidity":     {"runway_months": 2.0, "monthly_burn": 40000.0},
    "receivables":   {"dso_days": 137.0, "aging_over_60_pct": 36.0},
    "payables":      {"aging_over_60_pct": 40.0},
    "profitability": {"gross_margin_pct": 30.0, "gross_margin_pct_prior": 40.0,
                      "net_margin_pct": -5.0},
    "expenses":      {"biggest_mom_mover": {"category": "Payroll", "change_pct": 60.0,
                                            "from": 10000.0, "to": 16000.0}},
}


def test_every_recommendation_carries_an_action():
    recs = _build_recommendations(EVERY_RISK)
    assert recs, "fixture should trip several rules"
    for r in recs:
        assert r.get("action"), f"no action on: {r['title']}"
        assert r["action"]["label"], f"unlabelled action on: {r['title']}"


def test_the_all_clear_recommendation_also_has_one():
    """The healthy path is still a place someone might want to look."""
    recs = _build_recommendations({})
    assert len(recs) == 1
    assert recs[0]["action"]["label"]


def test_an_action_targets_a_section_or_a_route_never_both_and_never_neither():
    for r in _build_recommendations(EVERY_RISK):
        a = r["action"]
        assert bool(a["section"]) != bool(a["href"]), f"ambiguous target on: {r['title']}"


def test_every_section_target_is_a_real_rail_id():
    """A section id that isn't in SECTIONS selects a pane that doesn't exist."""
    ids = _rail_section_ids()
    assert "liquidity" in ids and "expenses" in ids, "registry parse looks wrong"
    for r in _build_recommendations(EVERY_RISK):
        sec = r["action"]["section"]
        if sec:
            assert sec in ids, f"{r['title']} -> unknown section {sec!r}"


def test_every_href_target_is_a_declared_route():
    """A dead link is worse than no link: it reads as a fix and goes nowhere."""
    routes = _app_routes()
    assert "/app/reconciliations/ar" in routes, "route parse looks wrong"
    for r in _build_recommendations(EVERY_RISK):
        href = r["action"]["href"]
        if href:
            assert href in routes, f"{r['title']} -> undeclared route {href!r}"


def test_the_ar_findings_lead_to_the_ar_screen():
    """The reported case: the detail told you to escalate the 61–90 bucket."""
    recs = _build_recommendations(EVERY_RISK)
    ar = [r for r in recs if "AR" in r["title"] or "DSO" in r["title"]]
    assert ar, "fixture should raise the AR findings"
    for r in ar:
        assert r["action"]["href"] == "/app/reconciliations/ar"


# ── act() ───────────────────────────────────────────────────────────────────

def test_act_builds_a_section_target():
    assert act("Look here", section="liquidity") == {
        "label": "Look here", "section": "liquidity", "href": None}


def test_act_builds_an_href_target():
    assert act("Go there", href="/app/flux") == {
        "label": "Go there", "section": None, "href": "/app/flux"}


@pytest.mark.parametrize("kwargs", [{}, {"section": "liquidity", "href": "/app/flux"}])
def test_an_action_with_no_target_or_two_is_caught_by_the_shape_rule(kwargs):
    """act() itself doesn't validate — the suite above is what enforces it, so
    prove that rule actually rejects both bad shapes."""
    a = act("x", **kwargs)
    assert bool(a["section"]) == bool(a["href"]), "this shape must fail the XOR rule"
