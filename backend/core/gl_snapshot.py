"""
Capture every GL account's balance to gl_balance_snapshots at a given
period_end. Invoked from the recons sync after a QBO TrialBalance
pull — non-blocking on failure, since the sync itself is the
primary user-facing flow.

For Balance Sheet accounts the snapshot value equals the balance
at end_date (running total). For P&L accounts, because the TB
query uses start_date=Jan 1 of the period_end's calendar year, the
snapshot captures YTD activity. Both behaviors are what the
Financial Package's "Nordavix synced" source needs to build IS / BS
from the same row store.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.gl_balance_snapshot import GlBalanceSnapshot
from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)


async def capture_snapshot(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    period_end: date,
    conn: QboConnection | None = None,
    tb_report: dict | None = None,
    bs_accts: list[dict] | None = None,
) -> int:
    """
    Pull every active QBO account + its balance at period_end via the
    canonical TB fetcher and upsert to gl_balance_snapshots.

    Returns the number of rows written, or -1 if the QBO TrialBalance pull (or
    the commit) failed — so the caller can tell a failed refresh (which leaves a
    STALE snapshot) apart from a legitimately empty one, and surface it instead
    of continuing silently. Never raises on a QBO error, so it can't block the
    recons sync.
    """
    from core.qbo_tb import fetch_trial_balance, parse_trial_balance

    if conn is None:
        conn = (await db.execute(
            select(QboConnection).where(QboConnection.tenant_id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
    if conn is None:
        return 0

    try:
        # Reuse the caller's already-pulled TrialBalance when provided (the recons
        # sync pulls it once and shares it) — identical data, one fewer QBO call.
        report = tb_report if tb_report is not None else await fetch_trial_balance(conn, period_end)
        parsed = parse_trial_balance(report)
    except Exception:
        logger.exception("Snapshot TB pull failed for %s", period_end)
        return -1

    # parse_trial_balance returns rows keyed by account name; we also
    # need account_type which only the /query gives us. Pull the
    # account list in the same shape the recons module uses + merge.
    from modules.recons.overview import _list_balance_sheet_accounts
    if bs_accts is None:
        bs_accts = await _list_balance_sheet_accounts(conn, db)

    # Also pull P&L accounts so the snapshot covers everything the
    # Income Statement needs.
    pl_accts = await _list_pl_accounts(conn, db)
    all_accts_by_id = {str(a.get("Id")): a for a in (bs_accts + pl_accts) if a.get("Id")}

    from core.qbo_tb import lookup_balance
    # Explicit tenant_id filter (don't rely on the session listener — the
    # whole point of this query is to find rows we can update, and if the
    # listener ever gets bypassed by a missing context var we'd grab
    # cross-tenant rows and silently mutate them).
    existing = list((await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.period_end == period_end,
        )
    )).scalars().all())
    existing_by_acct: dict[str, GlBalanceSnapshot] = {r.qbo_account_id: r for r in existing}

    written = 0
    for qid, acct in all_accts_by_id.items():
        name = str(acct.get("Name") or "").strip()
        acct_num = str(acct.get("AcctNum") or "").strip()
        acct_type = str(acct.get("AccountType") or "").strip()
        if not name:
            continue
        bal = lookup_balance(parsed, qbo_id=qid, acct_num=acct_num, name=name)
        if bal is None:
            # P&L accounts often have $0 mid-period — record explicit zero
            # so the IS builder sees them as line items (with no activity)
            # rather than missing entirely.
            bal = Decimal("0")
        bal_q = bal.quantize(Decimal("0.01"))

        row = existing_by_acct.get(qid)
        if row is None:
            # `tenant_id` MUST be set explicitly: TenantBase declares the
            # column NOT NULL, and the tenancy session listener only
            # auto-injects WHERE filters on reads — it never fills in
            # tenant_id on inserts. Omitting it raises NotNullViolation,
            # which puts the AsyncSession into PendingRollback and breaks
            # every subsequent query the request makes (in particular,
            # the Financials PDF export — which is why it was failing).
            row = GlBalanceSnapshot(
                tenant_id=tenant_id,
                qbo_account_id=qid,
                period_end=period_end,
                account_number=acct_num or None,
                account_name=name,
                account_type=acct_type,
                balance=bal_q,
            )
            db.add(row)
        else:
            row.account_number = acct_num or None
            row.account_name = name
            row.account_type = acct_type
            row.balance = bal_q
        written += 1

    try:
        await db.commit()
    except Exception:
        # Roll back so the caller's session is usable again (without this,
        # the next query on the same session hits PendingRollbackError).
        await db.rollback()
        logger.exception("Snapshot commit failed for %s", period_end)
        return -1
    return written


async def _list_pl_accounts(conn: QboConnection, db: AsyncSession) -> list[dict]:
    """Active P&L accounts — Income / COGS / Expense / Other Income /
    Other Expense."""
    from modules.recons.service import _qbo_get

    types = ["Income", "Cost of Goods Sold", "Expense", "Other Income", "Other Expense"]
    quoted = ", ".join(f"'{t}'" for t in types)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType, CurrentBalance "
        f"FROM Account WHERE AccountType IN ({quoted}) AND Active = true "
        f"MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("P&L account list pull failed")
        return []
    return data.get("QueryResponse", {}).get("Account", []) or []
