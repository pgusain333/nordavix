"""The graph must not promise connections the product never makes.

`core/graph/schema.py` is a controlled vocabulary — ten node types and fourteen
relations, validated on every write. That discipline is what stops the
relationships table filling with junk. It also creates a quieter failure: a node
type or a relation can sit in the schema, fully specified and reviewed, with
nothing in the product that ever writes it and nothing that ever shows it.

Same class as a column nobody writes. The schema reads as a map of the product;
if a third of it is aspiration, it is a map of somewhere else. These tests pin
which parts are real, so the gap is a decision someone made rather than
something that drifted.

Static, over the source. No database — a graph with no edges in a test fixture
proves nothing about whether the code that writes them exists.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from core.graph.schema import NODE_TYPES, RELATIONS

BACKEND = Path(__file__).resolve().parent.parent
FRONTEND = BACKEND.parent / "frontend" / "src"
_SKIP = {"__pycache__", "tests", "alembic", ".venv", "venv"}


def _backend_files() -> list[str]:
    out = []
    for p in BACKEND.rglob("*.py"):
        if any(x in p.parts for x in _SKIP):
            continue
        # The schema declares; it does not write.
        if p.name == "schema.py" and "graph" in p.parts:
            continue
        try:
            out.append(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
    return out


def _backend_source() -> str:
    return "\n".join(_backend_files())


def _frontend_source() -> str:
    if not FRONTEND.exists():
        return ""
    parts = []
    for p in list(FRONTEND.rglob("*.tsx")) + list(FRONTEND.rglob("*.ts")):
        try:
            parts.append(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
    return "\n".join(parts)


BACKEND_FILES = _backend_files()
BACKEND_SRC = _backend_source()
FRONTEND_SRC = _frontend_source()

# Node types that are only ever the FAR end of an edge — nothing constructs a
# Node() for them because they are named by the producer on the other side.
# Each needs a reason.
_TARGET_ONLY: dict[str, str] = {}

# Declared, and deliberately not yet real. A debt register, not an escape
# hatch: the tests below refuse to let it grow, and fail if an entry is fixed
# and left here.
_NOT_YET_REAL: dict[str, str] = {
    "task": (
        "Tasks are DERIVED, not stored — _derive_recon_tasks and friends compute "
        "them per request from recons, flux and schedules, and TaskAction rows are "
        "only assignment/status overlays. Writing an edge per read would churn the "
        "table on every list call, and the relationship it would record is already "
        "encoded in the derivation. Real only once a manual task can name an "
        "account; until then 'blocks' and 'covers' are promises nothing keeps."
    ),
    "blocks": "endpoint is a task — see the task entry",
    "blocked_by": "endpoint is a task — see the task entry",
    "covers": "endpoint is a task — see the task entry",
    "covered_by": "endpoint is a task — see the task entry",
}


def _writes_node(node_type: str) -> bool:
    """Does anything construct a Node of this type?"""
    return bool(re.search(rf"""Node\(\s*["']{node_type}["']""", BACKEND_SRC))


def _writes_relation(relation: str) -> bool:
    """Does anything pass this relation to link()?

    Per FILE, not per call site, and this is deliberate. Two shapes defeat a
    call-site regex:

      link(db, Node("memo", str(row.id)), "documents", …)
          — the Node(…) closes a paren before the relation, so any pattern
            anchored on link( that forbids ')' stops short of it.
      await link(db, je, rel, target, …)   with  rel = _REL_FOR[entry.source]
          — the relation is a variable; the literal only appears in a mapping
            elsewhere in the file.

    So: the relation is written if its literal (or its inverse's — link() stores
    one directed edge and neighbours() flips it) appears in any file that calls
    link() at all. Coarser, and it cannot miss a real writer, which is the
    direction that matters for a test whose failure means "delete this from the
    schema".
    """
    inverse = RELATIONS[relation].inverse
    pattern = re.compile(rf"""["'](?:{re.escape(relation)}|{re.escape(inverse)})["']""")
    return any(pattern.search(src) for src in BACKEND_FILES if "link(" in src)


# ── The scanner has to work ────────────────────────────────────────────────

def test_the_sources_were_read():
    assert len(BACKEND_SRC) > 100_000, "backend source scan came back too small"
    assert len(FRONTEND_SRC) > 100_000, "frontend source scan came back too small"


def test_the_scanner_would_notice_an_unwritten_type():
    assert not _writes_node("nonexistent_type_zz")


# ── Every declared node type is written by something ───────────────────────

@pytest.mark.parametrize("node_type", sorted(NODE_TYPES))
def test_node_type_is_written(node_type):
    """A type in the vocabulary that nothing ever creates is a claim the
    product doesn't back."""
    if node_type in _NOT_YET_REAL or node_type in _TARGET_ONLY:
        pytest.skip(f"declared not-yet-real: {node_type}")
    assert _writes_node(node_type), (
        f"no producer ever builds Node({node_type!r}, …) — either write it, or "
        f"move it to _NOT_YET_REAL with a reason"
    )


@pytest.mark.parametrize("relation", sorted(RELATIONS))
def test_relation_is_written(relation):
    """A relation nothing links is an edge the graph will never contain."""
    if relation in _NOT_YET_REAL:
        pytest.skip(f"declared not-yet-real: {relation}")
    if relation == "relates_to":
        pytest.skip("the symmetric catch-all — deliberately unused until it isn't")
    assert _writes_relation(relation), (
        f"nothing calls link(..., {relation!r}, ...) or its inverse"
    )


# ── And is reachable by a human ────────────────────────────────────────────

PANEL = FRONTEND / "modules" / "graph" / "RelatedPanel.tsx"
PANEL_SRC = PANEL.read_text(encoding="utf-8") if PANEL.exists() else ""


def _object_literal(name: str) -> str:
    """The body of one named object literal in the panel, by brace matching.

    Searching the whole file per key was too loose: the panel has three maps
    keyed by node type, so a key present in ANY of them satisfied a test that
    claimed to check a specific one. Deleting `evidence` from the icon map
    passed clean because the subtitle map still had it — the test asserted more
    than it checked.
    """
    m = re.search(rf"\b{name}\b[^=]*=\s*\{{", PANEL_SRC)
    if not m:
        return ""
    depth, i = 1, m.end()
    while i < len(PANEL_SRC) and depth:
        depth += {"{": 1, "}": -1}.get(PANEL_SRC[i], 0)
        i += 1
    return PANEL_SRC[m.end():i]


TYPE_META_BODY = _object_literal("TYPE_META")
NOUNS_BODY = _object_literal("singular")


def test_the_related_panel_is_mounted_somewhere():
    assert "RelatedPanel" in FRONTEND_SRC


def test_the_panel_maps_were_found():
    """If brace matching failed, the two tests below assert nothing."""
    assert "account:" in TYPE_META_BODY, "could not locate TYPE_META"
    assert "account:" in NOUNS_BODY, "could not locate the noun map"


@pytest.mark.parametrize("node_type", sorted(NODE_TYPES))
def test_node_type_has_an_icon_in_the_panel(node_type):
    """A type with no icon falls back to a generic network glyph, so a schedule
    and a memo render identically. The panel resolves anything the graph can
    return, so its map has to cover the whole vocabulary."""
    assert re.search(rf"\b{node_type}\s*:", TYPE_META_BODY), (
        f"RelatedPanel's TYPE_META has no entry for {node_type!r}"
    )


@pytest.mark.parametrize("node_type", sorted(NODE_TYPES))
def test_node_type_has_a_word_in_the_panel(node_type):
    """The count strip says "2 findings · 1 schedule". A type missing from the
    noun map prints its raw key — "flux_variance", underscore and all."""
    assert re.search(rf"\b{node_type}\s*:", NOUNS_BODY), (
        f"RelatedPanel's labelForType has no noun for {node_type!r}"
    )


# ── The debt register stays honest ─────────────────────────────────────────

def test_nothing_in_the_register_is_secretly_done():
    """If a not-yet-real type gets written, this fails with the instruction to
    delete the entry. Otherwise the register rots into claims nobody checks."""
    done = sorted(k for k in _NOT_YET_REAL
                  if k in NODE_TYPES and _writes_node(k))
    assert not done, "these are written now — delete them from _NOT_YET_REAL: " + ", ".join(done)


def test_the_register_does_not_grow():
    assert len(_NOT_YET_REAL) <= 5, (
        f"{len(_NOT_YET_REAL)} unfulfilled schema entries — a new one belongs "
        f"written, or the schema entry belongs deleted"
    )


@pytest.mark.parametrize("key,reason", sorted({**_NOT_YET_REAL, **_TARGET_ONLY}.items()))
def test_every_register_entry_states_why(key, reason):
    assert len(reason) > 20, f"{key}: give a real reason, not {reason!r}"
