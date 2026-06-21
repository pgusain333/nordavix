"""
Accounting knowledge graph — registry + service tests.

Two layers:
  * Pure registry tests (no DB) — validation + inverse symmetry. Always run.
  * Service tests (need the test Postgres) — idempotent link, soft-delete
    unlink, both-direction neighbors with perspective labels, cross-tenant
    isolation, bounded subgraph.

Tenant isolation of the `relationships` table itself is covered automatically by
test_tenant_isolation_comprehensive.py (it discovers every TenantBase model and
asserts the fail-closed read filter + the tenant_isolation RLS policy).
"""
import uuid

import pytest

from core.db.base import tenant_scope
from core.graph import (
    GraphError,
    Node,
    graph_context,
    inverse_of,
    link,
    neighbors,
    subgraph,
    unlink,
    validate_edge,
)

# ── Pure registry tests (no DB) ─────────────────────────────────────────────


def test_validate_edge_accepts_known_triples():
    validate_edge("journal_entry", "explains", "reconciliation")
    validate_edge("journal_entry", "affects", "account")
    validate_edge("journal_entry", "explains", "finding")     # finding → fix loop
    validate_edge("schedule", "supports", "reconciliation")
    validate_edge("evidence", "supports", "reconciliation")   # uploaded file
    validate_edge("memo", "documents", "reconciliation")      # discussion note
    validate_edge("finding", "found_on", "account")


def test_validate_edge_rejects_unknown_relation():
    with pytest.raises(GraphError, match="unknown relation"):
        validate_edge("journal_entry", "frobnicates", "account")


def test_validate_edge_rejects_unknown_node_type():
    with pytest.raises(GraphError, match="unknown source node type"):
        validate_edge("widget", "relates_to", "account")
    with pytest.raises(GraphError, match="unknown target node type"):
        validate_edge("account", "relates_to", "widget")


def test_validate_edge_rejects_illegal_pair():
    # `affects` only goes journal_entry -> account.
    with pytest.raises(GraphError, match="does not allow source type"):
        validate_edge("reconciliation", "affects", "account")
    with pytest.raises(GraphError, match="does not allow target type"):
        validate_edge("journal_entry", "affects", "reconciliation")


def test_inverse_is_symmetric():
    assert inverse_of("explains") == "explained_by"
    assert inverse_of("explained_by") == "explains"
    assert inverse_of("relates_to") == "relates_to"  # symmetric


# ── Service tests (need the test database) ──────────────────────────────────


@pytest.mark.asyncio
async def test_link_is_idempotent(session, tenant_a):
    je, recon = str(uuid.uuid4()), str(uuid.uuid4())
    with tenant_scope(tenant_a):
        a = await link(session, Node("journal_entry", je), "explains", Node("reconciliation", recon))
        b = await link(session, Node("journal_entry", je), "explains", Node("reconciliation", recon))
        assert a.id == b.id  # re-link returns the same row, no duplicate
        outgoing = await neighbors(session, Node("journal_entry", je), direction="out")
    assert len(outgoing) == 1


@pytest.mark.asyncio
async def test_link_requires_tenant_context(session):
    # No tenant_scope → fail-closed.
    with pytest.raises(GraphError, match="no tenant in context"):
        await link(session, Node("journal_entry", "x"), "explains", Node("reconciliation", "y"))


@pytest.mark.asyncio
async def test_neighbors_perspective_labels(session, tenant_a):
    je, recon = str(uuid.uuid4()), str(uuid.uuid4())
    with tenant_scope(tenant_a):
        await link(session, Node("journal_entry", je), "explains", Node("reconciliation", recon), origin="ai")

        out = await neighbors(session, Node("journal_entry", je))
        assert [(n.node.type, n.relation, n.direction) for n in out] == [
            ("reconciliation", "explains", "out")
        ]

        inc = await neighbors(session, Node("reconciliation", recon))
        assert [(n.node.type, n.relation, n.direction) for n in inc] == [
            ("journal_entry", "explained_by", "in")
        ]


@pytest.mark.asyncio
async def test_unlink_soft_deletes(session, tenant_a):
    je, recon = str(uuid.uuid4()), str(uuid.uuid4())
    with tenant_scope(tenant_a):
        await link(session, Node("journal_entry", je), "explains", Node("reconciliation", recon))
        removed = await unlink(session, Node("journal_entry", je), "explains", Node("reconciliation", recon))
        assert removed is True
        assert await neighbors(session, Node("journal_entry", je)) == []
        # Idempotent: unlinking again is a no-op.
        assert await unlink(session, Node("journal_entry", je), "explains", Node("reconciliation", recon)) is False
        # And the edge can be re-created afterwards (partial-unique allows it).
        again = await link(session, Node("journal_entry", je), "explains", Node("reconciliation", recon))
        assert again.deleted_at is None


@pytest.mark.asyncio
async def test_edges_are_tenant_isolated(session, tenant_a, tenant_b):
    je, recon = str(uuid.uuid4()), str(uuid.uuid4())
    with tenant_scope(tenant_a):
        await link(session, Node("journal_entry", je), "explains", Node("reconciliation", recon))
    # Tenant B sees nothing — the SELECT auto-filter scopes every read.
    with tenant_scope(tenant_b):
        assert await neighbors(session, Node("reconciliation", recon)) == []


@pytest.mark.asyncio
async def test_subgraph_respects_depth(session, tenant_a):
    je, recon, period = str(uuid.uuid4()), str(uuid.uuid4()), "2026-05-31"
    with tenant_scope(tenant_a):
        await link(session, Node("journal_entry", je), "explains", Node("reconciliation", recon))
        await link(session, Node("reconciliation", recon), "part_of", Node("period", period))

        depth1 = await subgraph(session, Node("journal_entry", je), depth=1)
        types1 = {n["type"] for n in depth1["nodes"]}
        assert types1 == {"journal_entry", "reconciliation"}  # period not reached yet

        depth2 = await subgraph(session, Node("journal_entry", je), depth=2)
        types2 = {n["type"] for n in depth2["nodes"]}
        assert types2 == {"journal_entry", "reconciliation", "period"}
        assert len(depth2["edges"]) == 2


@pytest.mark.asyncio
async def test_graph_context_summarizes_neighbors(session, tenant_a):
    acct = str(uuid.uuid4())
    je = str(uuid.uuid4())
    with tenant_scope(tenant_a):
        await link(session, Node("finding", "txn1:acctX"), "found_on", Node("account", acct))
        await link(session, Node("journal_entry", je), "affects", Node("account", acct))
        text = await graph_context(session, Node("account", acct))
        empty = await graph_context(session, Node("account", str(uuid.uuid4())))

    assert "knowledge graph" in text.lower()
    assert "finding" in text and "journal_entry" in text
    assert empty == ""  # an unconnected node yields no context block


@pytest.mark.asyncio
async def test_resolve_nodes_labels_and_fallbacks(session, tenant_a):
    # schedule + period resolve by pure id-parsing (no DB row needed), so this
    # is robust on the create_all test DB regardless of which optional tables
    # (e.g. gl_balance_snapshots) the migrations-vs-create_all schema includes.
    from core.graph.resolve import resolve_nodes

    with tenant_scope(tenant_a):
        views = await resolve_nodes(session, [
            Node("schedule", "prepaid:1400:2026-05-31"),
            Node("period", "2026-05-31"),
        ])

    assert views[("schedule", "prepaid:1400:2026-05-31")].label == "Prepaid schedule"
    assert views[("period", "2026-05-31")].label == "May 2026"
