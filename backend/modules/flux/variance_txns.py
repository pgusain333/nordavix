"""
Variance Transactions — pull QBO transactions hitting a specific account
during the current period of a flux analysis.

Triggered from the variance row's "Find reasons" expand. Pulls:
  - JournalEntry lines touching the account
  - Invoice / Bill / Payment / Deposit / CreditMemo / VendorCredit /
    Purchase rows tied to the account
  - Stored as variance_transactions rows so the reviewer can tick each
    one off (is_checked) and we can show them again without re-querying.

By design we do this ONLY for material variances (the user explicitly
asked for that scope). The endpoint validates is_material before pulling.
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


def _dec(val: Any) -> Decimal:
    """Parse numeric value from QBO responses (handles strings, parens, $)."""
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
    """Auth'd QBO GET. Imports lazily to avoid recons↔flux circular dependency."""
    from modules.recons.service import _qbo_get as _shared_qbo_get
    return await _shared_qbo_get(conn, db, path, params)


async def pull_transactions_for_variance(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
    qbo_account_id: str,
    period_start: date,
    period_end: date,
) -> list[VarianceTransaction]:
    """
    Wipe + re-pull. Caller should commit afterwards. Returns the freshly
    created VarianceTransaction rows ordered by date descending.

    QBO query scope is bounded by [period_start, period_end] — we want the
    activity that drove THIS period's change, not prior history. Customer
    and vendor names are pulled separately when present on the line.
    """
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("QuickBooks isn't connected — variance drill-in is only available for QBO-sourced analyses.")

    # Wipe old evidence rows for this variance so we don't show stale data
    await db.execute(delete(VarianceTransaction).where(VarianceTransaction.variance_id == variance_id))

    start = period_start.isoformat()
    end = period_end.isoformat()

    rows_out: list[VarianceTransaction] = []

    # ── 1) JE lines touching this account ─────────────────────────────────
    try:
        q = (
            f"SELECT Id, DocNumber, TxnDate, PrivateNote, Line "
            f"FROM JournalEntry WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' "
            f"MAXRESULTS 500"
        )
        data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
        jes = data.get("QueryResponse", {}).get("JournalEntry", []) or []
    except Exception:
        logger.exception("JE pull failed for variance %s", variance_id)
        jes = []

    for je in jes:
        # Sum only lines that hit this account
        amount = Decimal("0")
        entity_name: str | None = None
        for line in je.get("Line", []) or []:
            detail = line.get("JournalEntryLineDetail") or {}
            if (detail.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            entity_ref = (detail.get("Entity") or {}).get("EntityRef")
            if entity_ref and not entity_name:
                entity_name = str(entity_ref.get("name") or "")[:255]
            line_amt = _dec(line.get("Amount"))
            amount += line_amt if detail.get("PostingType") == "Debit" else -line_amt
        if amount == 0:
            continue
        rows_out.append(VarianceTransaction(
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

    # ── 2) Direct-AccountRef txn types (Deposit, Purchase) ────────────────
    for entity_kind, fields in [
        ("Deposit",  "Id, TxnDate, TotalAmt, PrivateNote, AccountRef, DepositLineDetail"),
        ("Purchase", "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, AccountRef, EntityRef"),
    ]:
        try:
            q = (
                f"SELECT {fields} FROM {entity_kind} "
                f"WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 200"
            )
            data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
        except Exception:
            continue
        for t in data.get("QueryResponse", {}).get(entity_kind, []) or []:
            if (t.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            entity = ((t.get("EntityRef") or {}).get("name")) or None
            rows_out.append(VarianceTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                variance_id=variance_id,
                qbo_txn_id=str(t.get("Id") or ""),
                txn_type=entity_kind,
                txn_number=str(t.get("DocNumber") or "")[:100],
                txn_date=_parse_date(t.get("TxnDate")),
                amount=_dec(t.get("TotalAmt")),
                memo=(t.get("PrivateNote") or "")[:500] or None,
                entity_name=str(entity)[:255] if entity else None,
            ))

    # ── 3) Invoice / Bill / Payment / CreditMemo / VendorCredit ───────────
    # These don't always carry AccountRef in their header — for MVP we pull
    # them all in-period and filter on the LinkedTxn / Line.AccountBasedExpense
    # detail. To keep the response small + fast we only include rows where
    # ANY line targets the account.
    txn_pulls = [
        ("Invoice",      "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, CustomerRef, Line"),
        ("Bill",         "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, VendorRef, Line"),
        ("Payment",      "Id, PaymentRefNum, TxnDate, TotalAmt, PrivateNote, CustomerRef, Line, DepositToAccountRef"),
        ("CreditMemo",   "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, CustomerRef, Line"),
        ("VendorCredit", "Id, DocNumber, TxnDate, TotalAmt, PrivateNote, VendorRef, Line"),
    ]

    for entity_kind, fields in txn_pulls:
        try:
            q = (
                f"SELECT {fields} FROM {entity_kind} "
                f"WHERE TxnDate >= '{start}' AND TxnDate <= '{end}' MAXRESULTS 200"
            )
            data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
        except Exception:
            continue
        for t in data.get("QueryResponse", {}).get(entity_kind, []) or []:
            if not _txn_hits_account(t, qbo_account_id):
                continue
            entity_name = (
                ((t.get("CustomerRef") or {}).get("name"))
                or ((t.get("VendorRef") or {}).get("name"))
            )
            number_field = "PaymentRefNum" if entity_kind == "Payment" else "DocNumber"
            rows_out.append(VarianceTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                variance_id=variance_id,
                qbo_txn_id=str(t.get("Id") or ""),
                txn_type=entity_kind,
                txn_number=str(t.get(number_field) or "")[:100],
                txn_date=_parse_date(t.get("TxnDate")),
                amount=_dec(t.get("TotalAmt")),
                memo=(t.get("PrivateNote") or "")[:500] or None,
                entity_name=str(entity_name)[:255] if entity_name else None,
            ))

    # Persist + return sorted newest first
    for r in rows_out:
        db.add(r)

    rows_out.sort(key=lambda r: (r.txn_date or date.min), reverse=True)
    return rows_out


def _txn_hits_account(txn: dict, qbo_account_id: str) -> bool:
    """
    Best-effort: does any line on this txn reference the target account?
    QBO scatters account refs across many shapes:
      - JournalEntryLineDetail.AccountRef
      - AccountBasedExpenseLineDetail.AccountRef
      - DepositLineDetail.AccountRef
      - DescriptionLineDetail.AccountRef (rare)
      - Top-level DepositToAccountRef (Payment)
    """
    if (txn.get("DepositToAccountRef") or {}).get("value") == qbo_account_id:
        return True
    for line in txn.get("Line", []) or []:
        for key in (
            "JournalEntryLineDetail",
            "AccountBasedExpenseLineDetail",
            "DepositLineDetail",
            "DescriptionLineDetail",
        ):
            d = line.get(key)
            if d and (d.get("AccountRef") or {}).get("value") == qbo_account_id:
                return True
    return False


__all__ = ["pull_transactions_for_variance"]
