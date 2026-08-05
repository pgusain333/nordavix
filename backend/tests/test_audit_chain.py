"""Audit-log tamper evidence — pure, deterministic, no DB.

This gates the deploy (`pytest -m invariant`, tagged by filename in
conftest.py). The audit log is the record a SOC 2 auditor tests and the record
a dispute turns on; a hash chain that silently stops detecting tampering is
worse than no chain at all, because everyone believes it.

The invariants:
  1. Hashing is deterministic and order-independent for dict content
  2. ANY change to ANY meaningful field changes the hash
  3. An intact chain verifies
  4. An EDITED row is caught
  5. A DELETED row is caught
  6. A REORDERED pair is caught
  7. Pre-chain rows are reported as unchained, never as broken
  8. Re-hashing an edited row (the sophisticated attack) still breaks the link

pytest isn't installed in every env, so this also runs standalone:
    python tests/test_audit_chain.py
"""
import uuid
from datetime import UTC, datetime, timedelta

from core.audit.chain import (
    GENESIS,
    compute_row_hash,
    row_fingerprint,
    verify_chain,
)

T0 = datetime(2026, 3, 31, 12, 0, 0, tzinfo=UTC)
TENANT = uuid.UUID("11111111-1111-1111-1111-111111111111")
USER = uuid.UUID("22222222-2222-2222-2222-222222222222")


def _row(i: int, action: str = "recon.approve", **over):
    r = {
        "id": uuid.UUID(f"{i:08d}-0000-0000-0000-000000000000"),
        "tenant_id": TENANT,
        "user_id": USER,
        "action": action,
        "entity_type": "reconciliation",
        "entity_id": uuid.UUID(f"{i:08d}-9999-0000-0000-000000000000"),
        "event_data": {"summary": f"event {i}"},
        "created_at": T0 + timedelta(seconds=i),
    }
    r.update(over)
    return r


def _hash(r: dict, prev: str | None) -> str:
    """Hash one row exactly the way the write path does."""
    return compute_row_hash(
        prev_hash=prev,
        row_id=r["id"], tenant_id=r["tenant_id"], user_id=r["user_id"],
        action=r["action"], entity_type=r["entity_type"], entity_id=r["entity_id"],
        event_data=r["event_data"], created_at=r["created_at"],
    )


def _chain(rows: list[dict]) -> list[dict]:
    """Link a list of rows the way the write path does."""
    prev = None
    out = []
    for r in rows:
        h = _hash(r, prev)
        out.append({**r, "prev_hash": prev, "row_hash": h})
        prev = h
    return out


def _fp(r: dict) -> str:
    return row_fingerprint(
        row_id=r["id"], tenant_id=r["tenant_id"], user_id=r["user_id"],
        action=r["action"], entity_type=r["entity_type"], entity_id=r["entity_id"],
        event_data=r["event_data"], created_at=r["created_at"],
    )


# ── 1 & 2. Hashing is deterministic, and sensitive to every field ─────────────

def test_fingerprint_is_deterministic_and_field_sensitive():
    r = _row(1)
    assert _fp(r) == _fp(r)

    # Dict key order must not matter — JSONB round-trips don't preserve it.
    a = _fp({**r, "event_data": {"a": 1, "b": 2}})
    b = _fp({**r, "event_data": {"b": 2, "a": 1}})
    assert a == b

    # Every meaningful field must move the hash. `id` included on purpose:
    # without it two identical actions a millisecond apart would be
    # interchangeable, and one could be swapped for the other undetected.
    base = _fp(r)
    for field, value in (
        ("id", uuid.uuid4()),
        ("tenant_id", uuid.uuid4()),
        ("user_id", uuid.uuid4()),
        ("action", "recon.dismiss"),
        ("entity_type", "variance"),
        ("entity_id", uuid.uuid4()),
        ("event_data", {"summary": "something else"}),
        ("created_at", T0 + timedelta(microseconds=1)),
    ):
        assert _fp({**r, field: value}) != base, field

    # user_id None (system events) is distinct from any real user.
    assert _fp({**r, "user_id": None}) != base


def test_first_row_links_to_genesis_not_to_nothing():
    """An empty prev must be an explicit value, so a blanked column can't be
    mistaken for a legitimate chain start."""
    r = _row(1)
    assert _hash(r, None) == _hash(r, GENESIS)


# ── 3. An intact chain verifies ──────────────────────────────────────────────

def test_intact_chain_verifies():
    rows = _chain([_row(i) for i in range(1, 6)])
    res = verify_chain(rows)
    assert res["intact"] is True
    assert res["verified"] == 5
    assert res["unchained"] == 0
    assert res["breaks"] == []
    assert res["head"] == rows[-1]["row_hash"]


# ── 4. An edited row is caught ───────────────────────────────────────────────

def test_edited_row_is_detected():
    rows = _chain([_row(i) for i in range(1, 6)])
    # Someone rewrites what an action was, leaving the hash alone.
    rows[2]["action"] = "recon.dismiss"

    res = verify_chain(rows)
    assert res["intact"] is False
    assert any(b["reason"] == "content_altered" for b in res["breaks"])
    assert res["breaks"][0]["row_id"] == str(rows[2]["id"])


def test_edited_metadata_is_detected():
    """The subtle one: content the log exists to preserve, quietly reworded."""
    rows = _chain([_row(i) for i in range(1, 4)])
    rows[1]["event_data"] = {"summary": "approved by someone else"}
    assert verify_chain(rows)["intact"] is False


# ── 5 & 6. Deletion and reordering are caught ────────────────────────────────

def test_deleted_row_is_detected():
    rows = _chain([_row(i) for i in range(1, 6)])
    del rows[2]                      # remove an inconvenient record entirely

    res = verify_chain(rows)
    assert res["intact"] is False
    assert any(b["reason"] == "link_broken" for b in res["breaks"])


def test_reordered_rows_are_detected():
    rows = _chain([_row(i) for i in range(1, 6)])
    rows[1], rows[2] = rows[2], rows[1]
    assert verify_chain(rows)["intact"] is False


# ── 7. Pre-chain rows are unchained, NOT broken ──────────────────────────────

def test_rows_written_before_chaining_are_not_reported_as_tampered():
    """Rows predating migration 076 carry no hashes. Calling them tampered
    would be a false accusation, and would teach everyone to ignore the check.

    The chain must legitimately BEGIN at the first hashed row."""
    legacy = [{**_row(i), "prev_hash": None, "row_hash": None} for i in (1, 2)]
    fresh = _chain([_row(i) for i in (3, 4, 5)])

    res = verify_chain([*legacy, *fresh])
    assert res["intact"] is True
    assert res["unchained"] == 2
    assert res["verified"] == 3


# ── 8. The sophisticated attack ──────────────────────────────────────────────

def test_recomputing_an_edited_rows_hash_still_breaks_the_chain():
    """An attacker who knows the scheme edits a row AND recomputes its hash.

    That repairs the row's self-consistency but not its successor's link, so the
    tamper still surfaces. Repairing the whole chain means rewriting every later
    row — which is the property that makes this worth having.
    """
    rows = _chain([_row(i) for i in range(1, 6)])

    rows[2]["action"] = "recon.dismiss"
    rows[2]["row_hash"] = _hash(rows[2], rows[2]["prev_hash"])

    res = verify_chain(rows)
    assert res["intact"] is False, "a re-hashed edit must still break the successor's link"
    assert any(b["reason"] == "link_broken" for b in res["breaks"])


if __name__ == "__main__":
    test_fingerprint_is_deterministic_and_field_sensitive()
    test_first_row_links_to_genesis_not_to_nothing()
    test_intact_chain_verifies()
    test_edited_row_is_detected()
    test_edited_metadata_is_detected()
    test_deleted_row_is_detected()
    test_reordered_rows_are_detected()
    test_rows_written_before_chaining_are_not_reported_as_tampered()
    test_recomputing_an_edited_rows_hash_still_breaks_the_chain()
    print("AUDIT_CHAIN_OK")
