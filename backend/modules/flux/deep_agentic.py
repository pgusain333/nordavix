"""
Deeper Agentic Mode for Flux variance analysis.

Distinct from `flux/tasks.py` (which writes the legacy prose
`Narrative.content` field) — this module produces the STRUCTURED
ai_commentary blob the user actually sees in the UI panel:

    {
      "generated_at":    "2026-05-27T17:00:00+00:00",
      "narrative":       "4–6 sentence prose explaining the variance",
      "risk_level":      "low" | "medium" | "high",
      "justified":       "yes" | "no" | "needs_review",
      "key_entities":    [{"name": "...", "type": "customer|vendor|other", "amount": "..."}],
      "recommendations": ["short action 1", "short action 2", ...],
      "confidence":      "high" | "medium" | "low"
    }

Flow per variance:
  1. Pull GL transactions for the change window from QBO (auto-cached
     in variance_transactions, so subsequent runs are free).
  2. Build a rich prompt that includes the transactions + account
     context + anomaly flags.
  3. Single Claude call asking for JSON-only output.
  4. Parse defensively (fallback to a deterministic shape on bad JSON).
  5. Save to Variance.ai_commentary + also write/update the prose
     Narrative.content for back-compat with the legacy text view.

Used by both the bulk Agentic Mode (one call per material variance)
and the new per-variance endpoint POST /variances/{var_id}/agentic/run.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.client import generate_narrative
from models.account import Account
from models.narrative import Narrative
from models.trial_balance import TrialBalance
from models.variance import Variance
from models.variance_transaction import VarianceTransaction

logger = logging.getLogger(__name__)


# ── System prompt ───────────────────────────────────────────────────────────


_SYSTEM_PROMPT = """\
You are a senior controller analyzing a single flux variance for a CPA firm's
month-end close. You have the account context, the dollar change between
periods, and the actual transactions posted during the change window.

Your job is FOUR things:

1. Explain what drove the variance in plain English (4–6 sentences).
   Cite specific customers/vendors and transaction amounts when they
   explain >25% of the change.

2. Rate the RISK of this variance going unexplained or mis-classified:
   - "low":    routine activity, well-understood drivers, no concentration risk
   - "medium": some unusual elements (one-time items, large single transactions,
               new customer/vendor concentration, timing shifts)
   - "high":   sign flip, dormant account reactivated, missing JE suspected,
               concentration above 40% in a single entity, accruals reversal
               missed, or anything else that warrants controller review

3. Decide if the variance is JUSTIFIED by the available evidence:
   - "yes":           transactions clearly explain the change; no follow-up needed
   - "no":            transactions don't add up to the variance OR explain it
                      poorly — investigate
   - "needs_review":  partially explained but missing context (e.g. a large
                      JE with a blank memo, unusual entity concentration that
                      needs business justification)

4. List 1–4 short actionable recommendations for the controller. Examples:
   "Confirm $50k JE-2026-04-15 with CFO before approving"
   "Follow up with Acme Corp on the prepayment timing"
   "Reclassify the marketing spend out of professional services"

You ALSO identify key customers/vendors (up to 5) that materially drove
the change — entities appearing in transactions that sum to >10% of the
absolute variance.

Return ONE JSON object with this exact shape and nothing else:

{
  "narrative":       "4-6 sentences in plain prose, no markdown, no headers",
  "risk_level":      "low" | "medium" | "high",
  "justified":       "yes" | "no" | "needs_review",
  "key_entities":    [
    {"name": "Entity Name", "type": "customer" | "vendor" | "other", "amount": "12345.67"},
    ...
  ],
  "recommendations": ["short action sentence 1", "short action sentence 2", ...],
  "confidence":      "high" | "medium" | "low"
}

Confidence reflects how confident YOU are in the analysis:
  - "high":   transactions fully reconcile the variance + clear entity drivers
  - "medium": transactions explain most of the change but some gaps
  - "low":    sparse transaction data or material unexplained portion

Strict rules:
  - JSON only. No leading prose, no trailing prose, no markdown fences.
  - Never invent numbers — only cite what's in the data.
  - "amount" fields are decimal strings ("12345.67"), not numbers.
  - "narrative" is prose only. No headers, no bullets, no markdown.
  - If you can't identify any key entities, return an empty array.
"""


# ── Helpers ─────────────────────────────────────────────────────────────────


def _money(v: Decimal | float | int | str | None) -> str:
    if v is None: return "$0.00"
    try:
        d = v if isinstance(v, Decimal) else Decimal(str(v))
        return f"${d:,.2f}" if d >= 0 else f"$({abs(d):,.2f})"
    except Exception:
        return str(v)


def _strip_md(text: str) -> str:
    """Belt-and-suspenders cleanup of markdown the model leaks despite
    the prompt rules. Mirrors flux/tasks.py::_strip_markdown."""
    cleaned = text
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*",     r"\1", cleaned)
    cleaned = re.sub(r"^#{1,6}\s+",      "",    cleaned, flags=re.M)
    cleaned = re.sub(r"`([^`]+)`",       r"\1", cleaned)
    cleaned = cleaned.replace("—", "-").replace("–", "-")
    return cleaned.strip()


def _build_user_prompt(
    *,
    acct: Account, tb: TrialBalance, var: Variance,
    txns: list[VarianceTransaction],
) -> str:
    """Concatenate the variance + transaction evidence into one prompt."""
    pct_str = (
        f"{float(var.pct_variance):.1f}%"
        if var.pct_variance else "N/M (prior balance is zero)"
    )

    anomaly_desc = ""
    if var.anomaly_flags:
        flag_labels = {
            "new_account":        "this account had no balance in the prior period and now does",
            "sign_flip":          "the balance has flipped sign from prior period",
            "large_pct_change":   "there is an unusually large percentage change",
            "dormant_reactivated":"this account was previously dormant",
        }
        anomaly_desc = " Anomaly flags: " + "; ".join(
            flag_labels.get(f, f) for f in var.anomaly_flags
        ) + "."

    # Transaction block — sorted by absolute amount desc, top 20.
    # That's enough to give the model concrete drivers without
    # blowing the prompt budget on noise.
    txn_block = ""
    if txns:
        sorted_txns = sorted(txns, key=lambda t: abs(float(t.amount)), reverse=True)[:20]
        running_total = sum(float(t.amount) for t in txns)
        lines: list[str] = []
        for t in sorted_txns:
            date_s = t.txn_date.isoformat() if t.txn_date else "(no date)"
            entity = t.entity_name or "(no entity)"
            memo   = (t.memo or "(no memo)")[:80]
            lines.append(
                f"  {date_s} | {t.txn_type} {t.txn_number or ''} | "
                f"{entity} | {_money(t.amount)} | {memo}"
            )
        txn_block = (
            f"\n\nTransactions in the change window ({len(txns)} total, "
            f"sum {_money(running_total)} — showing top {len(sorted_txns)} by |amount|):\n"
            "  date | type number | entity | amount | memo\n"
            + "\n".join(lines)
        )
    else:
        txn_block = "\n\nNo transaction detail available for the change window."

    return (
        f"Analyze this variance.\n\n"
        f"Account:            {acct.account_number} - {acct.account_name}\n"
        f"Category:           {acct.fs_category or 'Unknown'} / {acct.fs_line or 'Unknown'}\n"
        f"Current period end: {tb.period_current} balance {_money(acct.current_balance)}\n"
        f"Prior period end:   {tb.period_prior} balance {_money(acct.prior_balance)}\n"
        f"Dollar change:      {_money(var.dollar_variance)}\n"
        f"Percent change:     {pct_str}{anomaly_desc}"
        f"{txn_block}"
    )


def _fallback_commentary(
    *, acct: Account, var: Variance, txns: list[VarianceTransaction], err: str,
) -> dict[str, Any]:
    """Deterministic fallback when Claude fails or returns bad JSON.
    Always returns something useful so the UI never sees a blank panel."""
    narrative = (
        f"Variance of {_money(var.dollar_variance)} on {acct.account_name} "
        f"({acct.account_number}). AI analysis unavailable — manual review required. "
        f"{len(txns)} transaction(s) found in the change window."
    )
    risk = "medium" if abs(var.dollar_variance or 0) > 10000 else "low"
    return {
        "generated_at":    datetime.now(UTC).isoformat(),
        "narrative":       narrative,
        "risk_level":      risk,
        "justified":       "needs_review",
        "key_entities":    [],
        "recommendations": [
            "AI analysis failed — review transactions manually before approving.",
            f"Reason: {err[:120]}",
        ],
        "confidence":      "low",
    }


# ── Public entry points ─────────────────────────────────────────────────────


async def ensure_transactions_pulled(
    *,
    db: AsyncSession, tenant_id: uuid.UUID,
    var: Variance, acct: Account, tb: TrialBalance,
    force_refresh: bool = False,
) -> list[VarianceTransaction]:
    """
    Pull QBO transactions for the variance's change window if we haven't
    already. The agentic flow needs this so the prompt has actual drivers
    to cite — without it the model only sees the dollar change.

    Returns the up-to-date transaction list. Commits the DB on a fresh
    pull; cheap no-op when transactions are already cached.
    """
    if not force_refresh:
        existing = list((await db.execute(
            select(VarianceTransaction).where(VarianceTransaction.variance_id == var.id)
        )).scalars().all())
        if existing:
            return existing

    # Need a QBO account ID to pull from. Some legacy TBs were uploaded
    # via Excel and don't have it — in that case skip the pull and the
    # AI runs on header data only.
    if not acct.qbo_account_id:
        logger.info(
            "deep_agentic: variance %s has no qbo_account_id — skipping txn pull",
            var.id,
        )
        return []

    # Change window: day after prior period end → current period end.
    period_start = tb.period_prior + timedelta(days=1) if tb.period_prior else date(2000, 1, 1)
    period_end = tb.period_current

    try:
        from modules.flux.variance_txns import pull_transactions_for_variance
        return await pull_transactions_for_variance(
            db, tenant_id, var.id, acct.qbo_account_id,
            period_start, period_end,
        )
    except Exception as e:
        # Don't crash the whole agentic run if QBO is unreachable.
        # The narrative will just be header-data-only.
        logger.warning("deep_agentic: txn pull failed for variance %s: %s", var.id, e)
        return []


async def run_deep_agentic_for_variance(
    *,
    db: AsyncSession, tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    force_refresh_txns: bool = False,
) -> dict[str, Any]:
    """
    Run the deeper agentic analysis on a single variance.

    Pulls transactions → builds the prompt → calls Claude → parses JSON
    → saves to variance.ai_commentary (+ writes a Narrative row with
    the prose for back-compat). Returns the structured commentary dict
    so the caller (single-row endpoint OR bulk runner) can surface it
    immediately in the API response.

    The caller is responsible for committing — we don't commit here so
    the bulk runner can batch.
    """
    row = (await db.execute(
        select(Variance, Account, TrialBalance)
        .join(Account, Variance.account_id == Account.id)
        .join(TrialBalance, TrialBalance.id == Account.trial_balance_id)
        .where(Variance.id == variance_id)
    )).one_or_none()
    if row is None:
        return _fallback_commentary(
            acct=Account(account_number="?", account_name="(not found)",
                          current_balance=Decimal("0"), prior_balance=Decimal("0"),
                          trial_balance_id=uuid.uuid4()),
            var=Variance(dollar_variance=Decimal("0"), is_material=False),
            txns=[], err="Variance not found",
        )

    var, acct, tb = row
    txns = await ensure_transactions_pulled(
        db=db, tenant_id=tenant_id, var=var, acct=acct, tb=tb,
        force_refresh=force_refresh_txns,
    )

    user_prompt = _build_user_prompt(acct=acct, tb=tb, var=var, txns=txns)
    cache_key = hashlib.sha256(
        f"deep|{var.id}|{len(txns)}|{var.dollar_variance}".encode()
    ).hexdigest()

    try:
        response = generate_narrative(
            system_prompt=_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            cache_key=cache_key,
            max_tokens=1200,
        )
        raw = response.content.strip()
        # Be liberal: find the first { and last }, decode as JSON.
        first, last = raw.find("{"), raw.rfind("}")
        if first == -1 or last == -1:
            raise ValueError("No JSON object in response")
        parsed = json.loads(raw[first:last + 1])
        commentary: dict[str, Any] = {
            "generated_at":    datetime.now(UTC).isoformat(),
            "narrative":       _strip_md(str(parsed.get("narrative") or "")).strip(),
            "risk_level":      str(parsed.get("risk_level") or "medium").lower(),
            "justified":       str(parsed.get("justified") or "needs_review").lower(),
            "key_entities":    _normalize_entities(parsed.get("key_entities")),
            "recommendations": [
                _strip_md(str(r)).strip() for r in (parsed.get("recommendations") or [])
                if str(r).strip()
            ],
            "confidence":      str(parsed.get("confidence") or "medium").lower(),
        }
        # Defensive validation — clamp enums to allowed values.
        if commentary["risk_level"] not in ("low", "medium", "high"):
            commentary["risk_level"] = "medium"
        if commentary["justified"] not in ("yes", "no", "needs_review"):
            commentary["justified"] = "needs_review"
        if commentary["confidence"] not in ("low", "medium", "high"):
            commentary["confidence"] = "medium"
    except Exception as e:
        logger.exception("deep_agentic: claude/parse failed for variance %s", variance_id)
        commentary = _fallback_commentary(acct=acct, var=var, txns=txns, err=str(e))

    # Persist on the Variance row + mirror to Narrative.content for the
    # legacy prose view. Caller commits.
    var.ai_commentary = commentary
    var.status = "generated" if var.status in ("pending", "generating", "flagged") else var.status

    # Update or create Narrative.content so the existing per-row prose
    # surfaces stay populated.
    narr = (await db.execute(
        select(Narrative).where(Narrative.variance_id == variance_id)
    )).scalar_one_or_none()
    if narr is None:
        narr = Narrative(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            variance_id=variance_id,
            content=commentary["narrative"],
            cache_key=cache_key,
            input_tokens=0,    # not tracked through this path
            output_tokens=0,
        )
        db.add(narr)
    else:
        narr.content = commentary["narrative"]
        narr.cache_key = cache_key

    return commentary


def _normalize_entities(raw: Any) -> list[dict[str, Any]]:
    """Defensive parsing of the key_entities list — keep only well-shaped
    entries and clamp the type enum."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw[:8]:   # cap at 8 to keep the panel readable
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        t_raw = str(entry.get("type") or "other").lower().strip()
        t = t_raw if t_raw in ("customer", "vendor", "other") else "other"
        # Normalize amount: accept str, int, float, Decimal
        amt = entry.get("amount")
        amt_str: str
        if amt is None:
            amt_str = ""
        else:
            try:
                amt_str = str(Decimal(str(amt)).quantize(Decimal("0.01")))
            except Exception:
                amt_str = str(amt)[:24]
        out.append({"name": name[:120], "type": t, "amount": amt_str})
    return out
