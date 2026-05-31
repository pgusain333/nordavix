"""
Fixed-asset detector — finds expense transactions that should have
been capitalized as fixed assets.

Architecture (Option 1 — mirrors prepaid v2 + accrual v2):
  1) Pull every active expense-typed account from QBO.
  2) ONE GeneralLedger report call covering ALL those accounts for
     the CURRENT PERIOD ONLY (auto-batched at 50 accounts per call
     inside the qbo_gl helper).
  3) Drop txns below the materiality floor (= the cap threshold, since
     by definition you don't capitalize below it) and any already
     represented by an existing FixedAssetCandidate.
  4) Hand the whole surviving list to Claude (chunked at 150 per call)
     and let Claude decide what meets US-GAAP capitalization criteria.
  5) Persist Claude's "should_capitalize=true" picks as
     FixedAssetCandidate rows tagged with asset class + useful life.

SCAN WINDOW is the current month only (first-of-month through
period_end) — not a year. Older mis-capitalized expenses would have
been surfaced on prior scans of those periods.

US-GAAP capitalization rules baked into the Claude prompt:
  Capitalize IF all three:
    1) Tangible asset acquisition (or substantial improvement)
    2) Useful life > 1 year
    3) Cost ≥ company cap threshold (materiality_floor here)

  Typical useful lives (months):
    Computer Hardware       36 (laptops, servers, monitors, networking)
    Office Furniture        84 (desks, chairs, conference tables)
    Machinery & Equipment   60-84
    Vehicles                60
    Leasehold Improvements  84 (conservative; GAAP says shorter of
                              lease term or asset life — Claude picks
                              84 unless memo names a lease term)
    Tools (above threshold) 60
    Perpetual Software      36 (NOT SaaS — annual SaaS is a prepaid)

  Hard NO (stay as expense):
    - SaaS / cloud hosting (operating expense, sometimes prepaid)
    - Routine repairs & maintenance (don't extend useful life)
    - Consumables / supplies (printer ink, paper, pens)
    - Items below the cap threshold (even with long useful life)
    - Training, travel, professional services
    - Inventory / production inputs (COGS, not FA)
    - Operating leases (handled in lease schedule)

  The big confound — capital improvements vs repairs:
    "rebuild" / "overhaul" / "replace major component" → capitalize
    "fix" / "repair" / "service" / "tune-up" / "maintenance" → expense

No keyword/regex pre-filter. Claude is the smart filter and returns
should_capitalize=false for non-capital items, so the wide funnel
can't produce false positives — only token cost grows slightly with
more txns (~$0.10-0.20 per scan, negligible).

No background queue — synchronous within the request. Typical scan
5-15s; UI shows a spinner on the "Scan GL for missed capitalizations"
button.
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
from models.fixed_asset_candidate import FixedAssetCandidate
from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)


# ── Heuristics ──────────────────────────────────────────────────────────
#
# AccountType values we consider. Income-statement accounts only — these
# are where a real capitalizable expenditure would be mis-booked direct
# to expense.
#
# Why not COGS? COGS rows are typically inventory / direct production
# costs, not capitalizable PP&E. Including COGS would just burn tokens
# classifying inventory purchases as "not fixed assets." Excluding
# matches what the prepaid detector does.
_FA_SCAN_ACCOUNT_TYPES = {"Expense", "Other Expense"}

# Default cap threshold. Most small businesses use $1,000 or $2,500
# (IRS de minimis safe harbor goes up to $2,500 without AFS and $5,000
# with AFS). $1,000 keeps the scan inclusive — the user can dial up.
_DEFAULT_CAP_THRESHOLD = Decimal("1000.00")

# Chunking matches the prepaid + accrual detectors.
_AI_CHUNK_SIZE = 150
_AI_MAX_TOKENS = 8000


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

async def scan_for_fixed_asset_candidates(
    conn: QboConnection,
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    period_end: date,
    cap_threshold: Decimal = _DEFAULT_CAP_THRESHOLD,
) -> dict[str, Any]:
    """
    Scan the period's expense GL for likely missed capitalizations,
    persist new candidates, return the full open list + summary counts.

    cap_threshold is BOTH the materiality floor (don't waste AI cycles
    on a $50 stapler) AND the capitalization decision input (Claude
    knows we treat it as the entity's cap threshold).
    """
    # Period bounds — first of the month containing period_end through
    # period_end. We only scan THIS period's txns; older periods would
    # have surfaced last time the user scanned them.
    period_start = period_end.replace(day=1)

    # ── 1) Pull expense accounts via the QBO Account query ──────────
    from modules.recons.service import _qbo_get  # lazy: shared helper

    quoted_types = ", ".join(f"'{t}'" for t in _FA_SCAN_ACCOUNT_TYPES)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType FROM Account "
        f"WHERE AccountType IN ({quoted_types}) AND Active = true MAXRESULTS 500"
    )
    try:
        accounts_data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("FA scan: account list pull failed")
        return {
            "scanned_accounts": 0,
            "scanned_txns":     0,
            "ai_classified":    0,
            "new_candidates":   0,
            "open":             [],
        }

    accounts = accounts_data.get("QueryResponse", {}).get("Account", []) or []
    expense_account_ids = [str(a.get("Id") or "") for a in accounts if a.get("Id")]
    accounts_by_id: dict[str, dict] = {
        str(a.get("Id") or ""): a for a in accounts if a.get("Id")
    }
    logger.info(
        "FA scan: %d active expense accounts in scope (cap threshold $%s)",
        len(expense_account_ids), cap_threshold,
    )

    # ── 2) Existing-candidate dedup set ─────────────────────────────
    existing_rows = list((await db.execute(
        select(FixedAssetCandidate.gl_txn_id).where(
            FixedAssetCandidate.tenant_id == tenant_id,
            FixedAssetCandidate.gl_txn_id.is_not(None),
        )
    )).scalars().all())
    existing_txn_ids = set(existing_rows)

    # ── 3) ONE multi-account GL pull for the current month ──────────
    from core.qbo_gl import pull_gl_transactions_multi

    try:
        all_txns = await pull_gl_transactions_multi(
            conn, db, expense_account_ids, period_start, period_end,
        )
    except Exception:
        logger.exception("FA scan: multi-account GL pull failed")
        all_txns = []

    candidates_to_classify: list[_GlTxnContext] = []
    for t in all_txns:
        amount = abs(t.get("amount") or Decimal("0"))
        # Materiality = cap threshold. Below it the item cannot be
        # capitalized regardless of how asset-like it looks, so we
        # don't spend AI tokens on it.
        if amount < cap_threshold:
            continue
        txn_id = t.get("qbo_txn_id")
        if txn_id and txn_id in existing_txn_ids:
            continue
        acct_id = str(t.get("qbo_account_id") or "")
        acct_name = str(
            t.get("qbo_account_name")
            or (accounts_by_id.get(acct_id, {}).get("Name") or "")
        ).strip()
        candidates_to_classify.append(_GlTxnContext(
            qbo_account_id=acct_id,
            qbo_account_name=acct_name,
            txn_id=str(txn_id) if txn_id else None,
            txn_date=t.get("txn_date") or period_end,
            amount=amount,
            memo=str(t.get("memo") or "").strip(),
            vendor=(str(t.get("entity_name")).strip() if t.get("entity_name") else None),
        ))

    scanned_txns_total = len(all_txns)
    logger.info(
        "FA scan: %d total expense txns in period, %d above cap threshold "
        "and not already seen → queued for AI classification",
        scanned_txns_total, len(candidates_to_classify),
    )

    new_candidates: list[FixedAssetCandidate] = []
    if candidates_to_classify:
        ai_results = _classify_with_claude(candidates_to_classify, cap_threshold)

        # strict=True is safe — _classify_with_claude pads to length.
        for ctx, ai in zip(candidates_to_classify, ai_results, strict=True):
            if not ai or not ai.get("should_capitalize"):
                continue
            row = FixedAssetCandidate(
                tenant_id=tenant_id,
                period_end=period_end,
                gl_account_id=ctx.qbo_account_id,
                gl_account_name=ctx.qbo_account_name,
                gl_txn_id=ctx.txn_id,
                gl_txn_date=ctx.txn_date,
                gl_amount=ctx.amount,
                gl_memo=ctx.memo[:500] if ctx.memo else None,
                gl_vendor=ctx.vendor[:255] if ctx.vendor else None,
                ai_description=(ai.get("description") or ctx.memo or "")[:255] or None,
                ai_vendor=(ai.get("vendor") or ctx.vendor or "")[:255] or None,
                ai_category=(ai.get("category") or "")[:100] or None,
                ai_in_service_date=_parse_iso(ai.get("in_service_date")) or ctx.txn_date,
                ai_cost=_dec(ai.get("cost")) or ctx.amount,
                ai_salvage_value=_dec(ai.get("salvage_value")) or Decimal("0"),
                ai_useful_life_months=ai.get("useful_life_months") if isinstance(ai.get("useful_life_months"), int) else None,
                ai_confidence=_dec_clamp(ai.get("confidence"), Decimal("0.50")),
                ai_reasoning=(ai.get("reasoning") or "")[:1000] or None,
                ai_target_account_id=None,  # v1: user picks the right Asset GL account on accept
                status="open",
            )
            db.add(row)
            new_candidates.append(row)

        if new_candidates:
            await db.commit()
            for c in new_candidates:
                await db.refresh(c)

    # ── 4) Return full open list + summary ──────────────────────────
    open_rows = list((await db.execute(
        select(FixedAssetCandidate).where(
            FixedAssetCandidate.tenant_id == tenant_id,
            FixedAssetCandidate.status == "open",
        ).order_by(FixedAssetCandidate.ai_confidence.desc(), FixedAssetCandidate.gl_amount.desc())
    )).scalars().all())

    return {
        "scanned_accounts":  len(expense_account_ids),
        "scanned_txns":      scanned_txns_total,
        "ai_classified":     len(candidates_to_classify),
        "new_candidates":    len(new_candidates),
        "open":              open_rows,
    }


# ── Claude classification ───────────────────────────────────────────────

_DETECTOR_SYSTEM = """\
You are a senior accountant reviewing journal entries hitting expense
accounts. Your job is to identify which entries should have been
CAPITALIZED AS FIXED ASSETS rather than expensed in full.

US-GAAP / IRS capitalization criteria — capitalize ONLY IF all three:
  1. The expenditure acquires a TANGIBLE asset (or substantially
     improves one) — NOT a service, subscription, or consumable.
  2. Useful life exceeds ONE YEAR (provides economic benefit beyond
     the current period).
  3. Cost meets or exceeds the company's capitalization threshold
     (we'll tell you the threshold per scan; below it, the de minimis
     safe harbor expenses the cost regardless of how asset-like it
     looks).

Asset categories you should use, with TYPICAL useful lives in months:
  - "Computer Hardware"       — laptops, desktops, servers, monitors,
                                 networking gear, phones, tablets → 36 months
  - "Office Furniture"        — desks, chairs, conference tables,
                                 filing cabinets, shelving → 84 months
  - "Machinery & Equipment"   — production / lab / shop equipment,
                                 forklifts, HVAC units → 60 to 84 months
  - "Vehicles"                — cars, trucks, vans, trailers → 60 months
  - "Leasehold Improvements"  — buildouts, fixtures attached to a
                                 leased space → 84 months (conservative;
                                 use shorter if memo cites lease term)
  - "Tools"                   — power tools, hand tools, instruments
                                 above the cap threshold → 60 months
  - "Perpetual Software"      — perpetual / one-time software licenses
                                 (NOT SaaS / annual subscriptions) → 36 months
  - "Other"                   — fits the criteria but doesn't match
                                 the categories above; pick a sensible
                                 life in months

HARD NO — these stay as operating expense, even if memo sounds
asset-y:
  - SaaS subscriptions / cloud hosting (operating expense; if annual
    upfront, that's a PREPAID — different detector handles it)
  - Routine repairs & maintenance (no useful-life extension)
  - Consumables / supplies (paper, ink, pens, cleaning supplies)
  - Training, travel, professional services
  - Sub-threshold items (below cap threshold — never capitalize)
  - Inventory / production inputs (COGS)
  - Operating lease payments (lease module handles these)
  - Loan principal payments

The big confound — capital improvement vs repair:
  Capital improvement (capitalize):
    "rebuild", "overhaul", "replace [major component]",
    "extend useful life", "new [whole thing] installed",
    "added capacity"
  Repair (expense — DO NOT capitalize):
    "fix", "repair", "service", "tune-up", "maintenance",
    "replace [small worn part]", "patch", "clean"

When the vendor name is clearly an equipment / hardware / vehicle
dealer (Dell, Apple, Best Buy, Ford, Caterpillar, Cisco, Office Depot
furniture, IKEA business, U-Haul truck, etc.) the signal is strong.

When the memo is empty AND the account name is vague AND the vendor
is generic ("Bank of America" — could be anything), mark
should_capitalize=false with low confidence rather than guessing.

You must respond with a single JSON object containing one array
"items" whose length and order match the input txns array:

{
  "items": [
    {
      "should_capitalize":   <true | false>,
      "description":         <"clean asset name" or null — e.g.,
                              "Dell XPS 15 laptop — engineering";
                              keep under 100 chars>,
      "vendor":              <"normalized vendor name" or null>,
      "category":            <one of the categories above, or null
                              if should_capitalize=false>,
      "in_service_date":     <"YYYY-MM-DD" — typically the txn date;
                              only override if memo clearly states a
                              different in-service date>,
      "cost":                <number — usually the full GL amount;
                              less only if part of the txn is non-
                              capitalizable (e.g. equipment + a 1-yr
                              service plan bundled)>,
      "salvage_value":       <number, usually 0; >0 only if asset has
                              an obvious secondary market value at
                              end of useful life>,
      "useful_life_months":  <integer per the class life above, or
                              null if should_capitalize=false>,
      "confidence":          <number 0.0 to 1.0>,
      "reasoning":           <one short sentence explaining the call —
                              cite the memo / vendor / account clue
                              that drove the decision>
    },
    ...
  ]
}

Be conservative. When uncertain, mark should_capitalize=false with
low confidence — a missed capitalization is easy for the user to fix
on the next scan after they edit the memo to clarify; a false-positive
capitalization clutters the FA register with non-assets.
"""


def _classify_with_claude(
    txns: list[_GlTxnContext],
    cap_threshold: Decimal,
) -> list[dict[str, Any]]:
    """
    Send the txn list to Claude (chunked at _AI_CHUNK_SIZE) and return
    the merged `items` array. Pads with empty dicts where a chunk
    failed or returned the wrong length — failing closed prevents the
    persistence layer from creating bogus candidates when the AI
    response is malformed.
    """
    if not txns:
        return []
    merged: list[dict[str, Any]] = []
    for start in range(0, len(txns), _AI_CHUNK_SIZE):
        chunk = txns[start : start + _AI_CHUNK_SIZE]
        merged.extend(_classify_chunk_with_claude(chunk, cap_threshold))
    return merged


def _classify_chunk_with_claude(
    txns: list[_GlTxnContext],
    cap_threshold: Decimal,
) -> list[dict[str, Any]]:
    """Single AI call for ≤ _AI_CHUNK_SIZE txns. See _classify_with_claude."""
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
        f"Company cap threshold: ${cap_threshold:,.2f} (anything below this "
        f"is below de minimis and should NOT be capitalized regardless of "
        f"how asset-like it sounds).\n\n"
        f"Classify these {len(txns)} GL journal lines. Return JSON with "
        f"`items` array of length {len(txns)}, same order.\n\n" +
        "\n".join(lines)
    )

    try:
        resp = _client.messages.create(
            model=settings.anthropic_model,
            max_tokens=_AI_MAX_TOKENS,
            system=_DETECTOR_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception:
        logger.exception("FA detector: Claude call failed")
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
            logger.warning("FA detector: response missing 'items' array")
            return [{}] * len(txns)
        if len(items) != len(txns):
            logger.warning(
                "FA detector: items length mismatch (got %d, expected %d) — padding with empties",
                len(items), len(txns),
            )
            if len(items) < len(txns):
                items = items + [{}] * (len(txns) - len(items))
            else:
                items = items[: len(txns)]
        return items
    except Exception:
        logger.exception("FA detector: JSON parse failed (raw text follows): %s", text[:500])
        return [{}] * len(txns)


# ── Tiny helpers ────────────────────────────────────────────────────────

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
