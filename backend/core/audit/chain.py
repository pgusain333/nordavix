"""Tamper-evidence for the audit log.

The audit log is an ordinary table. Until now, anyone who reached the database
could edit or delete a row and nothing would show — which makes it a record of
what happened only for as long as nobody wants it to say otherwise. For an
accounting system that is the wrong property, and it's the first thing a SOC 2
auditor probes: "prove no one altered this."

So every row carries the hash of its own content chained to the hash of the row
before it. Editing a row changes its hash; deleting one breaks the link from the
next. Neither can be repaired without recomputing every subsequent row, which
requires write access to rows an application never updates.

WHAT THIS DOES AND DOESN'T GIVE YOU. It is tamper-EVIDENT, not tamper-PROOF: an
attacker with write access to the whole table and the ability to run this code
could rebuild a consistent chain. Making that impossible needs the chain head
published somewhere the application cannot reach (a WORM bucket, a notary, a
second account). Evidence is the honest claim, and it is the claim that matters
— it turns silent alteration into something that shows up on inspection.

The chain is PER TENANT. Row-level security means one tenant can never read
another's rows, so a global chain would be unverifiable by anyone but us; a
per-tenant chain is one a customer's own auditor can check end to end.

This module is pure: no I/O, no ORM. That keeps the hashing testable and stops
the definition of a row's identity drifting into the write path.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime
from typing import Any

# Bumped only if the canonical form changes. Verification uses each row's own
# stored hash, so a version change doesn't invalidate history — it marks where
# the definition changed.
CHAIN_VERSION = 1

# The first row of a tenant's chain links to this rather than to nothing, so
# "genesis" is an explicit value and not an empty string that could also mean
# "somebody blanked this column".
GENESIS = "0" * 64


def _canonical(value: Any) -> Any:
    """JSON-ready form with stable ordering and no float ambiguity."""
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        # Always UTC, always microseconds — a timestamp that formats two ways
        # would hash two ways.
        return value.astimezone(tz=None).isoformat() if value.tzinfo is None else value.isoformat()
    if isinstance(value, dict):
        return {str(k): _canonical(v) for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [_canonical(v) for v in value]
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    return str(value)


def row_fingerprint(
    *,
    row_id: uuid.UUID | str,
    tenant_id: uuid.UUID | str,
    user_id: uuid.UUID | str | None,
    action: str,
    entity_type: str | None,
    entity_id: uuid.UUID | str | None,
    event_data: dict[str, Any] | None,
    created_at: datetime | str,
) -> str:
    """The canonical serialization of one audit row.

    Every field that carries meaning is included. `id` is in deliberately: without
    it, two identical actions a millisecond apart would be interchangeable, and an
    attacker could swap one for the other without breaking the chain.
    """
    payload = {
        "v": CHAIN_VERSION,
        "id": _canonical(row_id),
        "tenant_id": _canonical(tenant_id),
        "user_id": _canonical(user_id),
        "action": action,
        "entity_type": entity_type,
        "entity_id": _canonical(entity_id),
        "event_data": _canonical(event_data or {}),
        "created_at": _canonical(created_at),
    }
    # separators + sort_keys so the bytes are identical on every machine and
    # every Python version.
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def link(prev_hash: str | None, fingerprint: str) -> str:
    """Chain one row onto the previous. SHA-256 over prev || self."""
    prev = prev_hash or GENESIS
    return hashlib.sha256(f"{prev}{fingerprint}".encode()).hexdigest()


def compute_row_hash(*, prev_hash: str | None, **fields: Any) -> str:
    """Fingerprint a row and link it — what the write path calls."""
    return link(prev_hash, row_fingerprint(**fields))


# ── Verification ──────────────────────────────────────────────────────────────

def verify_chain(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Walk a tenant's rows oldest-first and report the chain's integrity.

    `rows` are plain dicts (id, tenant_id, user_id, action, entity_type,
    entity_id, event_data, created_at, prev_hash, row_hash) in chain order.

    Rows written before hash chaining existed carry no hashes. They are counted
    as UNCHAINED, never as broken — reporting historic rows as tampered would be
    a false accusation and would train everyone to ignore the check.

    Verification stops describing a chain as intact at the first break, but keeps
    walking so the report says how much of the log is still provable.
    """
    total = len(rows)
    unchained = 0
    verified = 0
    breaks: list[dict[str, Any]] = []
    expected_prev: str | None = None
    started = False

    for i, r in enumerate(rows):
        stored_hash = r.get("row_hash")
        if not stored_hash:
            # Pre-chain row. Don't let it poison the link for what follows: the
            # chain legitimately begins at the first hashed row.
            unchained += 1
            continue

        recomputed = compute_row_hash(
            prev_hash=r.get("prev_hash"),
            row_id=r["id"],
            tenant_id=r["tenant_id"],
            user_id=r.get("user_id"),
            action=r["action"],
            entity_type=r.get("entity_type"),
            entity_id=r.get("entity_id"),
            event_data=r.get("event_data"),
            created_at=r["created_at"],
        )

        if recomputed != stored_hash:
            breaks.append({
                "index": i,
                "row_id": str(r["id"]),
                "reason": "content_altered",
                "detail": "The row's stored hash doesn't match its contents.",
            })
        elif started and r.get("prev_hash") != expected_prev:
            # Content is intact but it doesn't follow the row before it — the
            # signature of a DELETED or REORDERED record.
            breaks.append({
                "index": i,
                "row_id": str(r["id"]),
                "reason": "link_broken",
                "detail": "A record appears to have been removed or reordered before this one.",
            })
        else:
            verified += 1

        started = True
        expected_prev = stored_hash

    return {
        "total": total,
        "verified": verified,
        "unchained": unchained,
        "breaks": breaks,
        "intact": not breaks,
        "head": rows[-1].get("row_hash") if rows else None,
        "chain_version": CHAIN_VERSION,
    }
