"""Setup for Nordavix Allocate — the three registries a run depends on.

A client can't be allocated until three things exist: its square-footage
registry, its employee classifications, and its account→pool map. This module
maintains them, seeds them from the cannabis template, and answers the question
the roster actually asks — "is this client ready to run, and if not, why?"

Effective dating is the recurring idea. Square footage and rosters change; an
already-issued workpaper must not change with them. So an update CLOSES the
current row (effective_to = the day before) and OPENS a new one rather than
mutating in place. `alloc_run` snapshots the drivers anyway, but keeping the
registries honest means a re-run of an old period reproduces it.
"""
import logging
import uuid
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.cost_allocation import (
    AllocAccountMap,
    AllocEmployee,
    AllocPayrollEntry,
    AllocPool,
    AllocSettings,
    AllocSpace,
)
from modules.cost_allocation.engine import (
    PRODUCTION_EMPLOYEE_FUNCTIONS,
    PRODUCTION_SPACE_FUNCTIONS,
)
from modules.cost_allocation.templates import DEFAULT_POOLS

logger = logging.getLogger(__name__)

# How stale a registry can get before the roster nags. Square footage that
# hasn't been confirmed in a year is the single most common weakness in an
# examined allocation, so it's surfaced as a warning rather than left implicit.
DRIVER_STALE_DAYS = 365

# The date a FIRST-TIME registry row starts from.
#
# Registries are effective-dated and every read is evaluated as-of the period
# being worked, which is normally a month that has already closed. Stamping a
# new row with today's date therefore made it invisible to the very period the
# user was setting up — they'd add square footage, and readiness would still say
# there was none. Setup silently did nothing.
#
# So the first row for a thing is "has always been true": it applies to every
# period, forward and back. Only a CHANGE to something that already exists is
# dated, because only then is there history worth preserving.
MAP_EPOCH = date(2000, 1, 1)


async def get_or_create_settings(db: AsyncSession, tenant_id: uuid.UUID) -> AllocSettings:
    cfg = (await db.execute(select(AllocSettings))).scalars().first()
    if cfg is None:
        cfg = AllocSettings(id=uuid.uuid4(), tenant_id=tenant_id)
        db.add(cfg)
        await db.flush()
    return cfg


# ── Pools ─────────────────────────────────────────────────────────────────────

async def seed_default_pools(db: AsyncSession, tenant_id: uuid.UUID) -> list[AllocPool]:
    """Create the cannabis template's pools for a client that has none.

    Idempotent by name: re-running never duplicates a pool, and never edits one
    the preparer has since tuned.
    """
    existing = {
        p.name for p in (await db.execute(select(AllocPool))).scalars().all()
    }
    created: list[AllocPool] = []
    for t in DEFAULT_POOLS:
        if t.name in existing:
            continue
        pool = AllocPool(
            id=uuid.uuid4(), tenant_id=tenant_id, name=t.name, treatment=t.treatment,
            driver=t.driver, blend_payroll_wt=t.blend_payroll_wt,
            blend_occupancy_wt=t.blend_occupancy_wt, sort_order=t.sort_order,
            notes=t.notes, active=True,
        )
        db.add(pool)
        created.append(pool)
    if created:
        await db.flush()
    return created


def serialize_pool(p: AllocPool) -> dict:
    return {
        "id": str(p.id), "name": p.name, "treatment": p.treatment, "driver": p.driver,
        "blend_payroll_wt": str(p.blend_payroll_wt) if p.blend_payroll_wt is not None else None,
        "blend_occupancy_wt": str(p.blend_occupancy_wt) if p.blend_occupancy_wt is not None else None,
        "fixed_pct": str(p.fixed_pct) if p.fixed_pct is not None else None,
        "sort_order": p.sort_order, "active": p.active, "notes": p.notes,
    }


# ── Account map (effective-dated) ─────────────────────────────────────────────

async def set_account_pool(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    qbo_account_id: str,
    pool_id: uuid.UUID,
    account_number: str | None,
    account_name: str | None,
    effective_from: date,
) -> AllocAccountMap:
    """Point an account at a pool, closing any live mapping first.

    Closing rather than mutating keeps "which pool was this account in last
    March" answerable, which is the difference between a workpaper that
    reproduces and one that merely looks plausible.
    """
    live = (await db.execute(
        select(AllocAccountMap).where(
            AllocAccountMap.qbo_account_id == qbo_account_id,
            AllocAccountMap.effective_to.is_(None),
        )
    )).scalars().first()

    if live is None:
        # First time this account has been mapped — there's no history to
        # preserve, so it applies to every period rather than only to months
        # after today. Without this, mapping an account never took effect for
        # the (already closed) period the user was working on.
        starts = MAP_EPOCH
    else:
        if live.pool_id == pool_id:
            # Same pool — refresh the denormalized labels and stop.
            live.account_number = account_number or live.account_number
            live.account_name = account_name or live.account_name
            return live
        # A real change: date it from the period being worked so the new pool
        # applies there, and close the old row the day before so the partial
        # unique index (one live row per account) still holds.
        starts = effective_from
        live.effective_to = max(starts - timedelta(days=1), live.effective_from)

    row = AllocAccountMap(
        id=uuid.uuid4(), tenant_id=tenant_id, qbo_account_id=qbo_account_id,
        account_number=account_number, account_name=account_name,
        pool_id=pool_id, effective_from=starts,
    )
    db.add(row)
    await db.flush()
    return row


# ── Registries ────────────────────────────────────────────────────────────────

def serialize_space(s: AllocSpace) -> dict:
    return {
        "id": str(s.id), "name": s.name, "function": s.function,
        "square_feet": str(s.square_feet),
        "production_pct": str(s.production_pct) if s.production_pct is not None else None,
        # What the engine will actually use, so the UI never has to re-derive it.
        "effective_production_pct": str(
            s.production_pct if s.production_pct is not None
            else (100 if s.function in PRODUCTION_SPACE_FUNCTIONS else 0)
        ),
        "effective_from": s.effective_from.isoformat(),
        "effective_to": s.effective_to.isoformat() if s.effective_to else None,
        "notes": s.notes,
    }


def serialize_employee(e: AllocEmployee) -> dict:
    return {
        "id": str(e.id), "name": e.name, "external_id": e.external_id,
        "qbo_employee_id": e.qbo_employee_id, "function": e.function,
        "department": e.department, "job_title": e.job_title,
        "production_pct": str(e.production_pct),
        "default_production_pct": str(100 if e.function in PRODUCTION_EMPLOYEE_FUNCTIONS else 0),
        "effective_from": e.effective_from.isoformat(),
        "effective_to": e.effective_to.isoformat() if e.effective_to else None,
        "active": e.active,
    }


# ── Readiness ─────────────────────────────────────────────────────────────────

async def compute_readiness(db: AsyncSession, period_end: date) -> dict:
    """Can this client be allocated for this period — and if not, what's missing?

    Backs the roster's Blocked state and the Setup checklist. Blockers stop a
    run; warnings don't, but they're the things that weaken an allocation on
    examination (chiefly stale drivers).

    Deliberately does NOT hit QuickBooks: the roster renders this for every
    client at once, and unmapped-account detection needs a live pull. The run
    itself catches unmapped accounts and blocks there.
    """
    from modules.cost_allocation.service import load_config

    pools, account_map_rows, spaces, employees = await load_config(db, period_end)
    cfg = (await db.execute(select(AllocSettings))).scalars().first()

    blockers: list[dict] = []
    warnings: list[dict] = []

    if not pools:
        blockers.append({
            "code": "no_pools",
            "message": "No cost pools configured.",
            "fix": "setup/pools",
        })
    if not account_map_rows:
        blockers.append({
            "code": "no_account_map",
            "message": "No expense accounts have been mapped to a pool.",
            "fix": "setup/accounts",
        })

    # Only require the registries the client's pools actually consume — an
    # occupancy-only client shouldn't be blocked for want of a payroll register.
    drivers_needed = {p.driver for p in pools if p.treatment == "allocated"}
    needs_occupancy = bool({"occupancy", "blended"} & drivers_needed)
    needs_payroll = bool({"payroll", "blended"} & drivers_needed)

    total_sqft = sum((s.square_feet for s in spaces), start=0)
    if needs_occupancy and (not spaces or total_sqft <= 0):
        blockers.append({
            "code": "no_square_footage",
            "message": "Occupancy-driven pools exist but no square footage is on file.",
            "fix": "setup/spaces",
        })
    if needs_payroll and not employees:
        blockers.append({
            "code": "no_employee_classifications",
            "message": "Payroll-driven pools exist but no employees are classified.",
            "fix": "setup/employees",
        })
    elif needs_payroll:
        # Classifications alone aren't enough — the factor needs this month's
        # WAGES. Checking it here keeps readiness honest: it used to report
        # "ready to run" and then the run itself blocked on missing payroll,
        # which is a confusing way to find out.
        period_start = period_end.replace(day=1)
        has_wages = (await db.execute(
            select(AllocPayrollEntry.id).where(
                AllocPayrollEntry.period_start >= period_start,
                AllocPayrollEntry.period_end <= period_end,
            ).limit(1)
        )).scalars().first()
        if has_wages is None:
            blockers.append({
                "code": "no_payroll_for_period",
                "message": (
                    f"No payroll register imported for "
                    f"{period_end.strftime('%B %Y')} — the payroll factor needs wages."
                ),
                "fix": "setup/payroll",
            })

    if cfg is None or not cfg.inventory_account_id:
        warnings.append({
            "code": "no_inventory_account",
            "message": (
                "No inventory account set — the allocation will compute and the "
                "workpaper will be produced, but the reclass journal entry is withheld."
            ),
            "fix": "setup/settings",
        })
    if cfg is not None and cfg.has_afs and cfg.method == "books_records":
        blockers.append({
            "code": "afs_method_conflict",
            "message": (
                "This client has an applicable financial statement, so §471(c) "
                "requires conforming to it — the books-and-records method doesn't apply."
            ),
            "fix": "setup/settings",
        })

    # Stale drivers: the most common weakness in an examined allocation.
    def _staleness(rows) -> int | None:
        if not rows:
            return None
        newest = max(r.effective_from for r in rows)
        return (period_end - newest).days

    for label, rows, code in (
        ("Square footage", spaces, "stale_square_footage"),
        ("Employee classifications", employees, "stale_employees"),
    ):
        age = _staleness(rows)
        if age is not None and age > DRIVER_STALE_DAYS:
            warnings.append({
                "code": code,
                "message": f"{label} last updated {age // 30} months ago — confirm it still holds.",
                "fix": "setup",
            })

    return {
        "ready": not blockers,
        "blockers": blockers,
        "warnings": warnings,
        "counts": {
            "pools": len(pools),
            "mapped_accounts": len(account_map_rows),
            "spaces": len(spaces),
            "employees": len(employees),
            "total_square_feet": str(total_sqft),
        },
        "requires": {"occupancy": needs_occupancy, "payroll": needs_payroll},
    }
