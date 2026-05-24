"""
Variance Transactions — pull QBO transactions hitting a specific account
during the change window of a flux analysis.

Triggered from the variance row's "Pull transactions" expand. Pulls the
right set of transactions for the account type:

  AR accounts → Invoice + Payment + CreditMemo + AR-targeted JEs
                (Invoices/Payments don't carry AccountRef — QBO posts
                them to AR implicitly via CustomerRef. Filtering by
                AccountRef returns NOTHING for AR. That was the bug.)

  AP accounts → Bill + VendorCredit + BillPayment + AP-targeted JEs

  Bank / Credit Card →  Deposit + Purchase + Check + Transfer +
                        any JE line that hit the account

  Everything else (Fixed Asset, Other Asset, Equity, etc.) →
                JE lines that hit the account + AccountBasedExpense
                lines on Purchases / Bills

Stored as variance_transactions rows so the reviewer can tick each
one off (is_checked) and we can show them again without re-querying.

By design we do this ONLY for material variances.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.qbo_connection import QboConnection
from models.variance_transaction import VarianceTransaction

logger = logging.getLogger(__name__)


# ── helpers ─────────────────────────────────────────────────────────────────

def _dec(val: Any) -> Decimal:
    if val is None or val == "":
        return Decimal("0")
    s = str(val).strip().replace(",", "").replace("$", "")
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        d = Decimal(s)
        return -d if neg else d
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _parse_date(s: Any) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:
        return None


async def _qbo_get(conn: QboConnection, db: AsyncSession, path: str, params: dict | None = None) -> dict:
    """Auth'd QBO GET. Lazily imports the shared helper to avoid circular deps."""
    from modules.recons.service import _qbo_get as _shared_qbo_get
    return await _shared_qbo_get(conn, db, path, params)


async def _lookup_account_type(conn: QboConnection, db: AsyncSession, qbo_account_id: str) -> str:
    """Fetch the QBO AccountType for an account id. Returns "" if anything goes wrong."""
    try:
        data = await _qbo_get(
            conn, db, "/query",
            params={
                "query": f"SELECT Id, AccountType FROM Account WHERE Id = '{qbo_account_id}'",
                "minorversion": "65",
            },
        )
        accts = data.get("QueryResponse", {}).get("Account", []) or []
        if accts:
            return str(accts[0].get("AccountType") or "")
    except Exception:
        logger.exception("AccountType lookup failed for %s", qbo_account_id)
    return ""


# ── public entry point ─────────────────────────────────────────────────────

async def pull_transactions_for_variance(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    qbo_account_id: str,
    period_start: date,
    period_end: date,
) -> list[VarianceTransaction]:
    """
    Wipe stored rows for this variance and re-pull from QBO. Caller commits.

    The window [period_start, period_end] is the change window —
    i.e. prior_period_end + 1 day to current_period_end. Driving txns are
    everything posted to the account in that interval.
    """
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("QuickBooks isn't connected — variance drill-in is only available for QBO-sourced analyses.")

    await db.execute(delete(VarianceTransaction).where(VarianceTransaction.variance_id == variance_id))

    start = period_start.isoformat()
    end = period_end.isoformat()

    account_type = await _lookup_account_type(conn, db, qbo_account_id)
    logger.info("Variance txn pull: variance=%s account=%s type=%s window=%s..%s",
                variance_id, qbo_account_id, account_type, start, end)

    rows_out: list[VarianceTransaction] = []

    # Always: pull JE lines that touched this exact account (works for every type)
    rows_out += await _pull_je_lines(conn, db, tenant_id, variance_id, qbo_account_id, start, end)

    # Account-type-specific pulls
    if account_type == "Accounts Receivable":
        # Invoices / Payments / CreditMemos all post to AR implicitly via CustomerRef.
        # No AccountRef filter — every in-period one is an AR-driving txn.
        rows_out += await _pull_ar_txns(conn, db, tenant_id, variance_id, start, end)
    elif account_type == "Accounts Payable":
        rows_out += await _pull_ap_txns(conn, db, tenant_id, variance_id, start, end)
    elif account_type in ("Bank", "Credit Card"):
        rows_out += await _pull_bank_cc_txns(conn, db, tenant_id, variance_id, qbo_account_id, start, end)
    else:
        # Other balance-sheet / P&L accounts: pull purchases/bills with
        # AccountBasedExpense lines hitting this account.
        rows_out += await _pull_account_ref_txns(conn, db, tenant_id, variance_id, qbo_account_id, start, end)

    for r in rows_out:
        db.add(r)

    rows_out.sort(key=lambda r: (r.txn_date or date.min), reverse=True)
    return rows_out


# ── pullers per account type ───────────────────────────────────────────────

async def _pull_je_lines(
    conn: QboConnection,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    qbo_account_id: str,
    start: str, end: str,
) -> list[VarianceTransaction]:
    """JEs that touched this exact account — common to every account type."""
    try:
        data = await _qbo_get(conn, db, "/query", params={
            "query": (
                f"SELECT Id, DocNumber, TxnDate, PrivateNote, Line "
                f"FROM JournalEntry WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 500"
            ),
            "minorversion": "65",
        })
        jes = data.get("QueryResponse", {}).get("JournalEntry", []) or []
    except Exception:
        logger.exception("JE pull failed for variance %s", variance_id)
        return []

    out: list[VarianceTransaction] = []
    for je in jes:
        amount = Decimal("0")
        entity_name: str | None = None
        for line in je.get("Line", []) or []:
            detail = line.get("JournalEntryLineDetail") or {}
            if (detail.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            ent = (detail.get("Entity") or {}).get("EntityRef")
            if ent and not entity_name:
                entity_name = str(ent.get("name") or "")[:255]
            line_amt = _dec(line.get("Amount"))
            amount += line_amt if detail.get("PostingType") == "Debit" else -line_amt
        if amount == 0:
            continue
        out.append(VarianceTransaction(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            variance_id=variance_id,
            qbo_txn_id=str(je.get("Id") or ""),
            txn_type="JournalEntry",
            txn_number=str(je.get("DocNumber") or "")[:100],
            txn_date=_parse_date(je.get("TxnDate")),
            amount=amount,
            memo=(je.get("PrivateNote") or "")[:500] or None,
            entity_name=entity_name,
        ))
    return out


async def _pull_ar_txns(
    conn: QboConnection,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    start: str, end: str,
) -> list[VarianceTransaction]:
    """
    AR-driving txns. Every Invoice/Payment/CreditMemo for a customer in QBO
    hits an AR account. We can't reliably tell *which* AR account in
    multi-AR workspaces from the doc payload alone, so for MVP we include
    all of them — better to over-include than to silently drop AR activity.
    """
    out: list[VarianceTransaction] = []
    pulls = [
        ("Invoice",    "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, CustomerRef", "DocNumber",        +1),
        ("CreditMemo", "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, CustomerRef", "DocNumber",        -1),
        ("Payment",    "Id, PaymentRefNum, TxnDate, TotalAmt, PrivateNote, CustomerRef", "PaymentRefNum", -1),
    ]
    for kind, fields, num_field, sign in pulls:
        try:
            data = await _qbo_get(conn, db, "/query", params={
                "query": (
                    f"SELECT {fields} FROM {kind} "
                    f"WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 500"
                ),
                "minorversion": "65",
            })
            rows = data.get("QueryResponse", {}).get(kind, []) or []
        except Exception:
            logger.exception("AR pull failed for %s", kind)
            continue
        for t in rows:
            entity = (t.get("CustomerRef") or {}).get("name")
            amount = _dec(t.get("TotalAmt")) * sign
            out.append(VarianceTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                variance_id=variance_id,
                qbo_txn_id=str(t.get("Id") or ""),
                txn_type=kind,
                txn_number=str(t.get(num_field) or "")[:100],
                txn_date=_parse_date(t.get("TxnDate")),
                amount=amount,
                memo=(t.get("PrivateNote") or "")[:500] or None,
                entity_name=str(entity)[:255] if entity else None,
            ))
    return out


async def _pull_ap_txns(
    conn: QboConnection,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    start: str, end: str,
) -> list[VarianceTransaction]:
    """AP mirror of _pull_ar_txns."""
    out: list[VarianceTransaction] = []
    pulls = [
        ("Bill",         "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, VendorRef", "DocNumber", +1),
        ("VendorCredit", "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, VendorRef", "DocNumber", -1),
        ("BillPayment",  "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, VendorRef", "DocNumber", -1),
    ]
    for kind, fields, num_field, sign in pulls:
        try:
            data = await _qbo_get(conn, db, "/query", params={
                "query": (
                    f"SELECT {fields} FROM {kind} "
                    f"WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 500"
                ),
                "minorversion": "65",
            })
            rows = data.get("QueryResponse", {}).get(kind, []) or []
        except Exception:
            logger.exception("AP pull failed for %s", kind)
            continue
        for t in rows:
            entity = (t.get("VendorRef") or {}).get("name")
            amount = _dec(t.get("TotalAmt")) * sign
            out.append(VarianceTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                variance_id=variance_id,
                qbo_txn_id=str(t.get("Id") or ""),
                txn_type=kind,
                txn_number=str(t.get(num_field) or "")[:100],
                txn_date=_parse_date(t.get("TxnDate")),
                amount=amount,
                memo=(t.get("PrivateNote") or "")[:500] or None,
                entity_name=str(entity)[:255] if entity else None,
            ))
    return out


async def _pull_bank_cc_txns(
    conn: QboConnection,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    qbo_account_id: str,
    start: str, end: str,
) -> list[VarianceTransaction]:
    """Bank / Credit Card: Deposits, Purchases, Checks, Transfers touching this account."""
    out: list[VarianceTransaction] = []

    # Deposit + Purchase + Check have direct top-level AccountRef
    for kind, fields, num_field, sign in [
        ("Deposit",   "Id, TxnDate, TotalAmt, PrivateNote, AccountRef",                     "Id",        +1),
        ("Purchase",  "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, AccountRef, EntityRef","DocNumber", -1),
        ("Check",     "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, AccountRef, EntityRef","DocNumber", -1),
    ]:
        try:
            data = await _qbo_get(conn, db, "/query", params={
                "query": f"SELECT {fields} FROM {kind} WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 500",
                "minorversion": "65",
            })
        except Exception:
            continue
        for t in data.get("QueryResponse", {}).get(kind, []) or []:
            if (t.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            entity = (t.get("EntityRef") or {}).get("name") if t.get("EntityRef") else None
            out.append(VarianceTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                variance_id=variance_id,
                qbo_txn_id=str(t.get("Id") or ""),
                txn_type=kind,
                txn_number=str(t.get(num_field) or "")[:100],
                txn_date=_parse_date(t.get("TxnDate")),
                amount=_dec(t.get("TotalAmt")) * sign,
                memo=(t.get("PrivateNote") or "")[:500] or None,
                entity_name=str(entity)[:255] if entity else None,
            ))

    # Transfer is a two-leg construct — pull and match either leg
    try:
        data = await _qbo_get(conn, db, "/query", params={
            "query": f"SELECT Id, TxnDate, Amount, PrivateNote, FromAccountRef, ToAccountRef FROM Transfer WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 200",
            "minorversion": "65",
        })
        for t in data.get("QueryResponse", {}).get("Transfer", []) or []:
            from_id = (t.get("FromAccountRef") or {}).get("value")
            to_id = (t.get("ToAccountRef") or {}).get("value")
            if qbo_account_id not in (from_id, to_id):
                continue
            sign = -1 if from_id == qbo_account_id else +1
            out.append(VarianceTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                variance_id=variance_id,
                qbo_txn_id=str(t.get("Id") or ""),
                txn_type="Transfer",
                txn_number=str(t.get("Id") or "")[:100],
                txn_date=_parse_date(t.get("TxnDate")),
                amount=_dec(t.get("Amount")) * sign,
                memo=(t.get("PrivateNote") or "")[:500] or None,
                entity_name=None,
            ))
    except Exception:
        logger.exception("Transfer pull failed for variance %s", variance_id)
    return out


async def _pull_account_ref_txns(
    conn: QboConnection,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    qbo_account_id: str,
    start: str, end: str,
) -> list[VarianceTransaction]:
    """
    Other-account types (fixed asset, prepaid, accrual, expense, etc.):
    pull Purchases / Bills where any AccountBasedExpenseLine targets the
    account. Plus the JE lines are already covered by _pull_je_lines.
    """
    out: list[VarianceTransaction] = []
    pulls = [
        ("Purchase", "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, EntityRef, Line"),
        ("Bill",     "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, VendorRef, Line"),
    ]
    for kind, fields in pulls:
        try:
            data = await _qbo_get(conn, db, "/query", params={
                "query": f"SELECT {fields} FROM {kind} WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 500",
                "minorversion": "65",
            })
        except Exception:
            continue
        for t in data.get("QueryResponse", {}).get(kind, []) or []:
            if not _has_account_in_lines(t, qbo_account_id):
                continue
            entity = (
                ((t.get("EntityRef") or {}).get("name"))
                or ((t.get("VendorRef") or {}).get("name"))
            )
            out.append(VarianceTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                variance_id=variance_id,
                qbo_txn_id=str(t.get("Id") or ""),
                txn_type=kind,
                txn_number=str(t.get("DocNumber") or "")[:100],
                txn_date=_parse_date(t.get("TxnDate")),
                amount=_dec(t.get("TotalAmt")),
                memo=(t.get("PrivateNote") or "")[:500] or None,
                entity_name=str(entity)[:255] if entity else None,
            ))
    return out


def _has_account_in_lines(txn: dict, qbo_account_id: str) -> bool:
    for line in txn.get("Line", []) or []:
        for key in (
            "AccountBasedExpenseLineDetail",
            "DepositLineDetail",
            "JournalEntryLineDetail",
        ):
            d = line.get(key)
            if d and (d.get("AccountRef") or {}).get("value") == qbo_account_id:
                return True
    return False


__all__ = ["pull_transactions_for_variance"]
