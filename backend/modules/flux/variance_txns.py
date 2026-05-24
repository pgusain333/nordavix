"""
Variance Transactions — pull QBO transactions hitting a specific account
during the change window of a flux analysis.

Strategy: use QBO's GeneralLedger report filtered by account_id.

Why GL report instead of per-entity queries:
  - GL is QBO's canonical source of "what posted to this account in
    this period". It works uniformly for every account type:
        AR  → Invoice / Payment / CreditMemo / JE
        AP  → Bill / VendorCredit / BillPayment / JE
        Bank/CC → Deposit / Purchase / Check / Transfer / JE
        Income → Invoice line + SalesReceipt + JE
        Expense → Purchase / Bill / Check + JE
        Equity / Other Liab → JE
  - One API call vs N — much faster and far less brittle than
    walking line-detail shapes per transaction type.
  - Amounts are signed naturally (debit positive, credit negative)
    so the table footer "sum of txns" reconciles to the variance.

We deliberately pull only this account's rows from the report; we
don't try to expand each transaction to show the contra side (that's
the next iteration if users need it).
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

    Date window [period_start, period_end] is the change window —
    prior_period_end + 1 day through current_period_end. Sum of returned
    rows should reconcile to the GL variance for that account.
    """
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise RuntimeError("QuickBooks isn't connected — variance drill-in is only available for QBO-sourced analyses.")

    await db.execute(delete(VarianceTransaction).where(VarianceTransaction.variance_id == variance_id))

    start = period_start.isoformat()
    end   = period_end.isoformat()
    logger.info("Variance txn pull: variance=%s account=%s window=%s..%s",
                variance_id, qbo_account_id, start, end)

    # The GeneralLedger report is the cleanest cross-account-type source.
    # We request explicit columns so the parser is stable regardless of the
    # company's report customization defaults.
    try:
        report = await _qbo_get(conn, db, "/reports/GeneralLedger", params={
            "start_date":       start,
            "end_date":         end,
            "account":          qbo_account_id,
            "accounting_method":"Accrual",
            "columns":          "tx_date,txn_type,doc_num,name,memo,subt_nat_amount,split_acc",
            "minorversion":     "65",
        })
    except Exception as exc:
        logger.exception("GeneralLedger pull failed for variance %s", variance_id)
        raise RuntimeError(f"QuickBooks GeneralLedger pull failed: {exc}") from exc

    rows_out = _parse_gl_report(report, tenant_id, variance_id)

    for r in rows_out:
        db.add(r)

    rows_out.sort(key=lambda r: (r.txn_date or date.min), reverse=True)
    return rows_out


# ── GL report parsing ───────────────────────────────────────────────────────

def _parse_gl_report(report: dict, tenant_id: uuid.UUID, variance_id: uuid.UUID) -> list[VarianceTransaction]:
    """
    QBO GL report shape:
      Header.Time, Header.ReportName, Header.ReportBasis, Header.StartPeriod, Header.EndPeriod
      Columns.Column[]: each has ColTitle / ColType / MetaData (id, name, hidden)
      Rows.Row[]: each is either
          - a "Section" with a Header (account summary) + child Rows + Summary
          - a "Data" row with ColData[] of the actual transaction
    We walk depth-first picking ColData rows. Total/summary rows are skipped.
    """
    # Map column position → role using ColType for stability.
    cols = report.get("Columns", {}).get("Column", []) or []
    role_by_idx: dict[int, str] = {}
    for i, c in enumerate(cols):
        coltype = (c.get("ColType") or "").strip().lower()
        title   = (c.get("ColTitle") or "").strip().lower()
        role = _coltype_to_role(coltype, title)
        if role:
            role_by_idx[i] = role

    rows_out: list[VarianceTransaction] = []

    def walk(rows: list[dict]) -> None:
        for r in rows:
            kind = r.get("type") or ""
            sub  = r.get("Rows", {}).get("Row", []) or []
            cd   = r.get("ColData") or []

            # Skip section header/summary rows — they have group="Account" or
            # similar and no actual transaction in ColData.
            if cd and (r.get("type") == "Data" or not r.get("group")):
                first_val = (cd[0].get("value", "") if cd else "").strip().lower()
                # Filter out "Beginning Balance" / "Total" / "Ending Balance"
                if first_val not in ("", "beginning balance", "total", "ending balance"):
                    txn = _row_to_txn(cd, role_by_idx, tenant_id, variance_id)
                    if txn is not None:
                        rows_out.append(txn)
            elif kind == "Section" and not sub:
                # Section without children — typically the "no activity" placeholder
                continue
            if sub:
                walk(sub)

    walk(report.get("Rows", {}).get("Row", []) or [])
    return rows_out


def _coltype_to_role(coltype: str, title: str) -> str | None:
    """Map QBO column type/title to our row dict key."""
    if coltype in ("tx_date", "txndate", "date"):           return "date"
    if coltype in ("txn_type",):                            return "type"
    if coltype in ("doc_num",):                             return "number"
    if coltype in ("name", "customer", "vendor", "payee"):  return "entity"
    if coltype in ("memo", "description"):                  return "memo"
    if coltype in ("subt_nat_amount", "amount", "subt_amount"):
                                                            return "amount"
    if coltype in ("split_acc", "split"):                   return "split"
    # Fall back to title heuristics
    t = title
    if "date" in t and "modify" not in t:                   return "date"
    if "type" in t:                                         return "type"
    if "num" in t:                                          return "number"
    if "memo" in t or "description" in t:                   return "memo"
    if "amount" in t:                                       return "amount"
    if "split" in t:                                        return "split"
    if "name" in t or "customer" in t or "vendor" in t:     return "entity"
    return None


def _row_to_txn(
    coldata: list[dict],
    role_by_idx: dict[int, str],
    tenant_id: uuid.UUID,
    variance_id: uuid.UUID,
) -> VarianceTransaction | None:
    """Convert one GL ColData row into a VarianceTransaction model."""
    bucket: dict[str, str] = {}
    qbo_txn_id: str | None = None
    for i, c in enumerate(coldata):
        role = role_by_idx.get(i)
        if not role:
            continue
        bucket[role] = (c.get("value", "") or "").strip()
        # QBO leaves the txn id under the date column's `id` (transactional rows)
        if not qbo_txn_id and c.get("id"):
            qbo_txn_id = str(c.get("id"))

    amount = _dec(bucket.get("amount", ""))
    if amount == 0 and not bucket.get("number") and not bucket.get("entity") and not bucket.get("memo"):
        # Empty-looking row — skip
        return None

    return VarianceTransaction(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        variance_id=variance_id,
        qbo_txn_id=qbo_txn_id,
        txn_type=bucket.get("type") or "Transaction",
        txn_number=bucket.get("number", "")[:100] or None,
        txn_date=_parse_date(bucket.get("date", "")),
        amount=amount,
        memo=bucket.get("memo", "")[:500] or None,
        entity_name=bucket.get("entity", "")[:255] or None,
    )


__all__ = ["pull_transactions_for_variance"]
