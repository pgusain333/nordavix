"""
Prepaid detector — finds potential prepaid items hiding in expense
accounts using QBO GL data + Claude classification.

Flow:
  1) Pull active expense-typed accounts from QBO.
  2) Filter to prepaid-prone accounts by name keyword match
     (Insurance, Rent, Software, Subscription, Membership, License,
     Retainer, Dues, etc.) — keeps the AI call short.
  3) For each candidate account, pull GL transactions in the period.
  4) Drop txns below the materiality floor and any already represented
     by an existing PrepaidCandidate (re-scan idempotency).
  5) Send the surviving txns to Claude with a structured prompt asking
     it to identify which look like prepaid items and propose vendor /
     service period / amortization method / confidence / reasoning.
  6) Persist the AI's "likely prepaid" rows as PrepaidCandidate.

Returns the freshly-persisted candidates plus the total scanned and
the count already-existing so the UI can render "Found 3 new, 5
previously seen" feedback.

No background queue — synchronous within the request. The scan
typically completes in 5-15s depending on # of expense accounts and
txns; the UI shows a spinner on the "Scan GL for prepaids" button.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.qbo_gl import pull_gl_transactions
from models.prepaid_candidate import PrepaidCandidate
from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)


# ── Heuristics ──────────────────────────────────────────────────────────

# Account-name keywords that flag an expense account as worth scanning.
# Conservative — biased toward precision (don't flood the user) over
# recall. Future: per-tenant override in AI Prefs.
_PREPAID_ACCOUNT_KEYWORDS = [
    "insurance", "rent", "lease",
    "software", "saas", "subscription", "subscriptions",
    "membership", "memberships", "dues",
    "license", "licenses", "permit", "permits",
    "retainer", "retainers",
    "maintenance contract", "support contract",
    "warranty", "warranties",
    "prepaid",   # any existing "Prepaid X" naming
]

# AccountType values we consider for prepaid detection. Income-statement
# accounts only — these are where a real prepaid invoice would be
# mistakenly booked direct-to-expense.
_PREPAID_SCAN_ACCOUNT_TYPES = {"Expense", "Other Expense"}


def _looks_like_prepaid_account(name: str) -> bool:
    n = (name or "").lower()
    return any(k in n for k in _PREPAID_ACCOUNT_KEYWORDS)


# ── Data classes ────────────────────────────────────────────────────────

@dataclass
class _GlTxnContext:
    """One GL transaction passed to the AI."""
    qbo_account_id: str
    qbo_account_name: str
    txn_id: str | None
    txn_date: date
    amount: Decimal
    memo: str
    vendor: str | None


# ── Public detector ─────────────────────────────────────────────────────

async def scan_for_prepaid_candidates(
    conn: QboConnection,
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    period_end: date,
    materiality_floor: Decimal = Decimal("500.00"),
    expiring_within_days: int = 60,  # noqa: ARG001  reserved for future "near-expiry" heuristic
) -> dict[str, Any]:
    """
    Scan the period's expense GL for likely prepaid items, persist new
    candidates, return the full open list + summary counts.
    """
    # Period bounds — first of the month containing period_end through
    # period_end. We only scan THIS period's txns; older periods would
    # have surfaced last time the user scanned them.
    period_start = period_end.replace(day=1)

    # ── 1) Pull expense accounts via the QBO Account query ──────────
    from modules.recons.service import _qbo_get  # lazy: shared helper

    quoted_types = ", ".join(f"'{t}'" for t in _PREPAID_SCAN_ACCOUNT_TYPES)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType FROM Account "
        f"WHERE AccountType IN ({quoted_types}) AND Active = true MAXRESULTS 500"
    )
    try:
        accounts_data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("Prepaid scan: account list pull failed")
        return {"scanned_accounts": 0, "scanned_txns": 0, "new_candidates": 0, "open": []}

    accounts = accounts_data.get("QueryResponse", {}).get("Account", []) or []
    scan_accounts = [
        a for a in accounts
        if _looks_like_prepaid_account(a.get("Name", ""))
    ]
    logger.info(
        "Prepaid scan: %d total expense accts, %d match prepaid-prone keywords",
        len(accounts), len(scan_accounts),
    )

    # ── 2) Existing-candidate dedup set ─────────────────────────────
    existing_rows = list((await db.execute(
        select(PrepaidCandidate.gl_txn_id).where(
            PrepaidCandidate.tenant_id == tenant_id,
            PrepaidCandidate.gl_txn_id.is_not(None),
        )
    )).scalars().all())
    existing_txn_ids = set(existing_rows)

    # ── 3) Pull GL txns per account, build the candidate-txn list ──
    candidates_to_classify: list[_GlTxnContext] = []
    scanned_txns_total = 0
    for a in scan_accounts:
        acct_id = str(a.get("Id") or "")
        acct_name = str(a.get("Name") or "")
        try:
            txns = await pull_gl_transactions(conn, db, acct_id, period_start, period_end)
        except Exception:
            logger.exception("Prepaid scan: GL pull failed for account=%s", acct_id)
            continue
        scanned_txns_total += len(txns)
        for t in txns:
            amount = abs(t.get("amount") or Decimal("0"))
            if amount < materiality_floor:
                continue
            txn_id = t.get("qbo_txn_id")
            if txn_id and txn_id in existing_txn_ids:
                continue
            candidates_to_classify.append(_GlTxnContext(
                qbo_account_id=acct_id,
                qbo_account_name=acct_name,
                txn_id=str(txn_id) if txn_id else None,
                txn_date=t.get("txn_date") or period_end,
                amount=amount,
                memo=str(t.get("memo") or "").strip(),
                vendor=(str(t.get("entity_name")).strip() if t.get("entity_name") else None),
            ))

    new_candidates: list[PrepaidCandidate] = []
    if candidates_to_classify:
        # ── 4) Ask Claude which look like prepaids ──────────────────
        ai_results = _classify_with_claude(candidates_to_classify)

        # ── 5) Persist the AI's likely-prepaid picks ────────────────
        # strict=True is safe — _classify_with_claude pads to length.
        for ctx, ai in zip(candidates_to_classify, ai_results, strict=True):
            if not ai or not ai.get("is_prepaid"):
                continue
            row = PrepaidCandidate(
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
                ai_service_start=_parse_iso(ai.get("service_start")) or ctx.txn_date,
                ai_service_months=ai.get("service_months") if isinstance(ai.get("service_months"), int) else None,
                ai_method=ai.get("method") or "straight_line",
                ai_confidence=_dec_clamp(ai.get("confidence"), Decimal("0.50")),
                ai_reasoning=(ai.get("reasoning") or "")[:1000] or None,
                ai_target_account_id=None,  # phase-2.5 enhancement: map to Prepaid X account
                status="open",
            )
            db.add(row)
            new_candidates.append(row)

        if new_candidates:
            await db.commit()
            for c in new_candidates:
                await db.refresh(c)

    # ── 6) Return full open list + summary ──────────────────────────
    open_rows = list((await db.execute(
        select(PrepaidCandidate).where(
            PrepaidCandidate.tenant_id == tenant_id,
            PrepaidCandidate.status == "open",
        ).order_by(PrepaidCandidate.ai_confidence.desc(), PrepaidCandidate.gl_amount.desc())
    )).scalars().all())

    return {
        "scanned_accounts": len(scan_accounts),
        "scanned_txns":     scanned_txns_total,
        "new_candidates":   len(new_candidates),
        "open":             open_rows,
    }


# ── Claude classification ───────────────────────────────────────────────

_DETECTOR_SYSTEM = """\
You are a senior accountant reviewing journal entries hitting expense
accounts. Your job is to identify which entries look like PREPAID
ITEMS — multi-period benefits that should sit on the balance sheet and
amortize, not get expensed in full in the month they were paid.

Common prepaid patterns:
  - Annual or multi-month insurance premiums (D&O, GL, auto, cyber)
  - Annual SaaS / software subscriptions
  - Quarterly or annual maintenance / support contracts
  - Prepaid rent, prepaid licenses, retainers paid upfront
  - Annual memberships / dues

NOT prepaids:
  - Monthly recurring charges (already correctly expensed)
  - One-time consumables (office supplies, single-use items)
  - Pass-through reimbursements
  - Travel + entertainment

You must respond with a single JSON object containing one array
"items" whose length and order match the input txns array:

{
  "items": [
    {
      "is_prepaid":      <true | false>,
      "vendor":          <"normalized vendor name" or null>,
      "service_start":   <"YYYY-MM-DD" or null — when the coverage begins>,
      "service_months":  <integer count of months the benefit covers,
                         or null if not a prepaid>,
      "method":          <"straight_line" | "daily_rate" — how to amortize>,
      "confidence":      <number 0.0 to 1.0 — how sure you are>,
      "reasoning":       <one short sentence explaining the call>
    },
    ...
  ]
}

Use "daily_rate" when service_start is mid-month or the term doesn't
align with calendar months (more precise). Use "straight_line" when
the term is clean monthly chunks (1/N split is fine).

Be conservative: a charge under $500 is rarely a prepaid worth booking.
A charge with no vendor + memo describing usage ("Stripe transaction
fees") is operating expense, not prepaid. When in doubt, mark
is_prepaid=false with low confidence.
"""


def _classify_with_claude(txns: list[_GlTxnContext]) -> list[dict[str, Any]]:
    """
    Send the txn list to Claude and return its `items` array, padded
    with empty dicts if the response is malformed or the array length
    doesn't match (we fail closed — no false positives from bad parsing).
    """
    if not txns:
        return []

    lines = []
    for i, t in enumerate(txns):
        lines.append(
            f"{i}. account=\"{t.qbo_account_name}\" "
            f"date={t.txn_date.isoformat()} "
            f"amount=${t.amount:,.2f} "
            f"vendor=\"{t.vendor or '(none)'}\" "
            f"memo=\"{t.memo or '(empty)'}\""
        )
    user_msg = (
        f"Classify these {len(txns)} GL journal lines. Return JSON with "
        f"`items` array of length {len(txns)}, same order.\n\n" +
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
        logger.exception("Prepaid detector: Claude call failed")
        return [{}] * len(txns)

    # Concat any text blocks (Claude returns content as a list of blocks)
    text = ""
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            text += getattr(block, "text", "") or ""

    # Strip code fences if Claude wraps the JSON despite instructions
    text = re.sub(r"^```(?:json)?\s*|\s*```\s*$", "", text.strip(), flags=re.IGNORECASE | re.MULTILINE)

    try:
        parsed = json.loads(text)
        items = parsed.get("items") if isinstance(parsed, dict) else None
        if not isinstance(items, list):
            logger.warning("Prepaid detector: response missing 'items' array")
            return [{}] * len(txns)
        if len(items) != len(txns):
            logger.warning(
                "Prepaid detector: items length mismatch (got %d, expected %d) — padding with empties",
                len(items), len(txns),
            )
            # Pad/truncate to match expected length
            if len(items) < len(txns):
                items = items + [{}] * (len(txns) - len(items))
            else:
                items = items[: len(txns)]
        return items
    except Exception:
        logger.exception("Prepaid detector: JSON parse failed (raw text follows): %s", text[:500])
        return [{}] * len(txns)


# ── Tiny helpers ────────────────────────────────────────────────────────

def _parse_iso(s: Any) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:
        return None


def _dec_clamp(value: Any, default: Decimal) -> Decimal:
    """Clamp 0.0..1.0 → Decimal('0.00'..'1.00')."""
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
