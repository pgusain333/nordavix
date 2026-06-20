"""
Read/write the accounting knowledge graph.

Thin, generic, tenant-safe. Every write is validated against
``core.graph.schema`` and is idempotent (one live edge per
(tenant, src, relation, dst)); reads merge both directions into a uniform
neighbor view, labeling each edge from the queried node's perspective via the
registry inverse.

All calls rely on the ambient ``current_tenant_id`` (set by the request
middleware, a Celery task, or ``tenant_scope(...)``). Writes stamp it on the
row; the enforced SELECT auto-filter scopes reads — so an edge can never join
two tenants. Callers commit; this module only ``flush()``es (so an edge and the
business operation that created it share one transaction).
"""
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.db.base import current_tenant_id
from core.graph.schema import GraphError, inverse_of, validate_edge
from models.relationship import Relationship

Origin = Literal["user", "ai", "system", "backfill"]
Direction = Literal["out", "in", "both"]

# Hard cap on subgraph traversal depth — keeps "follow the story" bounded so it
# can never fan out into a runaway query or an oversized AI context.
MAX_DEPTH = 3


@dataclass(frozen=True)
class Node:
    """A graph node: an object type plus its stable id (as text)."""

    type: str
    id: str


@dataclass(frozen=True)
class Neighbor:
    """A related node, labeled from the *queried* node's perspective."""

    node: Node
    relation: str          # perspective relation (inverse applied for inbound)
    direction: str         # "out" (queried node is src) | "in" (queried node is dst)
    origin: str
    attributes: dict[str, Any] | None


def _require_tenant() -> uuid.UUID:
    tid = current_tenant_id.get()
    if not tid:
        raise GraphError(
            "no tenant in context — set current_tenant_id (or use tenant_scope) "
            "before any graph operation"
        )
    return tid


async def link(
    db: AsyncSession,
    src: Node,
    relation: str,
    dst: Node,
    *,
    origin: Origin = "system",
    attributes: dict[str, Any] | None = None,
    created_by: uuid.UUID | None = None,
) -> Relationship:
    """Create (or return the existing) live edge src --relation--> dst.

    Validated against the registry and idempotent: re-linking an existing live
    edge is a no-op that returns the current row (refreshing its attributes if
    new ones are supplied). Only user-originated links are audited — system/AI
    dual-writes are implied by an already-audited host action, so auditing them
    here would only flood the log.
    """
    validate_edge(src.type, relation, dst.type)
    tenant_id = _require_tenant()

    existing = (
        await db.execute(
            select(Relationship).where(
                Relationship.src_type == src.type,
                Relationship.src_id == str(src.id),
                Relationship.relation == relation,
                Relationship.dst_type == dst.type,
                Relationship.dst_id == str(dst.id),
                Relationship.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if attributes is not None and attributes != existing.attributes:
            existing.attributes = attributes
            await db.flush()
        return existing

    edge = Relationship(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        src_type=src.type,
        src_id=str(src.id),
        relation=relation,
        dst_type=dst.type,
        dst_id=str(dst.id),
        attributes=attributes,
        origin=origin,
        created_by=created_by,
    )
    db.add(edge)
    await db.flush()

    if origin == "user":
        await write_audit_event(
            db,
            tenant_id=tenant_id,
            user_id=created_by,
            action="graph.link",
            entity_type="relationship",
            entity_id=edge.id,
            metadata={"relation": relation, "src_type": src.type, "dst_type": dst.type},
        )
    return edge


async def unlink(
    db: AsyncSession,
    src: Node,
    relation: str,
    dst: Node,
    *,
    deleted_by: uuid.UUID | None = None,
) -> bool:
    """Soft-delete the live edge src --relation--> dst. Returns True if one was
    removed, False if none existed. History is preserved (deleted_at stamped)."""
    _require_tenant()
    edge = (
        await db.execute(
            select(Relationship).where(
                Relationship.src_type == src.type,
                Relationship.src_id == str(src.id),
                Relationship.relation == relation,
                Relationship.dst_type == dst.type,
                Relationship.dst_id == str(dst.id),
                Relationship.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if edge is None:
        return False
    edge.deleted_at = datetime.now(UTC)
    await db.flush()
    return True


async def neighbors(
    db: AsyncSession,
    node: Node,
    *,
    relations: list[str] | None = None,
    direction: Direction = "both",
    limit: int = 200,
) -> list[Neighbor]:
    """The nodes directly connected to `node`, each labeled from `node`'s
    perspective. `relations` filters on the STORED predicate (the canonical
    direction). `direction` selects outgoing edges (node is src), incoming
    (node is dst), or both."""
    _require_tenant()
    rels = set(relations) if relations else None
    out: list[Neighbor] = []

    if direction in ("out", "both"):
        q = select(Relationship).where(
            Relationship.src_type == node.type,
            Relationship.src_id == str(node.id),
            Relationship.deleted_at.is_(None),
        )
        if rels:
            q = q.where(Relationship.relation.in_(rels))
        for e in (await db.execute(q)).scalars():
            out.append(
                Neighbor(Node(e.dst_type, e.dst_id), e.relation, "out", e.origin, e.attributes)
            )

    if direction in ("in", "both"):
        q = select(Relationship).where(
            Relationship.dst_type == node.type,
            Relationship.dst_id == str(node.id),
            Relationship.deleted_at.is_(None),
        )
        if rels:
            q = q.where(Relationship.relation.in_(rels))
        for e in (await db.execute(q)).scalars():
            out.append(
                Neighbor(Node(e.src_type, e.src_id), inverse_of(e.relation), "in", e.origin, e.attributes)
            )

    return out[:limit]


async def subgraph(
    db: AsyncSession,
    node: Node,
    *,
    depth: int = 2,
    max_nodes: int = 100,
) -> dict[str, list[dict[str, Any]]]:
    """A bounded breadth-first neighborhood around `node` — the primitive AI
    uses to follow the story behind an object. Returns canonical (stored-
    direction) edges plus the set of reachable nodes. Depth is clamped to
    MAX_DEPTH and the node set to `max_nodes` so traversal stays cheap."""
    _require_tenant()
    depth = max(1, min(depth, MAX_DEPTH))

    seen: set[Node] = {node}
    frontier: list[Node] = [node]
    edge_rows: dict[uuid.UUID, Relationship] = {}

    for _ in range(depth):
        nxt: list[Node] = []
        for n in frontier:
            rows = (
                await db.execute(
                    select(Relationship).where(
                        or_(
                            and_(Relationship.src_type == n.type, Relationship.src_id == str(n.id)),
                            and_(Relationship.dst_type == n.type, Relationship.dst_id == str(n.id)),
                        ),
                        Relationship.deleted_at.is_(None),
                    )
                )
            ).scalars().all()
            for e in rows:
                edge_rows[e.id] = e
                other = (
                    Node(e.dst_type, e.dst_id)
                    if (e.src_type == n.type and e.src_id == str(n.id))
                    else Node(e.src_type, e.src_id)
                )
                if other not in seen and len(seen) < max_nodes:
                    seen.add(other)
                    nxt.append(other)
        frontier = nxt
        if not frontier:
            break

    return {
        "nodes": [{"type": x.type, "id": x.id} for x in seen],
        "edges": [
            {
                "src_type": e.src_type,
                "src_id": e.src_id,
                "relation": e.relation,
                "dst_type": e.dst_type,
                "dst_id": e.dst_id,
                "origin": e.origin,
            }
            for e in edge_rows.values()
        ],
    }
