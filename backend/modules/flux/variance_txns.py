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

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.db.session import assert_tenant_owns
from models.qbo_connection import QboConnection
from models.variance import Variance
from models.variance_transaction import VarianceTransaction

logger = logging.getLogger(__name__)


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

    # The delete below is keyed on variance_id (a foreign key), which the
    # session SELECT filter does not auto-scope to the tenant. Enforce that this
    # variance belongs to the caller's tenant first, so a foreign variance_id
    # can never wipe another tenant's stored transactions.
    await assert_tenant_owns(
        db, Variance, variance_id, tenant_id=tenant_id, label="Variance"
    )

    await db.execute(delete(VarianceTransaction).where(VarianceTransaction.variance_id == variance_id))

    logger.info("Variance txn pull: variance=%s account=%s window=%s..%s",
                variance_id, qbo_account_id, period_start, period_end)

    # Shared QBO GeneralLedger helper — single canonical implementation
    from core.qbo_gl import pull_gl_transactions
    gl_rows = await pull_gl_transactions(conn, db, qbo_account_id, period_start, period_end)

    rows_out = [
        VarianceTransaction(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            variance_id=variance_id,
            qbo_txn_id=r["qbo_txn_id"],
            txn_type=r["txn_type"],
            txn_number=(r["txn_number"] or "")[:100] or None,
            txn_date=r["txn_date"],
            amount=r["amount"],
            memo=(r["memo"] or "")[:500] or None,
            entity_name=(r["entity_name"] or "")[:255] or None,
        )
        for r in gl_rows
    ]

    for r in rows_out:
        db.add(r)

    rows_out.sort(key=lambda r: (r.txn_date or date.min), reverse=True)
    return rows_out


__all__ = ["pull_transactions_for_variance"]
