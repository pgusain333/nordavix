"""
Knowledge-graph read API — backs the "Related" panel.

    GET /api/graph/related?node_type=&node_id=&period_end=

Returns the resolved, relationship-grouped neighborhood of an object so the UI
can show what it's connected to. Read-only; tenant-scoped via the ambient
request context. The graph is populated by additive dual-writes elsewhere; this
endpoint only reads it.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from core.graph import NODE_TYPES, RELATIONS, Node, neighbors
from core.graph.resolve import resolve_nodes

router = APIRouter()


@router.get("/related")
async def related(
    tenant_id: CurrentTenantId,
    node_type: str = Query(..., description="The object type, e.g. 'account' or 'reconciliation'"),
    node_id: str = Query(..., description="The object's stable id"),
    period_end: str | None = Query(default=None, description="ISO date; folds in the recon node for an account"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The connected objects for one node, grouped by relationship and resolved
    to human labels. For an account viewed in a period (the recon drawer), also
    folds in the reconciliation node so the panel shows the full story —
    findings on the account, the schedule supporting the recon, and the journal
    entries that explain or affect it."""
    if node_type not in NODE_TYPES:
        return {"node": {"type": node_type, "id": node_id}, "groups": [], "total": 0}

    seeds = [Node(node_type, node_id)]
    if node_type == "account" and period_end:
        seeds.append(Node("reconciliation", f"{node_id}:{period_end}"))

    seen: set[tuple[str, str, str]] = set()
    nbrs = []
    for sn in seeds:
        for nb in await neighbors(db, sn):
            dedup = (nb.node.type, nb.node.id, nb.relation)
            if dedup in seen:
                continue
            seen.add(dedup)
            nbrs.append(nb)

    views = await resolve_nodes(db, [nb.node for nb in nbrs])

    grouped: dict[str, list[dict]] = {}
    for nb in nbrs:
        view = views.get((nb.node.type, nb.node.id))
        if view is None:
            continue
        grouped.setdefault(nb.relation, []).append(view.as_dict())

    groups = [
        {
            "relation": relation,
            "label": RELATIONS[relation].label if relation in RELATIONS else relation.replace("_", " "),
            "items": items,
        }
        for relation, items in grouped.items()
    ]
    # Biggest, most informative groups first; stable by label within a size.
    groups.sort(key=lambda g: (-len(g["items"]), g["label"]))

    return {
        "node": {"type": node_type, "id": node_id},
        "groups": groups,
        "total": sum(len(g["items"]) for g in groups),
    }
