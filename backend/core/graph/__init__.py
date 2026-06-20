"""
core.graph — the Nordavix accounting knowledge graph.

A thin relationship layer over the existing data: a single ``relationships``
edge table (models/relationship.py), a controlled vocabulary (schema.py), and a
generic read/write service (service.py). Modules dual-write edges where a
relationship is already implied; AI follows them to understand the story behind
a number. No graph database — plain Postgres, layered additively.

Typical use:

    from core.graph import Node, link, neighbors

    await link(db, Node("journal_entry", je_id), "explains",
               Node("reconciliation", recon_id), origin="ai")
    related = await neighbors(db, Node("reconciliation", recon_id))
"""
from core.graph.context import graph_context
from core.graph.schema import (
    NODE_TYPES,
    RELATIONS,
    GraphError,
    RelationSpec,
    inverse_of,
    validate_edge,
)
from core.graph.service import (
    MAX_DEPTH,
    Direction,
    Neighbor,
    Node,
    Origin,
    link,
    neighbors,
    subgraph,
    unlink,
)

__all__ = [
    # schema
    "NODE_TYPES",
    "RELATIONS",
    "RelationSpec",
    "GraphError",
    "inverse_of",
    "validate_edge",
    # context
    "graph_context",
    # service
    "Node",
    "Neighbor",
    "Origin",
    "Direction",
    "MAX_DEPTH",
    "link",
    "unlink",
    "neighbors",
    "subgraph",
]
