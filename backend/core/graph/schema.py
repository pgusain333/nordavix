"""
The controlled vocabulary for the Nordavix accounting knowledge graph.

This is the graph's *schema*, expressed in code so it is reviewable and
diff-able. Every edge written through ``core.graph.service.link()`` is validated
against this registry, so the ``relationships`` table can never fill with typos,
illegal pairs, or inconsistent direction — that discipline is the difference
between a knowledge graph that compounds and a junk-drawer table.

A node is identified by ``(type, id)``. ``id`` is the most stable identifier of
the underlying object, stored as text. Per-type id convention (used by the
dual-write producers and any reader):

    account        -> qbo_account_id
    journal_entry  -> proposed_entries.id
    reconciliation -> reconciliations.id
    flux_variance  -> variances.id
    finding        -> gl_accuracy_findings.id
    task           -> task id (close_step_instances / task_actions)
    schedule       -> schedule_snapshots.id
    memo           -> comments.id
    period         -> period_end as ISO date "YYYY-MM-DD"

Extending the graph = add a node type here and/or a RelationSpec (with its
inverse). Keep it small and deliberate.
"""
from dataclasses import dataclass

# Object types that may participate as graph nodes.
NODE_TYPES: frozenset[str] = frozenset(
    {
        "account",
        "journal_entry",
        "reconciliation",
        "flux_variance",
        "finding",
        "task",
        "schedule",
        "memo",
        "period",
    }
)


@dataclass(frozen=True)
class RelationSpec:
    """A predicate in the graph: its inverse name (the same edge read from the
    other end) and the node types allowed on each side."""

    inverse: str
    src_types: frozenset[str]
    dst_types: frozenset[str]
    label: str


def _t(*types: str) -> frozenset[str]:
    return frozenset(types)


# Each relation is stored ONCE (directed, src -> dst). Its inverse is never
# written — readers compute it via inverse_of() so a single edge reads correctly
# from both ends. Inverses are declared in pairs (and verified at import below).
RELATIONS: dict[str, RelationSpec] = {
    # A journal entry explains a difference / drives a fix.
    "explains": RelationSpec(
        "explained_by", _t("journal_entry"), _t("reconciliation", "flux_variance", "finding"), "explains"
    ),
    "explained_by": RelationSpec(
        "explains", _t("reconciliation", "flux_variance", "finding"), _t("journal_entry"), "explained by"
    ),
    # A journal entry touches an account.
    "affects": RelationSpec("affected_by", _t("journal_entry"), _t("account"), "affects"),
    "affected_by": RelationSpec("affects", _t("account"), _t("journal_entry"), "affected by"),
    # A schedule (or memo) supports a reconciliation as its subledger / evidence.
    "supports": RelationSpec("supported_by", _t("schedule", "memo"), _t("reconciliation"), "supports"),
    "supported_by": RelationSpec("supports", _t("reconciliation"), _t("schedule", "memo"), "supported by"),
    # A finding was raised on an account.
    "found_on": RelationSpec("has_finding", _t("finding"), _t("account"), "found on"),
    "has_finding": RelationSpec("found_on", _t("account"), _t("finding"), "has finding"),
    # Something belongs to a period.
    "part_of": RelationSpec("has_part", _t("finding", "reconciliation"), _t("period"), "part of"),
    "has_part": RelationSpec("part_of", _t("period"), _t("finding", "reconciliation"), "has part"),
    # A finding/task blocks a task.
    "blocks": RelationSpec("blocked_by", _t("finding", "task"), _t("task"), "blocks"),
    "blocked_by": RelationSpec("blocks", _t("task"), _t("finding", "task"), "blocked by"),
    # A task covers (is the work for) a reconciliation/account.
    "covers": RelationSpec("covered_by", _t("task"), _t("reconciliation", "account"), "covers"),
    "covered_by": RelationSpec("covers", _t("reconciliation", "account"), _t("task"), "covered by"),
    # A memo documents a reconciliation/finding.
    "documents": RelationSpec("documented_by", _t("memo"), _t("reconciliation", "finding"), "documents"),
    "documented_by": RelationSpec("documents", _t("reconciliation", "finding"), _t("memo"), "documented by"),
    # Symmetric catch-all — use sparingly, only when no specific predicate fits.
    "relates_to": RelationSpec("relates_to", NODE_TYPES, NODE_TYPES, "relates to"),
}


class GraphError(ValueError):
    """An invalid edge: unknown node type, unknown relation, or a
    (src_type, relation, dst_type) triple the registry does not allow."""


def inverse_of(relation: str) -> str:
    """The name of `relation` read from the other endpoint."""
    spec = RELATIONS.get(relation)
    if spec is None:
        raise GraphError(f"unknown relation: {relation!r}")
    return spec.inverse


def validate_edge(src_type: str, relation: str, dst_type: str) -> None:
    """Raise GraphError unless (src_type, relation, dst_type) is a permitted
    triple. The single gate every write goes through."""
    spec = RELATIONS.get(relation)
    if spec is None:
        raise GraphError(f"unknown relation: {relation!r}")
    if src_type not in NODE_TYPES:
        raise GraphError(f"unknown source node type: {src_type!r}")
    if dst_type not in NODE_TYPES:
        raise GraphError(f"unknown target node type: {dst_type!r}")
    if src_type not in spec.src_types:
        raise GraphError(f"relation {relation!r} does not allow source type {src_type!r}")
    if dst_type not in spec.dst_types:
        raise GraphError(f"relation {relation!r} does not allow target type {dst_type!r}")


# Import-time consistency guard: every relation's inverse must exist and point
# back (so neighbors() can always flip an edge to the reader's perspective).
for _rel, _spec in RELATIONS.items():
    if _spec.inverse not in RELATIONS:
        raise RuntimeError(f"relation {_rel!r} has an undefined inverse {_spec.inverse!r}")
    if RELATIONS[_spec.inverse].inverse != _rel:
        raise RuntimeError(f"inverse of {_rel!r} is not symmetric ({_spec.inverse!r} -> {RELATIONS[_spec.inverse].inverse!r})")
