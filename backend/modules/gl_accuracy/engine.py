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
from datetime import date
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


# ── Detector: missing recurring item (likely missing accrual) ───────────────

KIND_MISSING_RECURRING = "missing_recurring"


def _month_key(v: Any) -> str:
    """'YYYY-MM' from a date or ISO-ish string; '' if unparseable."""
    if isinstance(v, date):
        return f"{v.year:04d}-{v.month:02d}"
    s = str(v or "")
    return s[:7] if len(s) >= 7 else ""


def _median(nums: list[Decimal]) -> Decimal:
    s = sorted(nums)
    n = len(s)
    if n == 0:
        return Decimal(0)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def _as_day(v: Any) -> date | None:
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v or "")[:10])
    except (ValueError, TypeError):
        return None


def _cents(v: Any) -> Decimal:
    return abs(_signed(v)).quantize(Decimal("0.01"))


def _detector_missing_recurring(current, history, snapshots, exceptions, opts) -> list[dict]:
    """Flag a vendor+expense-account billed in most of the recent months but
    ABSENT this period — a likely missing accrual. The estimate is the median of
    its monthly totals (robust to one-off spikes). PURE; ignores classification
    exceptions (those are about *coding*, not whether a charge is expected).

    Defaults (override via opts): present in >= mr_min_months (3) of the last
    mr_window (6) months, estimate >= mr_materiality ($50); high severity when
    present in >= mr_high_months (5) of them.
    """
    o = opts or {}
    window_n = int(o.get("mr_window", 6))
    min_months = int(o.get("mr_min_months", 3))
    high_months = int(o.get("mr_high_months", 5))
    materiality = o.get("mr_materiality", Decimal("50"))

    cur_list = list(current)
    if not cur_list:
        return []  # period not populated yet — don't flag absences prematurely

    # Trailing window anchored at the most recent month present anywhere in
    # history (normally the month before this period).
    months = sorted({_month_key(t.get("txn_date")) for t in history if _month_key(t.get("txn_date"))})
    if not months:
        return []
    window = set(months[-window_n:])

    # (vendor, account) -> {month -> summed signed amount} + display names.
    pairs: dict[tuple[str, str], dict] = {}
    for t in history:
        v = _norm_vendor(t.get("entity_name"))
        acct = str(t.get("qbo_account_id") or "").strip()
        mk = _month_key(t.get("txn_date"))
        if not v or not acct or mk not in window:
            continue
        p = pairs.setdefault((v, acct), {"months": {}, "vendor": "", "acct_name": ""})
        p["months"][mk] = p["months"].get(mk, Decimal(0)) + _signed(t.get("amount"))
        if not p["vendor"] and t.get("entity_name"):
            p["vendor"] = str(t.get("entity_name")).strip()
        if not p["acct_name"] and t.get("qbo_account_name"):
            p["acct_name"] = str(t.get("qbo_account_name"))

    present_now = {(_norm_vendor(t.get("entity_name")), str(t.get("qbo_account_id") or "").strip())
                   for t in cur_list}

    flags: list[dict] = []
    for (v, acct), p in pairs.items():
        months_present = len(p["months"])
        if months_present < min_months or (v, acct) in present_now:
            continue
        est = _median(list(p["months"].values()))
        if est <= 0 or abs(est) < materiality:
            continue  # credits/refunds or immaterial — not an accrual candidate
        conf = "high" if months_present >= high_months else "medium"
        vendor_disp = p["vendor"] or v
        acct_disp = p["acct_name"] or acct
        flags.append({
            "kind": KIND_MISSING_RECURRING, "severity": conf, "confidence": conf,
            "action_kind": "accrual", "dedupe_key": f"{v}:{acct}",
            "title": f"{vendor_disp}: recurring {acct_disp} charge missing",
            "detail": (f"{vendor_disp} hit {acct_disp} in {months_present} of the last {len(window)} "
                       f"months (typically ~{est}); nothing this period — likely a missing accrual."),
            "vendor": vendor_disp, "amount": str(est),
            "suggested_account_id": acct, "suggested_account_name": acct_disp,
            "posted_account_id": None, "posted_account_name": None,
            "dominant_count": months_present, "total_count": len(window), "posted_count": 0,
            "evidence": {"months_present": months_present, "window": len(window),
                         "estimate": str(est), "basis": "median of monthly totals",
                         "account_id": acct, "account_name": acct_disp},
        })
    return flags


# ── Review-flag detectors (look-at-this, no journal entry) ───────────────────

KIND_DUPLICATE = "duplicate"
KIND_LARGE_NO_MEMO = "large_no_memo"
KIND_ROUND_DOLLAR = "round_dollar"


def _detector_duplicates(current, history, snapshots, exceptions, opts) -> list[dict]:
    """Same vendor + same amount appearing 2+ times within a short window this
    period — a possible double payment. Review-only flag (no JE)."""
    o = opts or {}
    min_amt = o.get("dup_materiality", Decimal("50"))
    window_days = int(o.get("dup_window_days", 7))
    high_amt = o.get("dup_high", Decimal("1000"))

    groups: dict[tuple[str, str], list[dict]] = {}
    for t in current:
        v = _norm_vendor(t.get("entity_name"))
        amt = _cents(t.get("amount"))
        if not v or amt < min_amt:
            continue
        groups.setdefault((v, str(amt)), []).append(t)

    flags: list[dict] = []
    for (v, amtstr), txns in groups.items():
        # A genuine duplicate spans 2+ DISTINCT transactions. Multiple GL lines of
        # ONE evenly-split transaction (same qbo_txn_id, equal per-line amounts)
        # must not look like a double payment. Id-less rows each count as distinct.
        ids = [t.get("qbo_txn_id") for t in txns]
        distinct_ids = sorted({i for i in ids if i})
        n = len(distinct_ids) + sum(1 for i in ids if not i)
        if n < 2:
            continue
        days = [d for d in (_as_day(t.get("txn_date")) for t in txns) if d]
        if days and (max(days) - min(days)).days > window_days:
            continue  # same vendor/amount but spread out — likely legitimately recurring
        amt = Decimal(amtstr)
        vendor_disp = next((str(t.get("entity_name")).strip() for t in txns if t.get("entity_name")), v)
        acct = next((str(t.get("qbo_account_id")) for t in txns if t.get("qbo_account_id")), "")
        acct_name = next((str(t.get("qbo_account_name")) for t in txns if t.get("qbo_account_name")), "")
        conf = "high" if amt >= high_amt else "medium"
        flags.append({
            "kind": KIND_DUPLICATE, "severity": conf, "confidence": conf, "action_kind": "flag",
            "dedupe_key": f"{v}:{amtstr}:{min(days).isoformat() if days else ''}",
            "title": f"{vendor_disp}: possible duplicate — {n}x {amtstr}",
            "detail": (f"{n} entries to {vendor_disp} for {amtstr} within {window_days} days "
                       f"— check for a double payment."),
            "vendor": vendor_disp, "amount": amtstr,
            "posted_account_id": acct or None, "posted_account_name": acct_name or None,
            "suggested_account_id": None, "suggested_account_name": None,
            "dominant_count": n, "total_count": n, "posted_count": 0,
            "evidence": {"count": n, "amount": amtstr, "window_days": window_days,
                         "txn_ids": [t.get("qbo_txn_id") for t in txns]},
        })
    return flags


def _detector_large_no_memo(current, history, snapshots, exceptions, opts) -> list[dict]:
    """A material entry with a blank memo/description — a documentation gap to
    close before sign-off. Review-only flag."""
    o = opts or {}
    min_amt = o.get("nomemo_min", Decimal("5000"))
    high_amt = o.get("nomemo_high", Decimal("10000"))
    flags: list[dict] = []
    for t in current:
        if str(t.get("memo") or "").strip():
            continue
        amt = _cents(t.get("amount"))
        if amt < min_amt:
            continue
        vendor_disp = str(t.get("entity_name") or "").strip() or "(no vendor)"
        acct = str(t.get("qbo_account_id") or "")
        acct_name = str(t.get("qbo_account_name") or "")
        txn_id = str(t.get("qbo_txn_id") or "")
        conf = "high" if amt >= high_amt else "medium"
        flags.append({
            "kind": KIND_LARGE_NO_MEMO, "severity": conf, "confidence": conf, "action_kind": "flag",
            "dedupe_key": f"{txn_id}:{acct}:{amt}",
            "title": f"{vendor_disp}: {amt} with no description",
            "detail": (f"A {amt} entry to {acct_name or acct or 'an account'} has no memo or "
                       f"description — add support before close."),
            "vendor": vendor_disp, "amount": str(amt),
            "posted_account_id": acct or None, "posted_account_name": acct_name or None,
            "suggested_account_id": None, "suggested_account_name": None,
            "dominant_count": 0, "total_count": 0, "posted_count": 0,
            "qbo_txn_id": t.get("qbo_txn_id"), "txn_type": t.get("txn_type"),
            "txn_number": t.get("txn_number"), "txn_date": t.get("txn_date"),
            "evidence": {"amount": str(amt), "account_id": acct, "account_name": acct_name},
        })
    return flags


def _detector_round_dollar(current, history, snapshots, exceptions, opts) -> list[dict]:
    """A manual journal entry for a suspiciously round amount (exact multiple of
    $1,000) — often an estimate or plug. Review-only flag."""
    o = opts or {}
    min_amt = o.get("round_min", Decimal("1000"))
    base = o.get("round_base", Decimal("1000"))
    high_base = o.get("round_high_base", Decimal("5000"))
    flags: list[dict] = []
    for t in current:
        if "journal" not in str(t.get("txn_type") or "").lower():
            continue
        amt = _cents(t.get("amount"))
        if amt < min_amt or amt % base != 0:
            continue
        vendor_disp = str(t.get("entity_name") or "").strip() or "Journal entry"
        acct = str(t.get("qbo_account_id") or "")
        acct_name = str(t.get("qbo_account_name") or "")
        txn_id = str(t.get("qbo_txn_id") or "")
        conf = "high" if amt % high_base == 0 else "medium"
        flags.append({
            "kind": KIND_ROUND_DOLLAR, "severity": conf, "confidence": conf, "action_kind": "flag",
            "dedupe_key": f"{txn_id}:{acct}:{amt}",
            "title": f"Round-dollar JE: {amt}",
            "detail": (f"A manual journal entry for exactly {amt} to {acct_name or acct or 'an account'} "
                       f"— round amounts can signal an estimate or plug; confirm it's supported."),
            "vendor": vendor_disp, "amount": str(amt),
            "posted_account_id": acct or None, "posted_account_name": acct_name or None,
            "suggested_account_id": None, "suggested_account_name": None,
            "dominant_count": 0, "total_count": 0, "posted_count": 0,
            "qbo_txn_id": t.get("qbo_txn_id"), "txn_type": t.get("txn_type"),
            "txn_number": t.get("txn_number"), "txn_date": t.get("txn_date"),
            "evidence": {"amount": str(amt), "account_id": acct, "account_name": acct_name},
        })
    return flags


# ── Structural detectors (chart-of-accounts balances, not the txn stream) ────
#
# These read the period's GL balance SNAPSHOTS — one row per account, EVERY
# account type — instead of the expense-side transaction stream. That's how Risk
# Radar reaches the whole chart of accounts (including the balance sheet), not
# just vendor coding on P&L spend. Snapshot rows are the gl_balance_snapshots
# shape: {qbo_account_id, account_name, account_number, account_type, balance}
# with `balance` signed debit-positive (QBO TrialBalance convention).

KIND_SUSPENSE = "suspense_account"
KIND_AMOUNT_OUTLIER = "amount_outlier"
KIND_CONTRA_BALANCE = "contra_balance"


def _money(v: Any) -> str:
    """'$1,234' / '$1,234.56' — abs value, thousands-separated, cents only when
    they aren't zero. For human-readable detail strings."""
    n = abs(_signed(v))
    s = f"{n:,.2f}"
    return "$" + (s[:-3] if s.endswith(".00") else s)


# Catch-all / suspense accounts that should be cleared (recoded) before sign-off.
# (name substring, human reason, base severity when material). The "uncategorized"
# substring covers Uncategorized Expense / Income / Asset in one rule.
_SUSPENSE_PATTERNS: tuple[tuple[str, str, str], ...] = (
    ("uncategorized", "an Uncategorized catch-all", "high"),
    ("uncategorised", "an Uncategorised catch-all", "high"),
    ("ask my accountant", "QuickBooks' “Ask My Accountant” holding account", "high"),
    ("suspense", "a suspense account", "high"),
    ("opening balance equity", "Opening Balance Equity (should clear after setup)", "medium"),
)


def _detector_suspense_accounts(current, history, snapshots, exceptions, opts) -> list[dict]:
    """Flag any catch-all / suspense account carrying a balance — Uncategorized
    Expense/Income/Asset, Ask My Accountant, Opening Balance Equity, a generic
    'suspense'. These quietly accumulate miscoded activity and must be cleared
    before close. Reads balance SNAPSHOTS, so it covers every account type (not
    just expense). Review-only flag — the fix is recoding, not a single JE."""
    o = opts or {}
    min_amt = o.get("suspense_min", Decimal("1"))       # treat sub-$1 as already clear
    high_amt = o.get("suspense_high", Decimal("1000"))  # material → keep the pattern's high sev
    flags: list[dict] = []
    for s in snapshots:
        name = str(s.get("account_name") or "").strip()
        nl = _norm_vendor(name)
        if not nl:
            continue
        bal = _signed(s.get("balance"))
        if abs(bal) < min_amt:
            continue
        match = next(((reason, sev) for sub, reason, sev in _SUSPENSE_PATTERNS if sub in nl), None)
        if not match:
            continue
        reason, base_sev = match
        qid = str(s.get("qbo_account_id") or "")
        sev = base_sev if abs(bal) >= high_amt else "medium"
        flags.append({
            "kind": KIND_SUSPENSE, "severity": sev, "confidence": sev, "action_kind": "flag",
            "dedupe_key": qid or nl,
            "title": f"{name or 'Suspense account'}: {_money(bal)} to clear",
            "detail": (f"{name or 'This account'} is {reason}, and it's carrying {_money(bal)}. "
                       f"Recode its entries to the right accounts before close."),
            "vendor": name or "Suspense account", "amount": str(bal),
            "posted_account_id": qid or None, "posted_account_name": name or None,
            "suggested_account_id": None, "suggested_account_name": None,
            "dominant_count": 0, "total_count": 0, "posted_count": 0,
            "evidence": {"account_id": qid, "account_name": name,
                         "account_type": s.get("account_type"), "balance": str(bal),
                         "reason": reason},
        })
    return flags


def _detector_amount_outlier(current, history, snapshots, exceptions, opts) -> list[dict]:
    """Flag a current-period entry whose amount dwarfs anything this vendor has
    ever posted — a likely fat-finger or unusual charge to confirm. The baseline
    is the vendor's OWN history (median + max of prior amounts); we flag only when
    the entry BOTH exceeds the vendor's historical max AND clears a multiple of
    its median, so naturally variable spend never trips. Review-only flag."""
    o = opts or {}
    min_history = int(o.get("outlier_min_history", 4))
    mult = Decimal(str(o.get("outlier_mult", 4)))            # >= this * median
    high_mult = Decimal(str(o.get("outlier_high_mult", 10)))
    floor = o.get("outlier_floor", Decimal("500"))           # never flag small amounts
    high_floor = o.get("outlier_high_floor", Decimal("5000"))

    # vendor_norm -> prior abs amounts (across accounts; amount is a vendor trait).
    hist_amts: dict[str, list[Decimal]] = {}
    for t in history:
        v = _norm_vendor(t.get("entity_name"))
        if not v:
            continue
        a = abs(_signed(t.get("amount")))
        if a > 0:
            hist_amts.setdefault(v, []).append(a)

    flags: list[dict] = []
    for t in current:
        v = _norm_vendor(t.get("entity_name"))
        if not v:
            continue
        amt = abs(_signed(t.get("amount")))
        if amt < floor:
            continue
        amts = hist_amts.get(v)
        if not amts or len(amts) < min_history:
            continue
        med = _median(amts)
        mx = max(amts)
        if med <= 0 or amt <= mx or amt < med * mult:
            continue  # within the vendor's seen range, or not a big-enough jump
        vendor_disp = str(t.get("entity_name") or "").strip() or v
        acct = str(t.get("qbo_account_id") or "")
        acct_name = str(t.get("qbo_account_name") or "")
        txn_id = str(t.get("qbo_txn_id") or "")
        sev = "high" if (amt >= med * high_mult and amt >= high_floor) else "medium"
        flags.append({
            "kind": KIND_AMOUNT_OUTLIER, "severity": sev, "confidence": sev, "action_kind": "flag",
            "dedupe_key": f"{v}:{txn_id}:{amt}",
            "title": f"{vendor_disp}: unusually large {_money(amt)}",
            "detail": (f"{vendor_disp} usually runs about {_money(med)} (max {_money(mx)} over "
                       f"{len(amts)} prior entries); this one is {_money(amt)}. Confirm it's right."),
            "vendor": vendor_disp, "amount": str(_signed(t.get("amount"))), "memo": t.get("memo"),
            "posted_account_id": acct or None, "posted_account_name": acct_name or None,
            "suggested_account_id": None, "suggested_account_name": None,
            "qbo_txn_id": t.get("qbo_txn_id"), "txn_type": t.get("txn_type"),
            "txn_number": t.get("txn_number"), "txn_date": t.get("txn_date"),
            "dominant_count": 0, "total_count": len(amts), "posted_count": 0,
            "evidence": {"amount": str(amt), "median": str(med), "max": str(mx),
                         "prior_count": len(amts),
                         "multiple_of_median": str((amt / med).quantize(Decimal("0.1")))},
        })
    return flags


# Balance-sheet accounts that legitimately sit on the "wrong" side — never flagged
# by the contra-balance detector (matched as a name substring, normalized).
_CONTRA_OK: tuple[str, ...] = (
    "accumulated depreciation", "accumulated amortization", "accumulated amortisation",
    "allowance", "contra", "uncategorized", "uncategorised", "ask my accountant", "suspense",
)


def _normal_side(account_type: Any) -> str | None:
    """A balance-sheet account's normal balance side ('debit' | 'credit'), or None
    for equity / P&L / unknown types (out of scope for the contra-balance check —
    equity and income/expense sign is too often legitimately either way)."""
    t = str(account_type or "").lower()
    if any(k in t for k in ("liabilit", "payable", "credit card")):
        return "credit"
    if any(k in t for k in ("receivable", "bank", "asset")):
        return "debit"
    return None


def _detector_contra_balance(current, history, snapshots, exceptions, opts) -> list[dict]:
    """Flag an asset or liability account sitting on the WRONG side — A/P with a
    debit balance, a bank/asset account negative, etc. Known contra accounts
    (accumulated depreciation, allowances) are excluded by name; equity and P&L
    are out of scope (their sign is often legitimate). Reads balance SNAPSHOTS.
    Review-only flag."""
    o = opts or {}
    tol = o.get("contra_tol", Decimal("100"))          # ignore tiny wrong-side noise
    high_amt = o.get("contra_high", Decimal("10000"))
    flags: list[dict] = []
    for s in snapshots:
        side = _normal_side(s.get("account_type"))
        if side is None:
            continue
        name = str(s.get("account_name") or "").strip()
        nl = _norm_vendor(name)
        if any(ok in nl for ok in _CONTRA_OK):
            continue
        bal = _signed(s.get("balance"))
        if side == "debit" and bal < -tol:
            wrong = "credit"
        elif side == "credit" and bal > tol:
            wrong = "debit"
        else:
            continue
        qid = str(s.get("qbo_account_id") or "")
        atype = str(s.get("account_type") or "account")
        sev = "high" if abs(bal) >= high_amt else "medium"
        flags.append({
            "kind": KIND_CONTRA_BALANCE, "severity": sev, "confidence": sev, "action_kind": "flag",
            "dedupe_key": qid or nl,
            "title": f"{name or atype}: {_money(bal)} {wrong} balance (unexpected)",
            "detail": (f"{name or 'This account'} is {atype} and normally carries a {side} balance, "
                       f"but it's showing a {_money(bal)} {wrong} balance. Investigate before close."),
            "vendor": name or atype, "amount": str(bal),
            "posted_account_id": qid or None, "posted_account_name": name or None,
            "suggested_account_id": None, "suggested_account_name": None,
            "dominant_count": 0, "total_count": 0, "posted_count": 0,
            "evidence": {"account_id": qid, "account_name": name, "account_type": atype,
                         "balance": str(bal), "normal_side": side, "actual_side": wrong},
        })
    return flags


# Ordered list of active detectors. R4+ append here.
DETECTORS: list[dict[str, Any]] = [
    {"key": KIND_MISCLASSIFICATION, "fn": _detector_misclassification},
    {"key": KIND_MISSING_RECURRING, "fn": _detector_missing_recurring},
    {"key": KIND_DUPLICATE, "fn": _detector_duplicates},
    {"key": KIND_LARGE_NO_MEMO, "fn": _detector_large_no_memo},
    {"key": KIND_ROUND_DOLLAR, "fn": _detector_round_dollar},
    {"key": KIND_SUSPENSE, "fn": _detector_suspense_accounts},
    {"key": KIND_AMOUNT_OUTLIER, "fn": _detector_amount_outlier},
    {"key": KIND_CONTRA_BALANCE, "fn": _detector_contra_balance},
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
