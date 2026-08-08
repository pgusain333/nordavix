"""The frozen working paper behind an approved reconciliation.

This gates the deploy (`pytest -m invariant`, tagged by filename in
conftest.py), because the snapshot is the evidence a reconciliation was
concluded correctly. If it silently records something other than what was
signed, it is worse than not having it — it looks like proof.

What the recon screen does today is read GL live from QuickBooks on every
render. A reconciliation approved in March and reopened in June can therefore
show different numbers, and nothing records the difference. The snapshot is
what was actually on screen at sign-off; the hash is what makes it evidence
rather than a note.

The invariants:
  1. `variance` is DERIVED, never trusted from input — a stored total that
     disagrees with its own arithmetic is the failure this exists to prevent
  2. The hash covers every field, so any edit changes it
  3. The hash is STABLE across key order and equivalent numeric spellings —
     otherwise it flags false tampering and nobody believes it
  4. Origin is preserved, and an unrecognised one degrades to `human` (never
     to `system`, which would overstate reproducibility)
  5. An AI item keeps `accepted_by` — a suggestion nobody confirmed and one a
     preparer accepted must not hash identically
  6. Drift reports movement since sign-off, and reports none when nothing moved

Import-light on purpose: importing `main` drags in the Clerk JWKS chain, which
needs a real publishable key — fine locally, fatal in CI. That break has
happened; don't reintroduce it.

pytest isn't installed in every env, so this also runs standalone:
    python tests/test_recon_conclusion.py
"""
from decimal import Decimal

from modules.recons.conclusion import (
    ORIGIN_AI,
    ORIGIN_HUMAN,
    ORIGIN_SYSTEM,
    build_snapshot,
    drift,
    normalize_item,
    snapshot_hash,
)


def _snap(**over):
    base = dict(
        qbo_account_id="93",
        period_end="2026-03-31",
        gl_balance="12500.00",
        gl_source="QuickBooks GL snapshot for 2026-03-31",
        gl_as_of=None,
        subledger_total="12100.00",
        subledger_origin=ORIGIN_HUMAN,
        subledger_evidence_id=None,
        items=[],
        ai_basis=None,
        approved_by="u-1",
        prepared_by="u-2",
    )
    base.update(over)
    return build_snapshot(**base)


# ── 1. Variance is arithmetic, not input ─────────────────────────────────────

def test_variance_is_derived_not_supplied():
    """The signature is on GL − subledger. If the snapshot could carry a
    variance that disagrees with its own two balances, an approval could be
    frozen around a number that was never true."""
    s = _snap(gl_balance="12500.00", subledger_total="12100.00")
    assert s["variance"] == "400.00"

    # There is no way to inject a different one: build_snapshot takes no
    # variance argument at all.
    import inspect
    assert "variance" not in inspect.signature(build_snapshot).parameters


def test_variance_is_none_when_a_side_is_missing():
    """No subledger means no reconciliation — not a variance equal to the GL."""
    assert _snap(subledger_total=None)["variance"] is None
    assert _snap(gl_balance=None)["variance"] is None


# ── 2 & 3. The hash is the evidence ──────────────────────────────────────────

def test_any_edit_changes_the_hash():
    original = snapshot_hash(_snap())
    assert snapshot_hash(_snap(subledger_total="12100.01")) != original
    assert snapshot_hash(_snap(gl_balance="12500.01")) != original
    assert snapshot_hash(_snap(approved_by="u-9")) != original
    assert snapshot_hash(_snap(gl_source="somewhere else")) != original
    assert snapshot_hash(
        _snap(items=[{"label": "in transit", "amount": "50.00"}])
    ) != original


def test_hash_is_stable_across_equivalent_spellings():
    """A hash that changes when nothing did is a tamper alarm nobody trusts.

    `12100`, `12100.00` and Decimal("12100.0") are the same balance; the
    quantize in `_num` is what makes them the same bytes.
    """
    a = snapshot_hash(_snap(subledger_total="12100"))
    b = snapshot_hash(_snap(subledger_total="12100.00"))
    c = snapshot_hash(_snap(subledger_total=Decimal("12100.0")))
    assert a == b == c


def test_hash_ignores_key_insertion_order():
    s1 = _snap()
    s2 = {k: s1[k] for k in reversed(list(s1.keys()))}
    assert snapshot_hash(s1) == snapshot_hash(s2)


# ── 4. Provenance survives, and degrades safely ──────────────────────────────

def test_origins_are_preserved():
    s = _snap(items=[
        {"label": "deposit in transit", "amount": "500.00", "origin": ORIGIN_SYSTEM},
        {"label": "unrecorded fee", "amount": "-25.00", "origin": ORIGIN_HUMAN},
    ])
    assert [i["origin"] for i in s["items"]] == [ORIGIN_SYSTEM, ORIGIN_HUMAN]


def test_unknown_origin_degrades_to_human_not_system():
    """`system` is a claim that the figure is reproducible from a source.
    Guessing it for an item whose provenance we don't know would overstate how
    much of the conclusion can be re-derived."""
    assert normalize_item({"label": "x", "amount": "1.00", "origin": "wat"})["origin"] == ORIGIN_HUMAN
    assert normalize_item({"label": "x", "amount": "1.00"})["origin"] == ORIGIN_HUMAN
    assert _snap(subledger_origin="wat")["subledger_origin"] == ORIGIN_HUMAN


# ── 5. An accepted AI suggestion is not the same object as an unreviewed one ─

def test_ai_item_records_who_accepted_it():
    proposed = normalize_item({
        "label": "matched to statement line 14", "amount": "500.00",
        "origin": ORIGIN_AI, "ai_confidence": "high",
    })
    accepted = normalize_item({
        "label": "matched to statement line 14", "amount": "500.00",
        "origin": ORIGIN_AI, "ai_confidence": "high", "accepted_by": "u-2",
    })
    assert proposed["accepted_by"] is None
    assert accepted["accepted_by"] == "u-2"
    # The distinction has to reach the hash, or the record can't tell them apart.
    assert snapshot_hash(_snap(items=[proposed])) != snapshot_hash(_snap(items=[accepted]))


def test_normalizing_twice_loses_nothing():
    """`build_snapshot` normalizes whatever it is handed, and the router hands
    it items it has ALREADY normalized to attach provenance. A second pass that
    strips fields would silently drop `cleared` — the flag separating an item
    that explained the difference from one left open — and the frozen paper
    would claim a cleaner reconciliation than was signed."""
    once = normalize_item({
        "label": "bank fee", "amount": "-25.00", "origin": ORIGIN_HUMAN,
        "cleared": False, "txn_id": "manual-abc",
    })
    twice = normalize_item(once)
    assert once == twice
    assert twice["cleared"] is False
    assert twice["txn_id"] == "manual-abc"

    # And it survives the full build, which is where it was actually being lost.
    built = _snap(items=[once])["items"][0]
    assert built["cleared"] is False
    assert built["txn_id"] == "manual-abc"

    # A cleared item and an open one must not hash the same.
    assert snapshot_hash(_snap(items=[{**once, "cleared": True}])) != snapshot_hash(_snap(items=[once]))


def test_non_ai_items_carry_no_ai_fields():
    """Confidence on a bank transaction is noise — it implies a judgement that
    was never made."""
    item = normalize_item({"label": "wire", "amount": "10.00", "origin": ORIGIN_SYSTEM})
    assert "ai_confidence" not in item
    assert "accepted_by" not in item


# ── 6. Drift: what moved after sign-off ──────────────────────────────────────

def test_drift_reports_movement_since_approval():
    s = _snap(gl_balance="12500.00", subledger_total="12100.00")
    d = drift(s, live_gl="12900.00", live_subledger="12100.00")
    assert d["drifted"] is True
    assert d["gl_changed_by"] == "400.00"
    assert d["subledger_changed_by"] is None


def test_no_drift_when_nothing_moved():
    s = _snap()
    d = drift(s, live_gl="12500.00", live_subledger="12100.00")
    assert d["drifted"] is False
    assert d["gl_changed_by"] is None


def test_drift_is_silent_when_the_account_is_gone():
    """A deleted / unsynced account has no live figure. That is not zero
    drift and it is not a crash — it's unknown."""
    s = _snap()
    d = drift(s, live_gl=None, live_subledger=None)
    assert d["drifted"] is False
    assert d["gl_changed_by"] is None


# ── The write path classifies provenance from real data ──────────────────────

def test_manual_items_are_human_and_pulled_items_are_system():
    """Nothing writes an `origin` key today, so the router derives it. Manual
    rows are the only ones a person authored; everything else is a QuickBooks
    transaction or a Nordavix schedule line."""
    from modules.recons.router import _item_origin

    assert _item_origin({"txn_id": "manual-abc"}) == ORIGIN_HUMAN
    assert _item_origin({"txn_id": "prepaid-amort-9"}) == ORIGIN_SYSTEM
    assert _item_origin({"txn_id": "lease-pay-3"}) == ORIGIN_SYSTEM
    assert _item_origin({"txn_id": "12345"}) == ORIGIN_SYSTEM
    assert _item_origin({}) == ORIGIN_SYSTEM


def test_ai_prepared_subledger_is_not_reported_as_human_entered():
    """The agentic run stamps `subledger_entered_by` with the user it ran as.
    Checking that field first would attribute the model's figure to a person —
    which is exactly the misattribution this feature exists to prevent."""
    from modules.recons.router import _subledger_origin

    class _Row:
        def __init__(self, ai, entered_by):
            self.ai_commentary = ai
            self.subledger_entered_by = entered_by

    assert _subledger_origin(_Row({"summary": "tied out"}, "u-2")) == ORIGIN_AI
    assert _subledger_origin(_Row(None, "u-2")) == ORIGIN_HUMAN
    assert _subledger_origin(_Row(None, None)) == ORIGIN_SYSTEM


if __name__ == "__main__":
    test_variance_is_derived_not_supplied()
    test_variance_is_none_when_a_side_is_missing()
    test_any_edit_changes_the_hash()
    test_hash_is_stable_across_equivalent_spellings()
    test_hash_ignores_key_insertion_order()
    test_origins_are_preserved()
    test_unknown_origin_degrades_to_human_not_system()
    test_ai_item_records_who_accepted_it()
    test_normalizing_twice_loses_nothing()
    test_non_ai_items_carry_no_ai_fields()
    test_drift_reports_movement_since_approval()
    test_no_drift_when_nothing_moved()
    test_drift_is_silent_when_the_account_is_gone()
    test_manual_items_are_human_and_pulled_items_are_system()
    test_ai_prepared_subledger_is_not_reported_as_human_entered()
    print("RECON_CONCLUSION_OK")
