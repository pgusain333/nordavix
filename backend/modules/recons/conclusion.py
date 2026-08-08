"""Freezing a reconciliation's working paper at sign-off.

Pure: no I/O, no ORM. The shape of a conclusion and the hash over it are
defined once, here, so the write path can't quietly change what "the same
conclusion" means.

The point of the snapshot is that the recon screen is LIVE — balances come from
QuickBooks on every render. Without freezing, an approval is a signature on a
view that no longer exists, and reopening in June shows different numbers than
were signed in March with nothing recording the difference.

Every element carries an ORIGIN so an auditor can tell a computed figure from a
typed one from a model's suggestion:

    system — pulled or derived deterministically
    human  — entered by a named person
    ai     — proposed by a model, with confidence and who accepted it

An AI suggestion nobody confirmed and one a preparer accepted are different
evidentiary objects. Without `accepted_by` they are the same row.
"""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any

ORIGIN_SYSTEM = "system"
ORIGIN_HUMAN = "human"
ORIGIN_AI = "ai"
VALID_ORIGINS = frozenset({ORIGIN_SYSTEM, ORIGIN_HUMAN, ORIGIN_AI})

SNAPSHOT_VERSION = 1


def _num(v: Any) -> str | None:
    """Decimals as fixed-point strings. A float in a hash is a hash that
    changes with the platform's rounding."""
    if v is None:
        return None
    return str(Decimal(str(v)).quantize(Decimal("0.01")))


def normalize_item(raw: dict[str, Any]) -> dict[str, Any]:
    """One reconciling item, with its provenance made explicit.

    An unrecognised origin becomes `human`: the conservative reading is that a
    person put it there, since claiming a figure was system-derived when it
    wasn't would overstate how reproducible the conclusion is.

    IDEMPOTENT — running this over its own output must not lose anything.
    `build_snapshot` normalizes whatever it is handed, so a caller that
    pre-normalizes (as the router does, to attach provenance) would otherwise
    have the extra fields quietly stripped on the second pass. `cleared` in
    particular decides whether an item explained the difference or was left
    open, which is not a detail the frozen paper can afford to drop.
    """
    origin = str(raw.get("origin") or ORIGIN_HUMAN)
    if origin not in VALID_ORIGINS:
        origin = ORIGIN_HUMAN
    out: dict[str, Any] = {
        "label": str(raw.get("label") or raw.get("description") or "").strip(),
        "amount": _num(raw.get("amount")),
        "origin": origin,
        "note": (str(raw["note"]).strip() or None) if raw.get("note") else None,
    }
    if "cleared" in raw:
        out["cleared"] = raw["cleared"] is not False
    if raw.get("txn_id"):
        out["txn_id"] = str(raw["txn_id"])
    if origin == ORIGIN_AI:
        # Only meaningful for a model's contribution, and both halves matter:
        # what it claimed, and whether a human stood behind it.
        out["ai_confidence"] = raw.get("ai_confidence")
        out["accepted_by"] = str(raw["accepted_by"]) if raw.get("accepted_by") else None
    return out


def build_snapshot(
    *,
    qbo_account_id: str,
    period_end: Any,
    gl_balance: Any,
    gl_source: str | None,
    gl_as_of: Any,
    subledger_total: Any,
    subledger_origin: str,
    subledger_evidence_id: Any,
    items: list[dict[str, Any]] | None,
    ai_basis: dict[str, Any] | None,
    approved_by: Any,
    prepared_by: Any,
) -> dict[str, Any]:
    """The canonical conclusion. `variance` is DERIVED here, never passed in —
    a stored total that disagrees with its own arithmetic is the failure this
    exists to prevent."""
    gl = Decimal(str(gl_balance)) if gl_balance is not None else None
    sub = Decimal(str(subledger_total)) if subledger_total is not None else None
    variance = (gl - sub) if (gl is not None and sub is not None) else None

    origin = subledger_origin if subledger_origin in VALID_ORIGINS else ORIGIN_HUMAN
    return {
        "v": SNAPSHOT_VERSION,
        "qbo_account_id": str(qbo_account_id),
        "period_end": str(period_end),
        "gl_balance": _num(gl),
        "gl_source": gl_source,
        "gl_as_of": gl_as_of.isoformat() if hasattr(gl_as_of, "isoformat") else gl_as_of,
        "subledger_total": _num(sub),
        "subledger_origin": origin,
        "subledger_evidence_id": str(subledger_evidence_id) if subledger_evidence_id else None,
        "variance": _num(variance),
        "items": [normalize_item(i) for i in (items or [])],
        "ai_basis": ai_basis or None,
        "approved_by": str(approved_by) if approved_by else None,
        "prepared_by": str(prepared_by) if prepared_by else None,
    }


def snapshot_hash(snapshot: dict[str, Any]) -> str:
    """SHA-256 over the canonical form. Same bytes on every machine."""
    blob = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def drift(snapshot: dict[str, Any], *, live_gl: Any, live_subledger: Any) -> dict[str, Any]:
    """What has moved since this was signed off.

    The reason the snapshot is worth keeping. "Approved 4 March; the bank
    balance has since changed by 2,400" is a question nobody can currently ask,
    because the approved figures are recomputed rather than remembered.
    """
    def _delta(frozen: str | None, live: Any) -> str | None:
        if frozen is None or live is None:
            return None
        d = Decimal(str(live)) - Decimal(frozen)
        return _num(d) if d != 0 else None

    gl_d = _delta(snapshot.get("gl_balance"), live_gl)
    sub_d = _delta(snapshot.get("subledger_total"), live_subledger)
    return {
        "gl_changed_by": gl_d,
        "subledger_changed_by": sub_d,
        "drifted": bool(gl_d or sub_d),
    }
