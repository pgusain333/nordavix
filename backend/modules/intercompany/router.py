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
# avoid common false positives ("loan" matches everything, hence the
# more-specific variants only).
_IC_PATTERNS = [
    r"\bintercompany\b",
    r"\binter-company\b",
    r"\bdue\s+to\b",
    r"\bdue\s+from\b",
    r"\bi/c\b",
    r"\bi\.c\.\b",
    r"\bic\s+(receivable|payable|loan)\b",
    r"\bloan\s+to\s+(subsidiary|parent|affiliate|sister)\b",
    r"\bloan\s+from\s+(subsidiary|parent|affiliate|sister)\b",
    r"\baffiliate\s+(receivable|payable)\b",
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
    from modules.recons.overview import _list_balance_sheet_accounts
    from core.qbo_tb import fetch_trial_balance, lookup_balance, parse_trial_balance

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
) -> dict:
    """Scan QBO accounts; mark anything matching the IC name pattern."""
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    from modules.recons.overview import _list_balance_sheet_accounts
    accts = await _list_balance_sheet_accounts(conn, db)

    existing = list((await db.execute(select(IntercompanyAccount))).scalars().all())
    existing_ids = {m.qbo_account_id for m in existing}

    added = 0
    for a in accts:
        qid = str(a.get("Id") or "")
        if not qid or qid in existing_ids:
            continue
        name = str(a.get("Name") or "")
        if not _IC_REGEX.search(name):
            continue
        row = IntercompanyAccount(
            qbo_account_id=qid,
            counterparty=None,
            kind=_kind_for_account_type(str(a.get("AccountType") or "")),
            auto_detected=True,
            created_by=user.id,
        )
        db.add(row)
        added += 1
    await db.commit()
    return {"added": added}


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
