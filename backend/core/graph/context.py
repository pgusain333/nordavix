"""
graph_context — render an object's immediate knowledge-graph neighborhood as
compact text, ready to drop into an AI prompt so the model can reason over the
*relationships* behind a number, not just the number.

NOT wired into any prompt yet — this is the read primitive a later phase will
feed into the flux/recon AI runs (alongside the existing account guidance). Kept
dependency-light: it just groups neighbors() by relation.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from core.graph.schema import RELATIONS
from core.graph.service import Node, neighbors


def _label(relation: str) -> str:
    spec = RELATIONS.get(relation)
    return spec.label if spec else relation.replace("_", " ")


async def graph_context(db: AsyncSession, node: Node, *, limit: int = 40) -> str:
    """A compact block describing what `node` is connected to, grouped by
    relation (labeled from `node`'s perspective). Empty string when nothing is
    linked, so a caller can append it unconditionally."""
    nbrs = await neighbors(db, node, limit=limit)
    if not nbrs:
        return ""

    groups: dict[str, list[Node]] = {}
    for nb in nbrs:
        groups.setdefault(nb.relation, []).append(nb.node)

    lines: list[str] = []
    for relation, nodes in groups.items():
        sample = ", ".join(f"{n.type} {n.id}" for n in nodes[:5])
        more = f" (+{len(nodes) - 5} more)" if len(nodes) > 5 else ""
        lines.append(f"- {_label(relation)}: {sample}{more}")

    return "Related objects (from the accounting knowledge graph):\n" + "\n".join(lines)
