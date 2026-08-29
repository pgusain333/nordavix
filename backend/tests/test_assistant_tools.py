"""Every Copilot tool is declared, handled, and reachable.

A tool declared with no handler is invisible until a user asks the question it
was written for: the model calls it, the dispatcher falls through every `if`,
and the answer is a shrug. Nothing raises, nothing logs, and the Copilot simply
looks like it doesn't know about that part of the product.

These tests pin the three ways that happens — declared-but-unhandled,
handled-but-undeclared, and a description too thin for the model to route on.
"""
import inspect
import re

import pytest

from modules.assistant import tools as T

DECLARED = {d["name"] for d in T.TOOL_DEFS}
DISPATCH_SRC = inspect.getsource(T.run_tool) if hasattr(T, "run_tool") else ""


def handled_names() -> set[str]:
    """Tool names the dispatcher actually branches on."""
    src = DISPATCH_SRC
    if not src:
        # Fall back to the module source — the dispatcher may be named
        # differently; the assertion below reports it either way.
        src = inspect.getsource(T)
    return set(re.findall(r'if name == "([a-z_]+)"', src))


def test_the_dispatcher_was_found():
    """If this fails the rest of the file is checking nothing."""
    assert handled_names(), "no `if name == \"…\"` branches found — did the dispatcher move?"


def test_every_declared_tool_has_a_handler():
    """The silent failure: the model calls it, the dispatcher falls through,
    and the user gets a shrug instead of an answer."""
    missing = sorted(DECLARED - handled_names())
    assert not missing, f"declared with no handler: {missing}"


def test_every_handler_is_declared():
    """The mirror: a handler the model was never told about is dead code."""
    extra = sorted(handled_names() - DECLARED)
    assert not extra, f"handled but not declared to the model: {extra}"


def test_no_duplicate_tool_names():
    names = [d["name"] for d in T.TOOL_DEFS]
    dupes = sorted({n for n in names if names.count(n) > 1})
    assert not dupes, f"duplicate tool names — the later one wins silently: {dupes}"


@pytest.mark.parametrize("tool", T.TOOL_DEFS, ids=lambda d: d["name"])
def test_each_tool_is_routable(tool):
    """The model picks a tool from its description alone. A thin one is a tool
    that never gets called — the failure looks like the feature not existing."""
    desc = tool.get("description") or ""
    assert len(desc) >= 60, f"{tool['name']}: description too thin to route on"
    assert tool.get("input_schema", {}).get("type") == "object", \
        f"{tool['name']}: input_schema must be an object"


@pytest.mark.parametrize("tool", T.TOOL_DEFS, ids=lambda d: d["name"])
def test_period_taking_tools_document_the_default(tool):
    """Most questions arrive without a month. A period argument the model
    doesn't know it can omit makes it invent one."""
    props = (tool.get("input_schema") or {}).get("properties") or {}
    if "period_end" in props:
        d = (props["period_end"].get("description") or "").lower()
        assert "omit" in d, f"{tool['name']}: period_end should say it can be omitted"


# ── Coverage: the Copilot should reach the whole product ───────────────────

# Each area of Nordavix a user might ask about, and a tool that answers it.
# Extending the product without extending the Copilot is how it quietly stops
# being able to answer half the questions people have.
AREAS = {
    "reconciliations":  "get_reconciliations_overview",
    "account balances": "get_account_balance",
    "close progress":   "get_close_status",
    "close checklist":  "get_close_tasks",
    "adjustments":      "get_adjustments_queue",
    "insights":         "get_financial_insights",
    "flux":             "get_flux_variances",
    "schedules":        "get_schedules",
    "risk radar":       "get_risk_findings",
    "financials":       "get_financial_statements",
    "intercompany":     "get_intercompany",
    "team":             "get_team",
    "client memory":    "recall",
    "knowledge graph":  "get_related",
    "audit trail":      "get_audit_trail",
    "close review":     "get_close_review",
    "workpapers":       "get_workpapers",
    "advisory":         "get_advisory",
    "client evidence":  "get_evidence_requests",
    "automation":       "get_automation_status",
}


@pytest.mark.parametrize("area,tool_name", sorted(AREAS.items()))
def test_every_area_of_the_product_has_a_tool(area, tool_name):
    assert tool_name in DECLARED, f"nothing answers questions about {area}"


def test_the_copilot_can_write_as_well_as_read():
    """Read-only would make it a search box. It drafts entries and proposes
    actions — never posting to QuickBooks, which is the product's whole stance."""
    for w in ("draft_journal_entry", "suggest_action", "make_chart"):
        assert w in DECLARED


# ── The model has to know a tool exists to call it ─────────────────────────

def test_every_tool_appears_in_the_routing_prompt():
    """A tool absent from TOOL ROUTING is one the model rarely picks.

    Anthropic's tool-use does route on the schema description alone, but this
    Copilot's prompt carries an explicit question → tool map, and a tool left
    out of it loses to the ones that are named. The failure is invisible: the
    Copilot answers, just never with that tool, and the feature looks missing.
    """
    from modules.assistant.service import _SYSTEM_STATIC

    missing = sorted(d["name"] for d in T.TOOL_DEFS if d["name"] not in _SYSTEM_STATIC)
    assert not missing, (
        "declared but not named in the routing prompt — add a "
        "'question phrasing → tool' line for each: " + ", ".join(missing)
    )
