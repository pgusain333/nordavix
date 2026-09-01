"""No column may be read by the product and written by nothing.

TWO REAL BUGS, both found by accident while building something else, both
indistinguishable from a working feature from every angle except the one that
mattered:

  * `WorkpaperEvidence.verification` — returned by the router in three places.
    Nothing ever wrote it. The workpaper "verification status" was always null.
  * `CloseReviewFinding.note` — accepted by the endpoint, rendered by the page.
    Nothing ever sent one, so the column could not be non-null and every
    cleared exception in Close Review was an undocumented override.

That is a class, not two incidents, and the class is invisible in review: the
model looks right, the API looks right, the UI looks right, and the feature is
hollow. This test closes it.

PER-MODEL, not per-name. The first version of this scanner matched column names
across the whole codebase, and it could not see the `note` bug at all: `note`
is written as a local and a kwarg in a dozen places, so `CloseReviewFinding.note`
looked written by all of them. A test that misses the bug it was written for is
worse than no test. So writes are attributed to a model via the AST — the
constructor that made the row, or the `select()` / `update()` the variable came
out of — and a column is dead only when nothing writes it ON ITS OWN MODEL.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent

# Filled by the ORM or the database, never by a hand-written assignment.
_INFRASTRUCTURE = {"id", "tenant_id"}

# Written by machinery the scanner can't see. Each needs a reason, and the
# reason is the point: an entry here is a claim that a human checked.
_ALLOWED: dict[str, str] = {}

# Confirmed dead, not yet wired — the audit's own findings, kept visible.
#
# An allowlist that quietly absorbs failures is worse than no test, so these are
# separate: the rule below still refuses to let the list grow, another test
# fails if one of these is fixed and left here, and each entry says what the
# column is for. These are real gaps in Nordavix Allocate, not scanner
# artefacts. Keyed "Model.column".
_KNOWN_GAPS: dict[str, str] = {
    # ── Close app ──────────────────────────────────────────────────────
    "WorkpaperEvidence.verification": (
        "the founding case. Returned by the workpapers router in three places "
        "and written by nothing, so the verification status is always null. "
        "recons/router.py writes the identically-named column on "
        "SubledgerEvidence, which is what made this invisible for so long."
    ),
    "GlAccuracyFinding.note": (
        "the reviewer's reason for dismissing a Risk Radar finding. The exact "
        "shape of the CloseReviewFinding.note bug: declared, never written, so "
        "every dismissal is an undocumented one. Needs the reason prompt that "
        "Close Review now has."
    ),
    "Comment.edited_at": (
        "for an edit feature that does not exist — the comments router has GET, "
        "POST and DELETE and no edit endpoint. Either build editing or drop the "
        "column; leaving it implies an audit trail that isn't kept."
    ),
    # ── Nordavix Allocate (§471(c)) ────────────────────────────────────
    "AllocRun.eligible": (
        "whether the client passed the §448(c) test when this run was computed. "
        "evaluate_eligibility() returns it during setup; run_allocation() never "
        "captures it onto the run."
    ),
    "AllocRun.gross_receipts_3yr": (
        "the three-year average the §448(c) test used. Same gap as above — an "
        "exam file can't show what the client actually qualified on."
    ),
    "AllocRun.threshold_used": (
        "the §448(c) threshold in force that year. The run records whether it "
        "proceeded but not the number it was tested against."
    ),
    "AllocSettings.election_attested_by": (
        "who signed off on the method election. Needs an attest action in the "
        "UI; that is net-new, so it is recorded here rather than invented."
    ),
    "AllocSettings.election_attested_at": (
        "when the election was attested. Read by the exports and the settings "
        "payload, written by nothing. Pairs with the field above."
    ),
}

_SKIP_DIRS = {"__pycache__", "tests", "alembic", ".venv", "venv"}


def _python_sources() -> list[Path]:
    return [p for p in BACKEND.rglob("*.py")
            if not any(part in _SKIP_DIRS for part in p.parts)]


def _model_info() -> tuple[dict[str, set[str]], set[str]]:
    """({ModelName: columns}, {columns something other than app code fills}).

    Read off SQLAlchemy's mappers rather than parsed from source, so a column
    added in any style is covered. The second set is server_default / ORM
    default / onupdate — assigned by the database or the ORM, and flagging
    those would train people to ignore this test.
    """
    import models  # noqa: F401  — registers every mapper
    from core.db.base import Base

    cols: dict[str, set[str]] = {}
    filled: set[str] = set()
    for mapper in Base.registry.mappers:
        cols[mapper.class_.__name__] = {c.key for c in mapper.columns}
        for c in mapper.columns:
            if c.server_default is not None or c.onupdate is not None or c.default is not None:
                filled.add(c.key)
    return cols, filled


MODEL_COLUMNS, DB_FILLED = _model_info()
MODEL_NAMES = set(MODEL_COLUMNS)


class _WriteVisitor(ast.NodeVisitor):
    """Collect (model, column) pairs that source code actually assigns.

    Attribution, in the order it is tried:

      1. `CloseReview(period_end=…)`      — a constructor names its own model.
      2. `x = … CloseReviewFinding …`     — a variable whose defining expression
         mentions exactly one model (the `select(Model)` / `update(Model)`
         shape this codebase uses everywhere) is that model; later `x.col = …`
         is a write on it.
      3. `setattr(x, "col", …)`           — same, resolved through the variable.
      4. `for f in ("a","b"): setattr(x, f, …)` — the field-list update loop,
         where the column name never appears beside an `=` at all.

    An attribute write on a variable of unknown type is recorded as a WILDCARD
    and suppresses that column everywhere. That is the deliberate conservative
    direction: a false positive sends someone hunting a bug that isn't there,
    which is how a test like this gets deleted.
    """

    def __init__(self, polymorphic: frozenset[str] = frozenset()) -> None:
        self.writes: set[tuple[str, str]] = set()
        self.wildcards: set[str] = set()
        self._types: dict[str, str] = {}      # variable -> model name
        self._string_pool: set[str] = set()   # field-list strings in this file
        # Models this file constructs through a lookup table — `_CLS["lease"]`
        # resolving to ScheduleLease. The call is `cls(...)` on a variable, so
        # the AST cannot name the model; the mapping literal can. Kwargs on an
        # unresolved constructor are attributed to every model in the table.
        self._polymorphic = polymorphic

    # ── helpers ────────────────────────────────────────────────────────
    def _models_in(self, node: ast.AST) -> list[str]:
        found = {n.id for n in ast.walk(node)
                 if isinstance(n, ast.Name) and n.id in MODEL_NAMES}
        found |= {n.attr for n in ast.walk(node)
                  if isinstance(n, ast.Attribute) and n.attr in MODEL_NAMES}
        return sorted(found)

    def _record(self, model: str | None, col: str) -> None:
        if model:
            self.writes.add((model, col))
        else:
            self.wildcards.add(col)

    # ── visitors ───────────────────────────────────────────────────────
    def visit_Assign(self, node: ast.Assign) -> None:
        # Remember the type of a variable defined from a model expression.
        models = self._models_in(node.value)
        if len(models) == 1:
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    self._types[tgt.id] = models[0]
        # `obj.col = …`
        for tgt in node.targets:
            if isinstance(tgt, ast.Attribute):
                owner = tgt.value
                model = self._types.get(owner.id) if isinstance(owner, ast.Name) else None
                self._record(model, tgt.attr)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if isinstance(node.target, ast.Attribute):
            owner = node.target.value
            model = self._types.get(owner.id) if isinstance(owner, ast.Name) else None
            self._record(model, node.target.attr)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        fn = node.func
        name = fn.id if isinstance(fn, ast.Name) else (fn.attr if isinstance(fn, ast.Attribute) else "")
        # 1. Constructor: Model(col=…)
        if name in MODEL_NAMES:
            for kw in node.keywords:
                if kw.arg:
                    self.writes.add((name, kw.arg))
        # A constructor on a variable, in a file that maps names to models.
        elif self._polymorphic and node.keywords and name and name[0].islower() \
                and name not in _NOT_CONSTRUCTORS:
            for kw in node.keywords:
                if kw.arg:
                    for m in self._polymorphic:
                        self.writes.add((m, kw.arg))
        # .values(col=…) / .update(col=…) — attribute via the enclosing chain.
        elif name in ("values", "update"):
            models = self._models_in(node)
            model = models[0] if len(models) == 1 else None
            for kw in node.keywords:
                if kw.arg:
                    self._record(model, kw.arg)
        # 3./4. setattr(obj, "col", …) or setattr(obj, field, …)
        elif name == "setattr" and len(node.args) >= 2:
            owner = node.args[0]
            model = self._types.get(owner.id) if isinstance(owner, ast.Name) else None
            key = node.args[1]
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                self._record(model, key.value)
            else:
                # A variable key: the names come from a nearby literal list.
                for s in self._string_pool:
                    self._record(model, s)
        self.generic_visit(node)

    def _pool_literal(self, node: ast.Tuple | ast.List) -> None:
        """Only strings inside a tuple/list literal join the pool.

        Pooling every string constant in the file was too loose: a serializer
        dict's keys are string constants too, so `"election_attested_at":` in an
        output payload got attributed as a write by the unrelated setattr loop
        further down the file — a false negative that hid a genuinely dead
        column. The field-list update loop always iterates a literal sequence,
        so that is the only shape worth pooling.
        """
        for el in node.elts:
            if isinstance(el, ast.Constant) and isinstance(el.value, str) and el.value.isidentifier():
                self._string_pool.add(el.value)

    def visit_Tuple(self, node: ast.Tuple) -> None:
        self._pool_literal(node)
        self.generic_visit(node)

    def visit_List(self, node: ast.List) -> None:
        self._pool_literal(node)
        self.generic_visit(node)


# Calls that take keyword arguments but are not constructors. Without this the
# polymorphic fallback would treat every helper call in a schedules-style file
# as a row being built.
_NOT_CONSTRUCTORS = {
    "select", "update", "delete", "insert", "print", "dict", "sorted", "max",
    "min", "sum", "round", "len", "range", "getattr", "setattr", "isinstance",
    "format", "join", "values", "filter", "map", "field", "Field", "Query",
    "Depends", "get", "post", "put", "patch",
}


def _model_map_models(tree: ast.AST) -> frozenset[str]:
    """Models this file collects into a lookup table.

    `_CLS = {"lease": ScheduleLease, "loan": ScheduleLoan, …}` — the shape used
    to build one of several row types from a string kind. The constructor is
    then called on a variable, which no amount of AST walking can resolve, so
    the mapping literal is the only place the model names appear.
    """
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            names = {v.id for v in node.values
                     if isinstance(v, ast.Name) and v.id in MODEL_NAMES}
            if len(names) >= 2:
                found |= names
    return frozenset(found)


def _scan() -> tuple[set[tuple[str, str]], set[str]]:
    writes: set[tuple[str, str]] = set()
    wildcards: set[str] = set()
    for path in _python_sources():
        # Model files declare columns; that is not a write.
        if "models" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, SyntaxError):
            continue
        v = _WriteVisitor(_model_map_models(tree))
        v.visit(tree)
        writes |= v.writes
        wildcards |= v.wildcards
    return writes, wildcards


WRITES, WILDCARDS = _scan()


def _dead(include_known: bool = False) -> list[str]:
    out: list[str] = []
    for model, cols in sorted(MODEL_COLUMNS.items()):
        for col in sorted(cols):
            key = f"{model}.{col}"
            if col in _INFRASTRUCTURE or col in DB_FILLED or col in WILDCARDS:
                continue
            if key in _ALLOWED or (model, col) in WRITES:
                continue
            if not include_known and key in _KNOWN_GAPS:
                continue
            out.append(key)
    return out


# ── The scanner has to work before its verdict means anything ──────────────

def test_the_models_loaded():
    assert len(MODEL_COLUMNS) > 20, f"only {len(MODEL_COLUMNS)} mappers — did models fail to import?"


def test_the_scan_found_writes():
    assert len(WRITES) > 150, f"only {len(WRITES)} attributed writes — did the AST walk break?"


def test_attribution_is_per_model_not_per_name():
    """The upgrade that made this test able to see its own founding bug.

    A name-matching scanner counted `note` as written because a local variable
    somewhere is called `note`. Attribution has to be to the MODEL: the write
    that keeps CloseReviewFinding.note alive is the one on a CloseReviewFinding.
    """
    assert ("CloseReviewFinding", "note") in WRITES
    # And a column of the same name on a model that never writes it must not be
    # rescued by that. Nothing writes `note` on CloseReview itself.
    assert ("CloseReview", "note") not in WRITES


# ── The rule ───────────────────────────────────────────────────────────────

def test_no_model_column_is_written_by_nothing():
    """A column with no writer is a feature that only looks finished."""
    dead = _dead()
    assert not dead, (
        "declared and read, but nothing ever writes them — wire them up or "
        "drop them:\n  " + "\n  ".join(dead)
    )


def test_the_known_gaps_are_still_gaps():
    """Wiring one up should FAIL here, with the instruction to delete the entry.
    Otherwise the list rots into claims nobody re-checks."""
    still_dead = set(_dead(include_known=True))
    fixed = sorted(set(_KNOWN_GAPS) - still_dead)
    assert not fixed, "these are written now — delete them from _KNOWN_GAPS: " + ", ".join(fixed)


def test_the_known_gap_list_does_not_grow():
    """The list records what the audit found on 30 August 2026 and is a debt
    register, not an escape hatch. A NEW dead column fails the rule above; the
    fix is to write it, not to append here."""
    assert len(_KNOWN_GAPS) <= 9, (
        f"{len(_KNOWN_GAPS)} known gaps — new dead columns belong fixed, not exempted"
    )


@pytest.mark.parametrize("key,reason", sorted({**_ALLOWED, **_KNOWN_GAPS}.items()))
def test_every_exemption_states_why(key, reason):
    assert len(reason) > 40, f"{key}: give a real reason, not '{reason}'"
