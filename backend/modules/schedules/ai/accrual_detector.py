"""
Accrual AI helpers — two distinct features:

(a) scan_for_missed_accruals
    Pulls GL transactions hitting expense accounts in the month AFTER
    the viewed period_end (plus the first 15 days of the month after
    THAT, to catch invoices that arrive 2-6 weeks late) and asks
    Claude which ones look like services performed in the viewed
    period_end's month. Each likely-missed accrual becomes a
    MissedAccrualCandidate row for the user to accept / dismiss.

    The "scan window" mirrors what a real CPA does during month-end
    close: 1-2 weeks into next month they look back at incoming
    invoices for anything dated for the prior month's service.

(d) find_unreversed_accruals
    Pure-SQL: returns every active, not-reversed accrual whose
    reverses_on date has passed (or whose accrual_date is in a prior
    period and that has no reverses_on set — implies it should have
    reversed in the natural roll). For each, scans the current period
    GL for a matching payment (same vendor + amount within tolerance)
    so the UI can show "looks like it was paid 04-12 for $5,200 —
    accrual should reverse." Heuristic match — no AI call needed for
    v1 (saves ~$0.02 per page render).
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.qbo_gl import pull_gl_transactions
from models.missed_accrual_candidate import MissedAccrualCandidate
from models.qbo_connection import QboConnection
from models.schedule import ScheduleAccrual

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)


# ── (a) Missed accrual detection ────────────────────────────────────────

# Expense account types we'll consider. Both regular and "other"
# operating expenses since accruals frequently hide in either.
_SCAN_ACCOUNT_TYPES = {"Expense", "Other Expense", "Cost of Goods Sold"}


@dataclass
class _GlTxnContext:
    qbo_account_id: str
    qbo_account_name: str
    txn_id: str | None
    txn_date: date
    amount: Decimal
    memo: str
    vendor: str | None


def _scan_window(period_end: date) -> tuple[date, date]:
    """Compute the [start, end] window of GL dates to scan for
    payments that might be missed accruals from period_end's month.

    Window = (first day after period_end) → (15th of the month after
    that). e.g., period_end=03-31 → scan 04-01 through 05-15. Covers
    the typical "invoice arrives 2-6 weeks late" pattern."""
    scan_start = period_end + timedelta(days=1)
    # First day after period_end is in the next month. Skip ahead one
    # more month and take day 15.
    nxt_year = scan_start.year + (1 if scan_start.month == 12 else 0)
    nxt_month = 1 if scan_start.month == 12 else scan_start.month + 1
    scan_end = date(nxt_year, nxt_month, 15)
    return scan_start, scan_end


async def scan_for_missed_accruals(
    conn: QboConnection,
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    period_end: date,
    materiality_floor: Decimal = Decimal("500.00"),
) -> dict[str, Any]:
    """Scan the period after period_end for payments that look like
    missed accruals. Returns full open list + scan summary."""
    scan_start, scan_end = _scan_window(period_end)

    # ── 1) Pull expense accounts via QBO Account query ────────────
    from modules.recons.service import _qbo_get  # lazy: shared helper

    quoted = ", ".join(f"'{t}'" for t in _SCAN_ACCOUNT_TYPES)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType FROM Account "
        f"WHERE AccountType IN ({quoted}) AND Active = true MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("Missed-accrual scan: account list pull failed")
        return {"scanned_accounts": 0, "scanned_txns": 0, "new_candidates": 0, "open": []}

    accounts = data.get("QueryResponse", {}).get("Account", []) or []
    logger.info("Missed-accrual scan: %d expense accts × %s-%s window",
                len(accounts), scan_start, scan_end)

    # ── 2) Existing-candidate dedup set ────────────────────────────
    existing_ids = set((await db.execute(
        select(MissedAccrualCandidate.gl_txn_id).where(
            MissedAccrualCandidate.tenant_id == tenant_id,
            MissedAccrualCandidate.gl_txn_id.is_not(None),
        )
    )).scalars().all())

    # ── 3) Per-account GL pull, build the candidate-txn list ───────
    candidates_to_classify: list[_GlTxnContext] = []
    scanned_txns_total = 0
    for a in accounts:
        acct_id = str(a.get("Id") or "")
        acct_name = str(a.get("Name") or "")
        try:
            txns = await pull_gl_transactions(conn, db, acct_id, scan_start, scan_end)
        except Exception:
            logger.exception("Missed-accrual scan: GL pull failed for acct=%s", acct_id)
            continue
        scanned_txns_total += len(txns)
        for t in txns:
            amount = abs(t.get("amount") or Decimal("0"))
            if amount < materiality_floor:
                continue
            txn_id = t.get("qbo_txn_id")
            if txn_id and txn_id in existing_ids:
                continue
            candidates_to_classify.append(_GlTxnContext(
                qbo_account_id=acct_id,
                qbo_account_name=acct_name,
                txn_id=str(txn_id) if txn_id else None,
                txn_date=t.get("txn_date") or scan_start,
                amount=amount,
                memo=str(t.get("memo") or "").strip(),
                vendor=(str(t.get("entity_name")).strip() if t.get("entity_name") else None),
            ))

    new_candidates: list[MissedAccrualCandidate] = []
    if candidates_to_classify:
        ai_results = _classify_missed_with_claude(candidates_to_classify, period_end)

        # strict=True is safe — _classify_missed_with_claude pads to length.
        for ctx, ai in zip(candidates_to_classify, ai_results, strict=True):
            if not ai or not ai.get("is_missed_accrual"):
                continue
            row = MissedAccrualCandidate(
                tenant_id=tenant_id,
                period_end=period_end,
                gl_account_id=ctx.qbo_account_id,
                gl_account_name=ctx.qbo_account_name,
                gl_txn_id=ctx.txn_id,
                gl_txn_date=ctx.txn_date,
                gl_amount=ctx.amount,
                gl_memo=ctx.memo[:500] if ctx.memo else None,
                gl_vendor=ctx.vendor[:255] if ctx.vendor else None,
                ai_vendor=(ai.get("vendor") or ctx.vendor or "")[:255] or None,
                ai_service_period_end=_parse_iso(ai.get("service_period_end")) or period_end,
                ai_suggested_amount=_dec(ai.get("suggested_amount")) or ctx.amount,
                ai_confidence=_dec_clamp(ai.get("confidence"), Decimal("0.50")),
                ai_reasoning=(ai.get("reasoning") or "")[:1000] or None,
                ai_target_account_id=None,  # future: map to "Accrued Expenses" by name
                status="open",
            )
            db.add(row)
            new_candidates.append(row)

        if new_candidates:
            await db.commit()
            for c in new_candidates:
                await db.refresh(c)

    # ── 4) Return full open list + summary ─────────────────────────
    open_rows = list((await db.execute(
        select(MissedAccrualCandidate).where(
            MissedAccrualCandidate.tenant_id == tenant_id,
            MissedAccrualCandidate.period_end == period_end,
            MissedAccrualCandidate.status == "open",
        ).order_by(
            MissedAccrualCandidate.ai_confidence.desc(),
            MissedAccrualCandidate.gl_amount.desc(),
        )
    )).scalars().all())

    return {
        "scanned_accounts": len(accounts),
        "scanned_txns":     scanned_txns_total,
        "scan_window":      [scan_start.isoformat(), scan_end.isoformat()],
        "new_candidates":   len(new_candidates),
        "open":             open_rows,
    }


_DETECTOR_SYSTEM = """\
You are a senior accountant reviewing payments made in the weeks
AFTER a month-end. Your job: identify payments that were for services
performed in the prior month and should have been ACCRUED at the
prior month-end (but weren't).

Common missed-accrual patterns:
  - Legal / professional services invoices ("for March services")
  - Utility bills covering the prior month's usage
  - Contractor invoices for work completed in the prior period
  - Rent paid 1st of month for the month JUST CLOSED
  - Audit / tax / consulting fees billed after period-end
  - Insurance premium adjustments for prior period coverage
  - Late-arriving subscription / SaaS overage charges

NOT missed accruals:
  - Payments dated for service in the CURRENT month (no prior-period
    overlap — expense correctly hits current period)
  - Routine recurring charges with no period reference (e.g., bank
    fees, Stripe fees, monthly office cleaning paid in advance)
  - Hardware / one-time goods purchases (capitalized or current-period
    expense, not an accrual)
  - Reimbursements, refunds, credit memos
  - Anything where the memo / description shows the service date is
    AFTER the prior period-end

You must respond with a single JSON object containing one array
"items" whose length and order match the input txns array:

{
  "items": [
    {
      "is_missed_accrual":   <true | false>,
      "vendor":               <"normalized vendor name" or null>,
      "service_period_end":   <"YYYY-MM-DD" — the period-end the work
                              should have been accrued at, or null if
                              not a missed accrual>,
      "suggested_amount":     <number — sometimes less than the paid
                              amount if only part of the bill applies
                              to the prior period (e.g., utility
                              billing 3/15-4/14 → ~50% applies to
                              March). Default to the full paid amount
                              if 100% applies.>,
      "confidence":           <number 0.0 to 1.0>,
      "reasoning":            <one short sentence explaining the call>
    },
    ...
  ]
}

Be conservative: if the memo doesn't clearly reference prior-period
work, mark is_missed_accrual=false with low confidence. Better to
miss one than to flood the user with false positives.
"""


def _classify_missed_with_claude(
    txns: list[_GlTxnContext], target_period_end: date,
) -> list[dict[str, Any]]:
    if not txns:
        return []

    lines = []
    for i, t in enumerate(txns):
        lines.append(
            f"{i}. account=\"{t.qbo_account_name}\" "
            f"paid_date={t.txn_date.isoformat()} "
            f"amount=${t.amount:,.2f} "
            f"vendor=\"{t.vendor or '(none)'}\" "
            f"memo=\"{t.memo or '(empty)'}\""
        )
    user_msg = (
        f"Target period-end: {target_period_end.isoformat()} (we want to know "
        f"which of these payments were for services performed in or before "
        f"that period, i.e., should have been accrued at {target_period_end.isoformat()}).\n\n"
        f"Classify these {len(txns)} GL payments. Return JSON with `items` "
        f"array of length {len(txns)}, same order.\n\n" +
        "\n".join(lines)
    )

    try:
        resp = _client.messages.create(
            model=settings.anthropic_model,
            max_tokens=4000,
            system=_DETECTOR_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception:
        logger.exception("Missed-accrual detector: Claude call failed")
        return [{}] * len(txns)

    text = ""
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            text += getattr(block, "text", "") or ""

    text = re.sub(r"^```(?:json)?\s*|\s*```\s*$", "", text.strip(), flags=re.IGNORECASE | re.MULTILINE)

    try:
        parsed = json.loads(text)
        items = parsed.get("items") if isinstance(parsed, dict) else None
        if not isinstance(items, list):
            return [{}] * len(txns)
        if len(items) < len(txns):
            items = items + [{}] * (len(txns) - len(items))
        elif len(items) > len(txns):
            items = items[: len(txns)]
        return items
    except Exception:
        logger.exception("Missed-accrual detector: JSON parse failed")
        return [{}] * len(txns)


# ── (d) Unreversed-accrual detection ──────────────────────────────────────

async def find_unreversed_accruals(
    conn: QboConnection,
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    period_end: date,
    amount_tolerance_pct: Decimal = Decimal("0.25"),
) -> list[dict[str, Any]]:
    """Find active accruals that should have reversed by period_end
    and try to match each to a current-period GL payment.

    Returns one dict per accrual:
      {
        accrual: { id, vendor, description, amount, accrual_date,
                   reverses_on, qbo_account_id },
        matches: [
          { gl_txn_id, gl_txn_date, gl_amount, gl_memo, gl_vendor,
            match_score, tolerance_pct_off }
        ],
        suggested_action: "auto_reverse" | "reverse_with_trueup" | "manual_review"
      }

    Match heuristic (cheap, no AI):
      - Vendor name: case-insensitive substring overlap (ignoring
        common suffixes like "Inc", "LLC", "Corp")
      - Amount: within amount_tolerance_pct (default 25%) of accrual
      - Date: within current period's calendar month
    """
    p_start = period_end.replace(day=1)
    p_end = period_end

    # Pull active, not-reversed accruals whose roll-forward should
    # have rolled them out by now (reverses_on <= p_end), OR that
    # were booked in a prior month and have no reverses_on date.
    accruals = list((await db.execute(
        select(ScheduleAccrual).where(
            ScheduleAccrual.tenant_id == tenant_id,
            ScheduleAccrual.is_active == True,  # noqa: E712
            ScheduleAccrual.is_reversed == False,  # noqa: E712
        ).order_by(ScheduleAccrual.accrual_date)
    )).scalars().all())

    candidates: list[ScheduleAccrual] = []
    for a in accruals:
        # If reverses_on is set: must be <= period_end
        if a.reverses_on is not None:
            if a.reverses_on <= p_end:
                candidates.append(a)
        else:
            # No reverses_on set — if the accrual is from a prior
            # month (accrual_date < p_start), it almost certainly
            # should have reversed by now. Include it.
            if a.accrual_date < p_start:
                candidates.append(a)

    if not candidates:
        return []

    # For each candidate, look in the current period's GL for a match.
    # Pull GL once per distinct (qbo_account_id) to keep the QBO call
    # count bounded — many accruals can share the same GL liability
    # account.
    by_acct: dict[str, list[ScheduleAccrual]] = {}
    for a in candidates:
        by_acct.setdefault(a.qbo_account_id, []).append(a)

    # Expense-account GL is where the actual payment hits. We pull the
    # current period across all expense accounts and try to match.
    # For efficiency, share a single expense-accounts list pull.
    from modules.recons.service import _qbo_get

    quoted = ", ".join(f"'{t}'" for t in _SCAN_ACCOUNT_TYPES)
    q = (
        f"SELECT Id, Name FROM Account WHERE AccountType IN ({quoted}) "
        f"AND Active = true MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("Unreversed-accrual detection: account list failed")
        # Fall through with empty matches rather than failing the request
        data = {}
    expense_accounts = data.get("QueryResponse", {}).get("Account", []) or []

    # Pull GL for each expense account in the current period (best
    # effort — failures per account just log and skip).
    all_gl: list[dict[str, Any]] = []
    for ea in expense_accounts:
        ea_id = str(ea.get("Id") or "")
        ea_name = str(ea.get("Name") or "")
        try:
            txns = await pull_gl_transactions(conn, db, ea_id, p_start, p_end)
        except Exception:
            continue
        for t in txns:
            t["_acct_name"] = ea_name
            t["_acct_id"] = ea_id
            all_gl.append(t)

    out: list[dict[str, Any]] = []
    for a in candidates:
        matches = _find_matches_for_accrual(a, all_gl, amount_tolerance_pct)
        suggested = _suggested_action(a, matches)
        out.append({
            "accrual": {
                "id":              str(a.id),
                "qbo_account_id":  a.qbo_account_id,
                "vendor":          a.vendor,
                "description":     a.description,
                "amount":          str(a.amount),
                "accrual_date":    a.accrual_date.isoformat(),
                "reverses_on":     a.reverses_on.isoformat() if a.reverses_on else None,
            },
            "matches": matches,
            "suggested_action": suggested,
        })
    return out


def _normalize_vendor(s: str | None) -> str:
    """Lowercase + strip common corp suffixes for loose matching."""
    if not s:
        return ""
    n = s.lower().strip()
    n = re.sub(r"[,.\-]", " ", n)
    n = re.sub(r"\b(inc|llc|llp|ltd|corp|corporation|co|company|the)\b", "", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


def _find_matches_for_accrual(
    accrual: ScheduleAccrual, gl_rows: list[dict[str, Any]],
    tolerance_pct: Decimal,
) -> list[dict[str, Any]]:
    """Score each GL row against the accrual; return top 3 candidate
    matches sorted by score descending."""
    accrual_vendor_norm = _normalize_vendor(accrual.vendor)
    accrual_amt = Decimal(accrual.amount)
    if accrual_amt <= 0:
        return []

    scored: list[tuple[float, dict[str, Any]]] = []
    for row in gl_rows:
        gl_amt = abs(Decimal(row.get("amount") or 0))
        if gl_amt <= 0:
            continue
        # Amount must be within tolerance_pct of accrual to be considered
        pct_off = abs((gl_amt - accrual_amt) / accrual_amt)
        if pct_off > tolerance_pct:
            continue

        gl_vendor_norm = _normalize_vendor(row.get("entity_name"))

        # Score: vendor match worth more than amount precision
        vendor_score = 0.0
        if accrual_vendor_norm and gl_vendor_norm:
            if accrual_vendor_norm == gl_vendor_norm:
                vendor_score = 0.6
            elif (accrual_vendor_norm in gl_vendor_norm) or (gl_vendor_norm in accrual_vendor_norm):
                vendor_score = 0.4
            else:
                # Check token overlap as a softer match
                a_tokens = set(accrual_vendor_norm.split())
                g_tokens = set(gl_vendor_norm.split())
                if a_tokens and g_tokens and len(a_tokens & g_tokens) > 0:
                    vendor_score = 0.2

        # Amount score: 1.0 for exact, 0.0 at tolerance edge
        amount_score = float(Decimal("1.0") - (pct_off / tolerance_pct)) * 0.4

        score = vendor_score + amount_score
        if score <= 0.2:
            continue  # too weak

        scored.append((score, {
            "gl_txn_id":         row.get("qbo_txn_id"),
            "gl_txn_date":       row["txn_date"].isoformat() if isinstance(row.get("txn_date"), date) else str(row.get("txn_date") or ""),
            "gl_amount":         str(gl_amt),
            "gl_memo":           str(row.get("memo") or "")[:500],
            "gl_vendor":         str(row.get("entity_name") or "")[:255],
            "gl_account_name":   row.get("_acct_name"),
            "match_score":       round(score, 2),
            "tolerance_pct_off": str(round(pct_off, 4)),
        }))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [item for _, item in scored[:3]]


def _suggested_action(accrual: ScheduleAccrual, matches: list[dict[str, Any]]) -> str:
    """Heuristic action suggestion for the UI:
      auto_reverse        — strong match, amount within ~5% → safe one-click reverse
      reverse_with_trueup — match found but amount differs → reverse + book delta
      manual_review       — no match or weak match → user has to decide
    """
    if not matches:
        return "manual_review"
    best = matches[0]
    if best["match_score"] < 0.6:
        return "manual_review"
    pct_off = Decimal(best["tolerance_pct_off"])
    if pct_off <= Decimal("0.05"):
        return "auto_reverse"
    return "reverse_with_trueup"


# ── Tiny helpers (shared) ────────────────────────────────────────────────

def _parse_iso(s: Any) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:
        return None


def _dec(s: Any) -> Decimal | None:
    if s is None or s == "":
        return None
    try:
        return Decimal(str(s))
    except Exception:
        return None


def _dec_clamp(value: Any, default: Decimal) -> Decimal:
    if value is None:
        return default
    try:
        d = Decimal(str(value))
    except Exception:
        return default
    if d < 0:
        d = Decimal("0")
    if d > 1:
        d = Decimal("1")
    return d.quantize(Decimal("0.01"))


# Suppress unused-import warning for monthrange — it's part of the
# public symbol set scripts reach for via this module.
_ = monthrange
