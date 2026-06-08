"""
Bank-to-GL auto-matcher.

For each bank statement line, finds the best-fit GL transaction in the
same period using:
  - Check / document-number exact match (bank_ref ↔ GL doc_num) — the
    strongest signal QBO gives us. When the number AND amount match, the
    pair clears even if the check cleared weeks after it was written.
  - Sign match (deposit ↔ debit, withdrawal ↔ credit)
  - Exact absolute-amount match
  - Date proximity (within ±5 calendar days handles ACH lag, weekend
    posting delays, end-of-month timing)
  - Optional payee/memo word overlap as a tiebreaker

Outputs three buckets:
  cleared:    bank line matched a GL line → no action needed
  bank_only:  bank line with no GL match → user must post a JE in QBO
              (bank fees, interest, NSF, ACH the bookkeeper missed)
  gl_only:    GL line with no bank match → outstanding / in-transit
              (outstanding checks, deposits in transit)

Greedy assignment — once a GL txn is matched to a bank txn, it's
removed from the pool so it can't double-match. Items are scored
descending so the best matches lock first.

No external dependencies, no AI — pure Python. Runs in O(N×M) which
is fine for typical monthly statement sizes (≤500 lines each side).
"""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any

# 5-day window catches: weekend posting delay, ACH 2-day clear, EOM
# timing where a check posts in the next month per the bank's cycle.
_DEFAULT_MAX_DATE_LAG = 5

# Below this score a candidate is rejected even if it's the best match.
# 0.7 = exact amount + ±5 days (no memo bonus) — anything looser would
# require manual confirmation.
_MIN_SCORE = 0.70


def _norm_words(s: str | None) -> set[str]:
    """Lowercase tokens for memo overlap; drops common stop-noise."""
    if not s:
        return set()
    # Keep alphanumeric tokens of length >= 3
    toks = re.findall(r"[a-zA-Z0-9]{3,}", s.lower())
    # Drop ultra-common bank words that match anything
    stop = {"the", "and", "for", "from", "check", "deposit", "withdrawal", "transfer", "payment"}
    return {t for t in toks if t not in stop}


def _norm_ref(s: str | None) -> str | None:
    """Normalize a check / document number for exact comparison: lowercase,
    drop punctuation/spaces, strip a leading 'check'/'chk'/'ck'/'no'/'ref'
    token, and remove leading zeros. Returns None when nothing meaningful
    remains, so blank refs (or a bare '0') never match each other."""
    if not s:
        return None
    t = re.sub(r"[^0-9a-z]", "", s.lower())
    t = re.sub(r"^(check|chk|ck|no|num|ref)", "", t)
    t = t.lstrip("0")
    return t or None


# A check routinely clears weeks after it's cut, so once the document number
# AND amount match we trust the pair far beyond the normal ±5-day window.
_CHECK_MAX_DATE_LAG = 90


def _score(bank_tx: dict, gl_tx: dict, max_lag: int) -> float:
    """Return a match score (0.0 = reject). An exact check-number + amount
    match scores highest (≥1.05) and is trusted across a wide date window;
    otherwise fall back to amount + date-proximity (+ memo) scoring."""
    # Sign + amount gate — fail closed
    bank_amt = Decimal(bank_tx["amount"])
    gl_amt = Decimal(gl_tx.get("amount") or 0)
    if bank_amt == 0 or gl_amt == 0:
        return 0.0
    if (bank_amt > 0) != (gl_amt > 0):
        return 0.0
    if abs(bank_amt) != abs(gl_amt):
        return 0.0

    g_date = gl_tx.get("txn_date")
    g_is_date = isinstance(g_date, date)
    lag = abs((bank_tx["txn_date"] - g_date).days) if g_is_date else None

    # ── Check / document-number match ──────────────────────────────────
    # Amount + sign already match; if the bank reference equals the GL
    # document number this is near-certain — the highest-precision way to
    # clear an outstanding check, even when it cleared long after issue.
    bank_ref = _norm_ref(bank_tx.get("bank_ref"))
    gl_num = _norm_ref(gl_tx.get("txn_number"))
    if bank_ref and gl_num and bank_ref == gl_num:
        if lag is None or lag <= _CHECK_MAX_DATE_LAG:
            # Small bonus when it's also within the normal date window, so a
            # same-period check-match edges out a far-dated one competing for
            # the same GL line.
            return 1.15 + (0.05 if (lag is not None and lag <= max_lag) else 0.0)
        # Number + amount match but cleared >90 days later — still very
        # likely the same item, scored just below the in-window matches.
        return 1.05

    # ── No check-number match → require the date-proximity gate ─────────
    if not g_is_date or lag is None or lag > max_lag:
        return 0.0

    # Score: 1.0 at zero lag, falls linearly to 0.70 at max lag.
    # Floor 0.70 because at-max-lag exact-amount is still a valid match.
    score = 1.0 - (lag / max_lag) * 0.30

    # Memo / payee overlap bonus (up to +0.10)
    bank_words = _norm_words(bank_tx.get("description"))
    gl_words = _norm_words(
        f"{gl_tx.get('memo') or ''} {gl_tx.get('entity_name') or ''} {gl_tx.get('txn_number') or ''}"
    )
    overlap = bank_words & gl_words
    if overlap:
        score += min(0.10, 0.04 * len(overlap))

    return score


def match_bank_to_gl(
    bank_txns: list[dict],
    gl_txns: list[dict],
    max_date_lag_days: int = _DEFAULT_MAX_DATE_LAG,
) -> tuple[list[dict], list[dict], list[dict]]:
    """
    Greedy match. Returns (cleared, bank_only, gl_only).

    cleared entries: { bank: <bank_tx>, gl: <gl_tx>, score: float }
    bank_only / gl_only entries: the raw txn dicts.
    """
    if not bank_txns:
        return [], [], list(gl_txns)
    if not gl_txns:
        return [], list(bank_txns), []

    # Score every (bank, gl) pair above threshold first, then assign greedily
    # by descending score. This avoids a poor early-match locking out a better
    # later-match on the same GL line.
    candidates: list[tuple[float, int, int]] = []  # (score, bank_idx, gl_idx)
    for bi, btx in enumerate(bank_txns):
        for gi, gtx in enumerate(gl_txns):
            s = _score(btx, gtx, max_date_lag_days)
            if s >= _MIN_SCORE:
                candidates.append((s, bi, gi))
    candidates.sort(reverse=True, key=lambda c: c[0])

    cleared_pairs: dict[int, tuple[int, float]] = {}  # bank_idx -> (gl_idx, score)
    used_gl: set[int] = set()
    used_bank: set[int] = set()
    for score, bi, gi in candidates:
        if bi in used_bank or gi in used_gl:
            continue
        cleared_pairs[bi] = (gi, score)
        used_bank.add(bi)
        used_gl.add(gi)

    cleared: list[dict] = []
    for bi, (gi, score) in cleared_pairs.items():
        cleared.append({"bank": bank_txns[bi], "gl": gl_txns[gi], "score": round(score, 2)})

    bank_only = [btx for bi, btx in enumerate(bank_txns) if bi not in used_bank]
    gl_only   = [gtx for gi, gtx in enumerate(gl_txns)   if gi not in used_gl]

    return cleared, bank_only, gl_only


def summarize(
    cleared: list[dict],
    bank_only: list[dict],
    gl_only: list[dict],
) -> dict[str, Any]:
    """
    Compute the recon worksheet totals from the three buckets.

    bank_balance is whatever the user enters (we don't infer it — banks
    show running balance per line but it's safer to require explicit
    entry of the statement's ending balance).
    """
    def _sum(items: list[dict], key: str = "amount") -> Decimal:
        total = Decimal("0")
        for it in items:
            v = it.get(key) or 0
            total += Decimal(v)
        return total

    cleared_total = _sum([c["bank"] for c in cleared])
    bank_only_total = _sum(bank_only)
    gl_only_total = _sum(gl_only)

    return {
        "cleared_count":     len(cleared),
        "bank_only_count":   len(bank_only),
        "gl_only_count":     len(gl_only),
        "cleared_total":     str(cleared_total),
        "bank_only_total":   str(bank_only_total),
        "gl_only_total":     str(gl_only_total),
    }
