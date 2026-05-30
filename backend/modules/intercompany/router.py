"""
Intercompany API.

Tracks GL accounts that represent transactions with related entities
(parents, subs, sister companies). For consolidated reporting these
balances must be eliminated against the matching account on the
counterparty's books.

Endpoints:
  GET    /intercompany/overview?period_end=YYYY-MM-DD
         List flagged IC accounts with current-period balance + change
  POST   /intercompany/auto-detect
         Scan every QBO balance-sheet account, mark anything matching
         the IC name pattern. Non-destructive: existing rows stay as-is.
  POST   /intercompany/marks
         Add (or update) a manual IC mark.
  DELETE /intercompany/marks/{id}
         Remove a mark.
  GET    /intercompany/account/{qbo_id}/transactions?period_end=YYYY-MM-DD
         GL transactions for an IC account in the closing month.
"""
import logging
import re
import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.db.session import get_db
from models.intercompany_account import IntercompanyAccount
from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ─────────────────────────────────────────────────────────────────

class IcAccountOut(BaseModel):
    id:              str
    qbo_account_id:  str
    account_number:  str
    account_name:    str
    account_type:    str
    counterparty:    str | None
    kind:            str                # 'receivable' | 'payable' | 'unknown'
    auto_detected:   bool
    notes:           str | None
    # Live data from QBO at the requested period_end
    gl_balance:      str
    prior_balance:   str | None         # one month prior, for change calc
    change:          str | None
    created_at:      str
    updated_at:      str


class OverviewResponse(BaseModel):
    qbo_connected:    bool
    period_end:       str
    accounts:         list[IcAccountOut]
    totals:           dict               # receivables, payables, net
    detected_pending: int                # IC-pattern accounts not yet marked


class MarkIn(BaseModel):
    qbo_account_id: str
    counterparty:   str | None = None
    kind:           str = "unknown"      # 'receivable' | 'payable' | 'unknown'
    notes:          str | None = None


# ── Name-pattern auto-detection ──────────────────────────────────────────────

# Case-insensitive substrings — if an account's name contains any of these
# AND its account type is a balance-sheet account, it's likely IC. Tuned to
# catch the common real-world naming conventions (spelled out, abbreviated,
# plural, with/without separators) while avoiding obvious false positives.
#
# Coverage:
#   * Spelled out:   intercompany / inter-company / inter company
#   * Abbreviated:   interco / inter-co / inter co / intco
#   * Due to/from:   "Due to Parent Co", "Due from Sub LLC"
#   * I/C:           i/c, i.c., i.c
#   * IC + noun:     "IC Payable", "IC Receivables" (plural too)
#   * Related party: "Loan from Parent", "Note Receivable - HoldCo",
#                    "Subsidiary Loan", "Affiliate Receivables",
#                    "Investment in Subsidiary", "Holding Co Balance"
#   * Generic:       "Related party"
_IC_PATTERNS = [
    # Spelled out with optional separator (space or hyphen) between "inter"
    # and "company". Matches "Intercompany Payables", "Inter-company Loan",
    # "Inter Company Receivable".
    r"\binter[\s\-]?company\b",
    # Abbreviated form — "interco", "inter-co", "inter co", "intco". Both
    # parts must be word-bounded so we don't fire on "internet co" or
    # "interior".
    r"\binter[\s\-]?co\b",
    r"\bintco\b",
    # Universal IC phrasing — "Due to X", "Due from X". The X is usually
    # the counterparty name (parsed in pass 2).
    r"\bdue\s+(to|from)\b",
    # Slash / dot abbreviations  — "i/c", "i.c.", "i.c"
    r"\bi/c\b",
    r"\bi\.c\.?\b",
    # "IC [payable|receivable|loan|balance|account]" with optional plural
    # — fixes the bug where "IC Payables" wasn't matching "payable\b".
    r"\bic\s+(receivable|payable|loan|balance|account)s?\b",
    # Related-party / affiliate phrasings — most flexible bucket. Catches
    # noun-then-related-entity and related-entity-then-noun, with up to
    # 20 chars of separator (preposition, dash, colon, etc.) between them.
    # Examples it catches:
    #   "Loan from Parent", "Note Receivable - HoldCo",
    #   "Payable to Sister Co", "Investment in Subsidiary"
    #   "Subsidiary Loan", "Affiliate Receivables",
    #   "Parent Payable", "HoldCo Balance"
    r"\b(note|loan|advance|payable|receivable|balance|investment)\b.{0,20}\b(subsidiary|parent|affiliate|sister|holdco|holding|related\s+party)\b",
    r"\b(subsidiary|parent|affiliate|sister|holdco|holding)\b.{0,20}\b(receivable|payable|loan|advance|balance|investment)s?\b",
    # Generic "Related party" catch-all
    r"\brelated\s+part(y|ies)\b",
]
_IC_REGEX = re.compile("|".join(_IC_PATTERNS), re.IGNORECASE)


def _kind_for_account_type(acct_type: str) -> str:
    """Default kind guess from QBO AccountType."""
    if acct_type in ("Accounts Receivable", "Other Current Asset", "Other Asset", "Fixed Asset"):
        return "receivable"
    if acct_type in ("Accounts Payable", "Other Current Liability", "Long Term Liability"):
        return "payable"
    return "unknown"


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/overview", response_model=OverviewResponse)
async def get_overview(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> OverviewResponse:
    """All flagged IC accounts with their live GL balances at period_end."""
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        return OverviewResponse(
            qbo_connected=False,
            period_end=pe.isoformat(),
            accounts=[],
            totals={"receivables": "0.00", "payables": "0.00", "net": "0.00"},
            detected_pending=0,
        )

    # 1. Load every marked IC account for this tenant
    marks = list((await db.execute(select(IntercompanyAccount))).scalars().all())
    mark_by_qbo: dict[str, IntercompanyAccount] = {m.qbo_account_id: m for m in marks}

    # 2. Pull QBO accounts + current and prior trial balances (for change)
    from core.qbo_tb import fetch_trial_balance, lookup_balance, parse_trial_balance
    from modules.recons.overview import _list_balance_sheet_accounts

    accts_raw = await _list_balance_sheet_accounts(conn, db)
    accts_by_id = {str(a.get("Id")): a for a in accts_raw}

    # Trial balances
    try:
        tb_cur_raw = await fetch_trial_balance(conn, pe)
        tb_cur = parse_trial_balance(tb_cur_raw)
    except Exception:
        logger.exception("TB pull failed for IC overview at %s", pe)
        tb_cur = {"by_id": {}, "by_name": {}, "rows": 0}

    # Prior period = last day of prior month
    prior_pe = (pe.replace(day=1) - __import__("datetime").timedelta(days=1))
    try:
        tb_prior_raw = await fetch_trial_balance(conn, prior_pe)
        tb_prior = parse_trial_balance(tb_prior_raw)
    except Exception:
        tb_prior = {"by_id": {}, "by_name": {}, "rows": 0}

    out: list[IcAccountOut] = []
    receivables = Decimal("0")
    payables    = Decimal("0")
    for m in marks:
        a = accts_by_id.get(m.qbo_account_id, {})
        cur_bal = lookup_balance(tb_cur, qbo_id=m.qbo_account_id,
                                  acct_num=str(a.get("AcctNum") or ""), name=str(a.get("Name") or ""))
        prior_bal = lookup_balance(tb_prior, qbo_id=m.qbo_account_id,
                                    acct_num=str(a.get("AcctNum") or ""), name=str(a.get("Name") or ""))
        cur_d   = cur_bal or Decimal("0")
        prior_d = prior_bal if prior_bal is not None else None
        change  = (cur_d - prior_d).quantize(Decimal("0.01")) if prior_d is not None else None

        # Roll-up into totals using kind. Use absolute value: a debit
        # balance on a receivable account is positive, but a "negative"
        # receivable (overdrawn balance) shouldn't reduce the total —
        # better to surface it as its own row anomaly.
        if m.kind == "receivable":
            receivables += abs(cur_d)
        elif m.kind == "payable":
            payables += abs(cur_d)

        out.append(IcAccountOut(
            id=str(m.id),
            qbo_account_id=m.qbo_account_id,
            account_number=str(a.get("AcctNum") or ""),
            account_name=str(a.get("Name") or "(missing in QBO)"),
            account_type=str(a.get("AccountType") or ""),
            counterparty=m.counterparty,
            kind=m.kind,
            auto_detected=m.auto_detected,
            notes=m.notes,
            gl_balance=str(cur_d.quantize(Decimal("0.01"))),
            prior_balance=str(prior_d.quantize(Decimal("0.01"))) if prior_d is not None else None,
            change=str(change) if change is not None else None,
            created_at=m.created_at.isoformat(),
            updated_at=m.updated_at.isoformat(),
        ))

    # 3. Count IC-pattern accounts that AREN'T yet marked — for the
    # "Auto-detect found N candidates" CTA on an empty/partial dashboard.
    detected_pending = 0
    for acct in accts_raw:
        qid = str(acct.get("Id") or "")
        if not qid or qid in mark_by_qbo:
            continue
        if _IC_REGEX.search(str(acct.get("Name") or "")):
            detected_pending += 1

    net = (receivables - payables).quantize(Decimal("0.01"))
    return OverviewResponse(
        qbo_connected=True,
        period_end=pe.isoformat(),
        accounts=out,
        totals={
            "receivables": str(receivables.quantize(Decimal("0.01"))),
            "payables":    str(payables.quantize(Decimal("0.01"))),
            "net":         str(net),
        },
        detected_pending=detected_pending,
    )


@router.post("/auto-detect")
async def auto_detect(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    classify: bool = True,
) -> dict:
    """
    Two-pass scan that does most of the IC setup work automatically:
      1. Name-pattern detection — flag accounts whose names look like
         IC (Due to/from, Intercompany, etc.).
      2. (when classify=true) Auto-fill counterparty from the modal
         entity name across the last 6 months of transactions per
         newly-detected account. Skips accounts whose transactions
         span multiple entities (under 50% modal).
      3. Counterparty inference also tries to read it from the
         account NAME itself when the txn pull yields nothing —
         e.g. "Due from Acme Sub LLC" → counterparty="Acme Sub LLC".

    Run on every QBO sync (cheap — names rarely change) or
    on-demand via the Intercompany page.
    """
    from collections import Counter
    from datetime import date as _date
    from datetime import timedelta as _td

    from core.qbo_gl import pull_gl_transactions
    from modules.recons.overview import _list_balance_sheet_accounts

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    accts = await _list_balance_sheet_accounts(conn, db)
    existing = list((await db.execute(select(IntercompanyAccount))).scalars().all())
    existing_ids = {m.qbo_account_id for m in existing}

    today = _date.today()
    period_start = (today - _td(days=6 * 31)).replace(day=1)

    added = 0
    classified = 0
    # Diagnostic counters — surfaced in the response so the user can see
    # what the scanner did. Critical for debugging "why didn't it find my
    # account?" — if scanned=0 the QBO query failed; if scanned>0 and
    # matched=0 the naming doesn't fit any pattern.
    scanned = len(accts)
    already_marked = 0
    matched_total = 0
    skipped_examples: list[str] = []
    new_marks: list[IntercompanyAccount] = []
    for a in accts:
        qid = str(a.get("Id") or "")
        name = str(a.get("Name") or "")
        if not qid:
            continue
        if qid in existing_ids:
            already_marked += 1
            continue
        if not _IC_REGEX.search(name):
            # Keep up to 10 non-matching names for diagnostic purposes
            if len(skipped_examples) < 10:
                skipped_examples.append(name)
            continue
        matched_total += 1

        # Heuristic counterparty from the account name: strip the
        # "Due to / Due from / Intercompany — " prefix and take the rest.
        cp_from_name: str | None = None
        cleaned = re.sub(
            r"^(intercompany|inter-?company|due\s+to|due\s+from|i\.?c\.?|loan\s+(?:to|from))[\s\-:]*",
            "", name, flags=re.IGNORECASE,
        ).strip(" -—:")
        if cleaned and len(cleaned) >= 2 and cleaned.lower() != name.lower():
            cp_from_name = cleaned

        row = IntercompanyAccount(
            qbo_account_id=qid,
            counterparty=cp_from_name,
            kind=_kind_for_account_type(str(a.get("AccountType") or "")),
            auto_detected=True,
            created_by=user.id,
        )
        db.add(row)
        new_marks.append(row)
        added += 1
        if cp_from_name:
            classified += 1

    # Flush so new rows have IDs before we query against them
    await db.flush()

    # Pass 2 — transaction-derived counterparty for any new marks that
    # didn't get one from the name heuristic.
    if classify:
        for m in new_marks:
            if m.counterparty:
                continue
            try:
                rows = await pull_gl_transactions(conn, db, m.qbo_account_id, period_start, today)
            except Exception:
                continue
            names = [(r["entity_name"] or "").strip() for r in rows]
            names = [n for n in names if n]
            if not names:
                continue
            top = Counter(names).most_common(1)[0]
            if top[1] / len(rows) >= 0.5:
                m.counterparty = top[0]
                classified += 1

    await db.commit()
    return {
        "added":          added,
        "classified":     classified,
        "scanned":        scanned,
        "matched":        matched_total,
        "already_marked": already_marked,
        # First few unmatched names — gives the user a hint about whether
        # the scanner ran successfully but their naming convention isn't
        # in the pattern list yet.
        "skipped_sample": skipped_examples[:5],
    }


@router.post("/marks")
async def upsert_mark(
    body: MarkIn,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    if body.kind not in ("receivable", "payable", "unknown"):
        raise HTTPException(400, "kind must be receivable / payable / unknown")

    existing = (await db.execute(
        select(IntercompanyAccount).where(IntercompanyAccount.qbo_account_id == body.qbo_account_id)
    )).scalar_one_or_none()
    if existing is None:
        existing = IntercompanyAccount(
            qbo_account_id=body.qbo_account_id,
            counterparty=body.counterparty,
            kind=body.kind,
            auto_detected=False,
            notes=body.notes,
            created_by=user.id,
        )
        db.add(existing)
    else:
        existing.counterparty = body.counterparty
        existing.kind = body.kind
        existing.notes = body.notes
        # Once a user touches the row, it's no longer purely auto-detected.
        existing.auto_detected = False
    await db.commit()
    await db.refresh(existing)
    return {"id": str(existing.id), "ok": True}


@router.delete("/marks/{mark_id}", dependencies=[Depends(require_role("reviewer"))])
async def delete_mark(
    mark_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    row = (await db.execute(
        select(IntercompanyAccount).where(IntercompanyAccount.id == mark_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Mark not found.")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("/ai-detect")
async def ai_detect(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    AI-powered IC detection — pass the whole chart of accounts to Claude
    and let it identify intercompany accounts that the regex auto-detect
    missed. Useful for non-standard naming ("Loan – HoldCo", "Owner
    Investment – Sub", "Mgmt Fee Receivable - Parent", etc).

    Marks any account with AI confidence ≥ 0.6, auto_detected=True, and
    writes the AI's reasoning into the notes field. Existing marks
    aren't touched. Returns summary so the UI can render results.
    """
    import json as _json

    import anthropic as _anthropic

    from core.config import settings as _settings
    from modules.recons.overview import _list_balance_sheet_accounts

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    accts = await _list_balance_sheet_accounts(conn, db)
    existing = list((await db.execute(select(IntercompanyAccount))).scalars().all())
    existing_ids = {m.qbo_account_id for m in existing}

    # Only send accounts that aren't already marked — saves tokens and
    # avoids reclassifying. If the user wants to re-evaluate an existing
    # mark they can delete it first.
    scan_pool = [
        {
            "id":   str(a.get("Id") or ""),
            "name": str(a.get("Name") or ""),
            "type": str(a.get("AccountType") or ""),
            "num":  str(a.get("AcctNum") or ""),
        }
        for a in accts
        if str(a.get("Id") or "") and str(a.get("Id") or "") not in existing_ids
    ]

    if not scan_pool:
        return {
            "added":           0,
            "scanned":         len(accts),
            "ai_candidates":   0,
            "already_marked":  len(existing),
            "skipped_lowconf": 0,
        }

    # ── Build the prompt ──────────────────────────────────────────────
    system_prompt = """\
You are a senior accountant reviewing a company's Chart of Accounts.

Your job: identify GL accounts that record INTERCOMPANY (related party)
transactions — balances with a parent, subsidiary, sister entity,
affiliate, or owner-controlled related party. These accounts are
typically eliminated on consolidation.

Common signals:
  * Names containing: Intercompany, Inter-co, I/C, IC, Due to/from,
    Affiliate, Subsidiary, Parent, HoldCo, Holding, Sister Co,
    Related party
  * "Investment in [SubName]", "Note Receivable – [EntityName]",
    "Loan to/from [EntityName]" where the entity is a related party
  * Owner / member loan / advance accounts in closely held entities
  * "Management Fee Receivable/Payable" where it's an inter-entity flow
  * Account names containing what looks like another LLC / Inc name
    when paired with words like Loan, Payable, Receivable, Investment

NOT intercompany:
  * Customer A/R, Trade A/P (unless name explicitly says related party)
  * Bank, Credit Card, Fixed Assets (unless name signals IC)
  * Operating Expense / Income / standard equity accounts
  * Generic accruals, prepaids without an entity name

You will respond with a single JSON object:
{
  "matches": [
    {
      "id":            "<account id from input>",
      "confidence":    <0.0 to 1.0 — how sure>,
      "kind":          "<receivable | payable | unknown>",
      "counterparty":  "<entity name extracted from account name, or null>",
      "reason":        "<one short sentence>"
    }
  ]
}

Be conservative. Confidence ≥ 0.6 means you would flag this account in
a real audit prep. Confidence < 0.6 means it's a maybe — leave it out.
Empty list is acceptable.
"""

    lines = []
    for i, a in enumerate(scan_pool):
        lines.append(
            f'{i}. id="{a["id"]}" num="{a["num"]}" name="{a["name"]}" type="{a["type"]}"'
        )
    user_msg = (
        f"Review these {len(scan_pool)} accounts and return your "
        f"JSON matches array.\n\n" + "\n".join(lines)
    )

    client = _anthropic.Anthropic(api_key=_settings.anthropic_api_key)
    try:
        resp = client.messages.create(
            model=_settings.anthropic_model,
            max_tokens=4000,
            system=system_prompt,
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception:
        logger.exception("IC ai-detect: Claude call failed")
        raise HTTPException(502, "AI scan failed. Try again in a moment.")

    text = "".join(
        getattr(b, "text", "") for b in resp.content
        if getattr(b, "type", None) == "text"
    )
    text = re.sub(r"^```(?:json)?\s*|\s*```\s*$", "", text.strip(),
                  flags=re.IGNORECASE | re.MULTILINE)

    try:
        parsed = _json.loads(text)
        matches = parsed.get("matches") if isinstance(parsed, dict) else None
        if not isinstance(matches, list):
            matches = []
    except Exception:
        logger.exception("IC ai-detect: JSON parse failed (text head): %s", text[:300])
        matches = []

    # Build a quick lookup from id back to its source account so we can
    # set kind defaults and look up the name for notes.
    pool_by_id = {a["id"]: a for a in scan_pool}

    added = 0
    skipped_lowconf = 0
    for m in matches:
        if not isinstance(m, dict):
            continue
        qid = str(m.get("id") or "")
        if not qid or qid not in pool_by_id or qid in existing_ids:
            continue
        try:
            conf = float(m.get("confidence") or 0)
        except Exception:
            conf = 0.0
        if conf < 0.6:
            skipped_lowconf += 1
            continue

        kind = str(m.get("kind") or "").lower()
        if kind not in ("receivable", "payable", "unknown"):
            kind = _kind_for_account_type(pool_by_id[qid]["type"])

        cp = str(m.get("counterparty") or "").strip() or None
        reason = str(m.get("reason") or "").strip()
        notes = f"AI-detected (conf {conf:.0%}): {reason}" if reason else None

        db.add(IntercompanyAccount(
            qbo_account_id=qid,
            counterparty=cp,
            kind=kind,
            auto_detected=True,
            notes=notes,
            created_by=user.id,
        ))
        existing_ids.add(qid)
        added += 1

    await db.commit()
    return {
        "added":           added,
        "scanned":         len(accts),
        "ai_candidates":   len(matches),
        "already_marked":  len(existing),
        "skipped_lowconf": skipped_lowconf,
    }


@router.post("/auto-classify")
async def auto_classify(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
    lookback_months: int = 6,
) -> dict:
    """
    For every marked IC account that doesn't already have a
    counterparty filled in, scan recent transactions and use the
    most-common `entity_name` as the counterparty. This dramatically
    reduces the amount of manual classification work — most IC
    accounts only ever transact with ONE related entity, so
    transaction-name → counterparty is reliable.

    Idempotent: only fills empty counterparty fields. Doesn't overwrite
    user-entered values.
    """
    from collections import Counter
    from datetime import date as _date
    from datetime import timedelta as _td

    from core.qbo_gl import pull_gl_transactions

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    today = _date.today()
    period_start = (today - _td(days=lookback_months * 31)).replace(day=1)

    marks = list((await db.execute(
        select(IntercompanyAccount).where(IntercompanyAccount.counterparty.is_(None))
    )).scalars().all())

    classified = 0
    for m in marks:
        try:
            rows = await pull_gl_transactions(conn, db, m.qbo_account_id, period_start, today)
        except Exception:
            logger.exception("auto-classify: GL pull failed for %s", m.qbo_account_id)
            continue
        if not rows:
            continue
        # Tally entity_name occurrences; pick the modal value if it
        # accounts for >= 50% of transactions (otherwise the account
        # transacts with multiple parties and we leave it blank for
        # the user to decide).
        names = [(r["entity_name"] or "").strip() for r in rows]
        names = [n for n in names if n]
        if not names:
            continue
        c = Counter(names).most_common(1)[0]
        winner, votes = c[0], c[1]
        if votes / len(rows) >= 0.5:
            m.counterparty = winner
            classified += 1
    await db.commit()
    return {"classified": classified, "considered": len(marks)}


@router.get("/account/{qbo_account_id}/transactions")
async def get_account_transactions(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Transactions posted to this IC account in the closing month."""
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    from core.qbo_gl import pull_gl_transactions
    period_start = pe.replace(day=1)
    rows = await pull_gl_transactions(conn, db, qbo_account_id, period_start, pe)

    out = []
    total = Decimal("0")
    for r in rows:
        total += r["amount"]
        out.append({
            "txn_id":   r["qbo_txn_id"] or "",
            "txn_type": r["txn_type"],
            "txn_number": r["txn_number"] or "",
            "txn_date": r["txn_date"].isoformat() if r["txn_date"] else "",
            "amount":   str(r["amount"]),
            "memo":     r["memo"] or "",
            "entity":   r["entity_name"] or "",
        })
    return {
        "rows": out,
        "total": str(total.quantize(Decimal("0.01"))),
        "period_start": period_start.isoformat(),
        "period_end":   pe.isoformat(),
    }
