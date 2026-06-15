"""
GL Accuracy — the detection engine (PURE, deterministic, no I/O).

It learns each vendor's account-posting habit from this client's OWN history,
then flags a current-period entry that breaks a strong habit. The accusation is
arithmetic — we keep the counts so the UI shows the literal tally and a human can
audit it. Because errors here damage the firm's reputation, the engine is tuned
for low false positives and every threshold is explicit + unit-tested:

  * MIN_HISTORY      — a vendor needs at least this many prior postings before we
                       will ever flag it (no accusation we can't defend).
  * DOMINANCE        — the dominant account must hold at least this share of the
                       vendor's history to count as a "habit."
  * POSTED_MAX_SHARE — we only flag when the entry's account is RARE for the
                       vendor; if the vendor regularly uses that account too, it's
                       a legitimate split, not a miscode — never flagged.
  * MATERIALITY      — sub-threshold entries are skipped (noise).

Confidence is honest: `high` only for a near-certain habit on a healthy sample;
everything else is `medium`. The function is side-effect-free so the whole
accusation surface is covered by fast unit tests.
"""
from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal, InvalidOperation
from typing import Any

DEFAULTS: dict[str, Any] = {
    "min_history": 4,          # vendor needs >= this many prior postings
    "min_dominant": 3,         # the habit account needs >= this many of them
    "dominance": Decimal("0.70"),       # habit account's share of history
    "posted_max_share": Decimal("0.15"),  # flag only if the entry's account is rare for the vendor
    "high_dominance": Decimal("0.90"),  # high-confidence habit threshold
    "high_min_history": 8,              # ... on at least this many prior postings
    "materiality": Decimal("25"),       # skip entries smaller than this (abs)
}


def _norm_vendor(name: Any) -> str:
    """Lowercased, whitespace-collapsed vendor key. '' for blanks."""
    return " ".join(str(name or "").strip().lower().split())


def _signed(v: Any) -> Decimal:
    """Signed amount (debit-positive), tolerant of strings/None. 0 on garbage."""
    try:
        return Decimal(str(v if v not in (None, "") else 0))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(0)


def build_vendor_distribution(history: Iterable[dict]) -> dict[str, dict]:
    """vendor_norm -> {"accounts": {acct_id: {"count": n, "name": str}}, "total": n}.

    Built only from rows that carry BOTH a vendor and an account id — journal
    entries / transfers with no entity naturally drop out, which is what we want
    (those aren't vendor-driven coding decisions)."""
    dist: dict[str, dict] = {}
    for t in history:
        v = _norm_vendor(t.get("entity_name"))
        acct = str(t.get("qbo_account_id") or "").strip()
        if not v or not acct:
            continue
        d = dist.setdefault(v, {"accounts": {}, "total": 0})
        a = d["accounts"].setdefault(acct, {"count": 0, "name": ""})
        a["count"] += 1
        if not a["name"] and t.get("qbo_account_name"):
            a["name"] = str(t.get("qbo_account_name"))
        d["total"] += 1
    return dist


def detect_misclassifications(
    current_txns: Iterable[dict],
    history: Iterable[dict],
    exceptions: set[tuple[str, str]] | None = None,
    opts: dict[str, Any] | None = None,
) -> list[dict]:
    """Flag current-period entries that break a vendor's confirmed posting habit.

    `current_txns` / `history` rows are the qbo_gl shape:
      {qbo_txn_id, txn_type, txn_number, txn_date, amount(signed), memo,
       entity_name, qbo_account_id, qbo_account_name}
    `history` should be PRIOR periods only (the evidence), `current_txns` the
    period under review. `exceptions` is a set of confirmed (vendor_norm,
    account_id) pairs the reviewer already marked correct — never re-flagged.

    Returns finding dicts sorted high-confidence then largest-dollar. PURE: no
    I/O, no mutation of inputs."""
    o = {**DEFAULTS, **(opts or {})}
    exceptions = exceptions or set()
    dist = build_vendor_distribution(history)
    flags: list[dict] = []

    for t in current_txns:
        v = _norm_vendor(t.get("entity_name"))
        posted = str(t.get("qbo_account_id") or "").strip()
        if not v or not posted:
            continue
        signed = _signed(t.get("amount"))
        amt = abs(signed)
        if amt < o["materiality"]:
            continue

        d = dist.get(v)
        if not d or d["total"] < o["min_history"]:
            continue
        accts = d["accounts"]
        total = d["total"]
        dom_id, dom = max(accts.items(), key=lambda kv: kv[1]["count"])
        dom_count = dom["count"]
        if dom_count < o["min_dominant"]:
            continue
        if Decimal(dom_count) / Decimal(total) < o["dominance"]:
            continue
        if posted == dom_id:
            continue  # already coded to the habit account — nothing to flag

        posted_count = accts.get(posted, {}).get("count", 0)
        if Decimal(posted_count) / Decimal(total) > o["posted_max_share"]:
            continue  # the vendor regularly uses this account too — a split, not a miscode
        if (v, posted) in exceptions:
            continue  # reviewer confirmed this pairing is correct

        dom_share = Decimal(dom_count) / Decimal(total)
        conf = "high" if (dom_share >= o["high_dominance"] and total >= o["high_min_history"]) else "medium"
        flags.append({
            "vendor": (str(t.get("entity_name") or "").strip()),
            "vendor_norm": v,
            "qbo_txn_id": t.get("qbo_txn_id"),
            "txn_type": t.get("txn_type"),
            "txn_number": t.get("txn_number"),
            "txn_date": t.get("txn_date"),
            "amount": str(signed),
            "memo": t.get("memo"),
            "posted_account_id": posted,
            "posted_account_name": str(t.get("qbo_account_name") or accts.get(posted, {}).get("name") or ""),
            "posted_count": posted_count,
            "suggested_account_id": dom_id,
            "suggested_account_name": dom["name"] or "",
            "dominant_count": dom_count,
            "total_count": total,
            "confidence": conf,
        })

    flags.sort(key=lambda f: (0 if f["confidence"] == "high" else 1, -abs(float(f["amount"]))))
    return flags


# ── Detector registry ───────────────────────────────────────────────────────
#
# Risk Radar runs a catalog of PURE, deterministic detectors over the same
# evidence (current-period rows + a trailing-history window + chart-of-accounts
# snapshots) and feeds one findings inbox. Each detector returns finding dicts
# that carry the generalized envelope every finding has:
#
#   kind        — detector id (e.g. "misclassification")
#   severity    — cross-kind triage rank: "high" | "medium" | "low"
#   action_kind — how Accept resolves it: "reclass" | "accrual" | "flag"
#   title       — short human headline
#   detail      — one-line plain-English explanation
#   evidence    — optional structured dict for the per-kind UI
#   dedupe_key  — optional stable key for idempotent re-scan (else the service
#                 falls back to txn id + posted account)
#
# A detector is `(current, history, snapshots, exceptions, opts) -> list[dict]`;
# it ignores the inputs it doesn't need. Adding R2+ detectors = one entry here.

KIND_MISCLASSIFICATION = "misclassification"


def _enrich_misclassification(f: dict) -> dict:
    """Wrap a raw misclassification flag in the generalized Risk-Radar envelope.

    Kept separate from detect_misclassifications so that detector stays a pristine,
    independently-tested pure function."""
    out = {**f}
    conf = f.get("confidence") or "medium"
    posted = f.get("posted_account_name") or f.get("posted_account_id") or "another account"
    suggested = f.get("suggested_account_name") or f.get("suggested_account_id") or "the suggested account"
    out["kind"] = KIND_MISCLASSIFICATION
    out["severity"] = conf  # statistical confidence doubles as triage rank here
    out["action_kind"] = "reclass"
    out["title"] = f"{f.get('vendor') or 'Vendor'}: {posted} → {suggested}"
    out["detail"] = (
        f"{f.get('dominant_count')} of {f.get('total_count')} of this vendor's entries go to "
        f"{suggested}; this one went to {posted}."
    )
    return out


def _detector_misclassification(current, history, snapshots, exceptions, opts) -> list[dict]:
    return [_enrich_misclassification(f)
            for f in detect_misclassifications(current, history, exceptions=exceptions, opts=opts)]


# Ordered list of active detectors. R2+ append here.
DETECTORS: list[dict[str, Any]] = [
    {"key": KIND_MISCLASSIFICATION, "fn": _detector_misclassification},
]


def run_detectors(
    current_txns: Iterable[dict],
    history: Iterable[dict],
    snapshots: Iterable[dict] | None = None,
    exceptions: set[tuple[str, str]] | None = None,
    opts: dict[str, Any] | None = None,
) -> list[dict]:
    """Run every active detector over the shared evidence and return one merged,
    triage-sorted list of findings. PURE: detectors don't do I/O. Materialize the
    iterables once so each detector can re-scan them."""
    cur = list(current_txns)
    hist = list(history)
    snaps = list(snapshots or [])
    out: list[dict] = []
    for d in DETECTORS:
        out.extend(d["fn"](cur, hist, snaps, exceptions, opts))
    sev_rank = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda f: (sev_rank.get(f.get("severity") or "medium", 1),
                            -abs(float(_signed(f.get("amount"))))))
    return out
