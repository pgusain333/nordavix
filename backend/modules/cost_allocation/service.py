"""Nordavix Allocate — the monthly run.

Orchestration only: this module fetches, calls the pure engine, and persists.
All the accounting judgment lives in engine.py, which has no I/O and is covered
by the deploy-gating invariants. Keeping the split sharp is what makes the
numbers testable.

One run =
    load the client's pools / maps / registries as of the period
    pull the period's expenses from QuickBooks
    compute the drivers, allocate, roll forward to COGS
    persist alloc_run + alloc_run_line with the drivers SNAPSHOTTED
    emit the reclass journal entry into the existing Adjustments queue

A run that can't be computed is persisted as a BLOCKED draft carrying the
reason, not raised as a 500. "Sunrise Dispensary is missing square footage" is a
task the practice can act on; a stack trace is not.

Re-running a period supersedes the previous run rather than deleting it — every
version that was ever issued stays in the audit trail.
"""
import logging
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.config import settings as app_settings
from core.qbo_http import request_with_retry
from core.qbo_tb import fetch_profit_and_loss
from models.cost_allocation import (
    AllocAccountMap,
    AllocEmployee,
    AllocPayrollEntry,
    AllocPool,
    AllocRun,
    AllocRunLine,
    AllocSettings,
    AllocSpace,
)
from models.proposed_entry import ProposedEntry
from models.qbo_connection import QboConnection
from modules.adjustments.service import replace_open_proposals
from modules.cost_allocation.engine import (
    AllocationInputError,
    ExpenseRow,
    Factors,
    PayrollRow,
    PoolSpec,
    SpaceRow,
    allocate_period,
    build_factors,
    build_reclass_entry,
    roll_forward_cogs,
)
from modules.flux.service import parse_qbo_pl_amounts

logger = logging.getLogger(__name__)

ZERO = Decimal("0.00")

# QBO AccountType values that make up the expense universe for a run. Anything
# here that isn't mapped to a pool blocks the run — an unmapped expense account
# silently defaulting would misstate the §280E split.
EXPENSE_ACCOUNT_TYPES = frozenset({"Expense", "Other Expense", "Cost of Goods Sold"})


# ── Loading the client's configuration ────────────────────────────────────────

def _effective(rows, period_end: date):
    """Rows in force at period_end (effective-dated registries)."""
    return [
        r for r in rows
        if r.effective_from <= period_end and (r.effective_to is None or r.effective_to >= period_end)
    ]


async def load_config(db: AsyncSession, period_end: date):
    """Pools, account map, spaces and employee classifications as of the period."""
    pools = (await db.execute(
        select(AllocPool).where(AllocPool.active.is_(True)).order_by(AllocPool.sort_order, AllocPool.name)
    )).scalars().all()

    account_map_rows = _effective(
        (await db.execute(select(AllocAccountMap))).scalars().all(), period_end
    )
    spaces = _effective((await db.execute(select(AllocSpace))).scalars().all(), period_end)
    employees = _effective(
        (await db.execute(select(AllocEmployee).where(AllocEmployee.active.is_(True)))).scalars().all(),
        period_end,
    )
    return pools, account_map_rows, spaces, employees


async def load_payroll(
    db: AsyncSession, employees, period_start: date, period_end: date,
) -> list[PayrollRow]:
    """Wages for the period, joined to each employee's classification."""
    by_id = {e.id: e for e in employees}
    if not by_id:
        return []
    entries = (await db.execute(
        select(AllocPayrollEntry).where(
            AllocPayrollEntry.period_start >= period_start,
            AllocPayrollEntry.period_end <= period_end,
        )
    )).scalars().all()

    rows: list[PayrollRow] = []
    for entry in entries:
        emp = by_id.get(entry.employee_id)
        if emp is None:
            continue  # classification retired for this period — not in the factor
        rows.append(PayrollRow(
            employee=emp.name,
            function=emp.function,
            # Fully loaded labor cost: the factor's numerator and denominator
            # are built from the same basis, so the ratio stays consistent.
            wages=(entry.gross_wages or ZERO) + (entry.employer_taxes or ZERO) + (entry.benefits or ZERO),
            production_pct=emp.production_pct,
        ))
    return rows


def to_pool_specs(pools) -> list[PoolSpec]:
    return [
        PoolSpec(
            name=p.name, treatment=p.treatment, driver=p.driver,
            blend_payroll_wt=p.blend_payroll_wt, blend_occupancy_wt=p.blend_occupancy_wt,
            fixed_pct=p.fixed_pct,
        )
        for p in pools
    ]


def to_space_rows(spaces) -> list[SpaceRow]:
    return [
        SpaceRow(name=s.name, function=s.function, square_feet=s.square_feet,
                 production_pct=s.production_pct)
        for s in spaces
    ]


# ── QuickBooks ────────────────────────────────────────────────────────────────

async def _fetch_account_types(conn: QboConnection, db: AsyncSession) -> dict[str, dict]:
    """{qbo_account_id: {AcctNum, Name, AccountType}} — best effort.

    Needed to know which P&L rows are expenses. On failure we return {} and the
    caller blocks the run rather than allocating an unknown account universe.
    """
    from modules.qbo.router import _get_valid_token  # local: avoids an import cycle

    token = await _get_valid_token(conn, db)
    url = f"{app_settings.qbo_base_url}/v3/company/{conn.realm_id}/query"
    params = {
        "query": "SELECT Id, Name, AcctNum, AccountType FROM Account WHERE Active = true MAXRESULTS 1000",
        "minorversion": "65",
    }
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await request_with_retry(
            lambda: client.get(url, headers=headers, params=params),
            label="QBO Account query (allocation)",
        )
    if resp.status_code != 200:
        return {}
    return {
        str(a.get("Id")): a
        for a in resp.json().get("QueryResponse", {}).get("Account", []) or []
    }


async def fetch_period_expenses(
    conn: QboConnection, db: AsyncSession, period_start: date, period_end: date,
) -> tuple[list[ExpenseRow], dict[str, dict]]:
    """The period's expense accounts and amounts, from the QBO P&L.

    ProfitAndLoss (not TrialBalance) because the TB reports income-statement
    accounts as fiscal year-to-date; a monthly allocation needs the month.
    """
    accounts = await _fetch_account_types(conn, db)
    if not accounts:
        raise AllocationInputError(
            "Could not read the QuickBooks chart of accounts, so the expense "
            "universe is unknown. Retry, or reconnect QuickBooks."
        )

    report = await fetch_profit_and_loss(conn, period_end, period_start=period_start)
    amounts = parse_qbo_pl_amounts(report)

    rows: list[ExpenseRow] = []
    for acct_id, amount in amounts.items():
        meta = accounts.get(str(acct_id))
        if meta is None or str(meta.get("AccountType")) not in EXPENSE_ACCOUNT_TYPES:
            continue
        rows.append(ExpenseRow(
            qbo_account_id=str(acct_id),
            amount=amount,
            account_number=(str(meta.get("AcctNum")) if meta.get("AcctNum") else None),
            account_name=(str(meta.get("Name")) if meta.get("Name") else None),
        ))
    rows.sort(key=lambda r: (r.account_number or "", r.qbo_account_id))
    return rows, accounts


# ── Persisting ────────────────────────────────────────────────────────────────

async def _supersede_live_runs(db: AsyncSession, tenant_id: uuid.UUID, period_end: date) -> None:
    """Retire the current run for this period so a new one can take its place.

    Supersede rather than delete: the partial-unique index allows only one live
    run per period, and every version that was issued stays queryable.
    """
    await db.execute(
        update(AllocRun)
        .where(
            AllocRun.tenant_id == tenant_id,
            AllocRun.period_end == period_end,
            AllocRun.status != "superseded",
        )
        .values(status="superseded")
    )


async def run_allocation(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    period_start: date,
    period_end: date,
    user_id: uuid.UUID | None,
    beginning_inventory: Decimal | None = None,
    ending_inventory: Decimal | None = None,
    purchases: Decimal | None = None,
) -> AllocRun:
    """Compute and persist one monthly allocation. The caller commits."""
    cfg = (await db.execute(select(AllocSettings))).scalars().first()
    pools, account_map_rows, spaces, employees = await load_config(db, period_end)

    run = AllocRun(
        id=uuid.uuid4(), tenant_id=tenant_id,
        period_start=period_start, period_end=period_end,
        status="draft",
        has_afs=(cfg.has_afs if cfg else None),
        prepared_by=user_id,
        prepared_at=datetime.now(UTC),
        beginning_inventory=beginning_inventory,
        ending_inventory=ending_inventory,
        additions_purchases=purchases,
    )

    def _blocked(reason: str) -> AllocRun:
        run.blocked_reason = reason[:300]
        db.add(run)
        return run

    if not pools:
        return _blocked("No cost pools are configured for this client. Set them up under Setup.")

    conn = (await db.execute(select(QboConnection))).scalars().first()
    if conn is None:
        return _blocked("QuickBooks isn't connected for this client.")

    # ── Pull + allocate. Anything unsound becomes a blocked run, not a 500.
    try:
        expenses, _accounts = await fetch_period_expenses(conn, db, period_start, period_end)
        if not expenses:
            return _blocked(
                f"QuickBooks returned no expense activity for "
                f"{period_start.isoformat()} to {period_end.isoformat()}."
            )

        account_pool = {m.qbo_account_id: m.pool_name for m in _with_pool_names(account_map_rows, pools)}
        factors: Factors = build_factors(
            to_pool_specs(pools),
            spaces=to_space_rows(spaces),
            payroll=await load_payroll(db, employees, period_start, period_end),
        )
        result = allocate_period(expenses, account_pool, to_pool_specs(pools), factors)
    except AllocationInputError as exc:
        logger.info("allocation blocked for tenant %s period %s: %s", tenant_id, period_end, exc)
        return _blocked(str(exc))
    except Exception as exc:  # QBO transport, parse, auth…
        logger.exception("allocation run failed for tenant %s period %s", tenant_id, period_end)
        return _blocked(f"Could not pull from QuickBooks: {exc}"[:300])

    await _supersede_live_runs(db, tenant_id, period_end)

    run.payroll_factor = factors.payroll
    run.occupancy_factor = factors.occupancy
    run.driver_basis = factors.basis
    run.total_expenses = result.total_expenses
    run.direct_total = result.direct_total
    run.allocated_total = result.allocated_total
    run.capitalized_total = result.capitalized_total
    run.disallowed_total = result.disallowed_total
    run.source_pulled_at = datetime.now(UTC)

    if beginning_inventory is not None and ending_inventory is not None:
        cogs = roll_forward_cogs(
            beginning_inventory=beginning_inventory,
            capitalized=result.capitalized_total,
            purchases=purchases or ZERO,
            ending_inventory=ending_inventory,
        )
        run.cogs = cogs.cogs

    db.add(run)
    await db.flush()  # run.id for the lines + the JE's source_ref

    for ln in result.lines:
        db.add(AllocRunLine(
            id=uuid.uuid4(), tenant_id=tenant_id, run_id=run.id,
            qbo_account_id=ln.qbo_account_id,
            account_number=ln.account_number, account_name=ln.account_name,
            pool_name=ln.pool_name, treatment=ln.treatment,
            driver=ln.driver, driver_pct=ln.driver_pct,
            gross_amount=ln.gross, capitalized_amount=ln.capitalized,
            disallowed_amount=ln.disallowed,
        ))

    # ── The reclass entry, into the existing Adjustments queue.
    if cfg and cfg.inventory_account_id:
        entry = build_reclass_entry(
            result,
            inventory_account_id=cfg.inventory_account_id,
            inventory_account_name=cfg.inventory_account_name or "Inventory",
            period_end=period_end.isoformat(),
        )
        if entry is not None:
            inserted = await replace_open_proposals(
                db, tenant_id=tenant_id, source="allocation", source_ref=str(run.id),
                period_end=period_end, entries=[entry], created_by=user_id,
            )
            if inserted:
                # Resolve the entry's REAL id rather than assuming one. The link
                # is keyed on (source, source_ref) — source_ref is the run id —
                # but storing the actual id keeps the run self-describing.
                run.proposed_entry_id = (await db.execute(
                    select(ProposedEntry.id).where(
                        ProposedEntry.source == "allocation",
                        ProposedEntry.source_ref == str(run.id),
                        ProposedEntry.period_end == period_end,
                        ProposedEntry.status == "open",
                    )
                )).scalars().first()
            else:
                # Only reachable if the entry failed the balance check, which
                # the deploy-gating test makes very unlikely — but never claim a
                # journal entry exists when none was written.
                logger.warning(
                    "allocation run %s: reclass entry was not persisted "
                    "(failed the balance check).", run.id,
                )
    else:
        logger.info(
            "allocation run %s: no inventory account configured — workpaper produced, "
            "journal entry withheld", run.id,
        )

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user_id,
        action="allocation.run_created", entity_type="alloc_run", entity_id=run.id,
        metadata={"summary": (
            f"§471(c) allocation for {period_end.isoformat()}: "
            f"{result.capitalized_total} capitalized, {result.disallowed_total} disallowed"
        )},
    )
    return run


def _with_pool_names(account_map_rows, pools):
    """Attach each mapping's pool NAME (the engine keys on names, not ids)."""
    by_id = {p.id: p.name for p in pools}
    out = []
    for m in account_map_rows:
        name = by_id.get(m.pool_id)
        if name is None:
            continue  # mapped to a retired/inactive pool — treated as unmapped
        out.append(_MappedAccount(qbo_account_id=m.qbo_account_id, pool_name=name))
    return out


class _MappedAccount:
    __slots__ = ("qbo_account_id", "pool_name")

    def __init__(self, qbo_account_id: str, pool_name: str) -> None:
        self.qbo_account_id = qbo_account_id
        self.pool_name = pool_name


# ── Serialization ─────────────────────────────────────────────────────────────

def serialize_run(run: AllocRun, lines: list[AllocRunLine] | None = None) -> dict:
    def s(v):
        return str(v) if v is not None else None

    out = {
        "id": str(run.id),
        "period_start": run.period_start.isoformat(),
        "period_end": run.period_end.isoformat(),
        "status": run.status,
        "blocked_reason": run.blocked_reason,
        "payroll_factor": s(run.payroll_factor),
        "occupancy_factor": s(run.occupancy_factor),
        "driver_basis": run.driver_basis,
        "total_expenses": s(run.total_expenses),
        "direct_total": s(run.direct_total),
        "allocated_total": s(run.allocated_total),
        "capitalized_total": s(run.capitalized_total),
        "disallowed_total": s(run.disallowed_total),
        "beginning_inventory": s(run.beginning_inventory),
        "additions_purchases": s(run.additions_purchases),
        "ending_inventory": s(run.ending_inventory),
        "cogs": s(run.cogs),
        "eligible": run.eligible,
        "has_afs": run.has_afs,
        "prepared_by": str(run.prepared_by) if run.prepared_by else None,
        "prepared_at": run.prepared_at.isoformat() if run.prepared_at else None,
        "approved_by": str(run.approved_by) if run.approved_by else None,
        "approved_at": run.approved_at.isoformat() if run.approved_at else None,
        "has_journal_entry": run.proposed_entry_id is not None,
        "created_at": run.created_at.isoformat() if run.created_at else None,
    }
    if lines is not None:
        out["lines"] = [{
            "qbo_account_id": ln.qbo_account_id,
            "account_number": ln.account_number,
            "account_name": ln.account_name,
            "pool_name": ln.pool_name,
            "treatment": ln.treatment,
            "driver": ln.driver,
            "driver_pct": s(ln.driver_pct),
            "gross_amount": s(ln.gross_amount),
            "capitalized_amount": s(ln.capitalized_amount),
            "disallowed_amount": s(ln.disallowed_amount),
        } for ln in lines]
    return out
