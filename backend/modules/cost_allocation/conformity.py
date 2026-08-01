"""Book conformity — proving the ledger reflects the method being claimed.

§471(c)(1)(B)(ii) lets a small business taxpayer inventory costs per its books
and records "as prepared in accordance with the taxpayer's accounting
procedures". Two things follow, and neither is optional:

  1. The BOOKS have to show it. A reclass entry that is computed, exported and
     never posted leaves the general ledger showing ordinary expense while the
     return claims COGS. The allocation can be immaculate and the position
     still fails, because the method is defined by what the books do.

  2. There have to BE accounting procedures. The statute conditions the method
     on the taxpayer's own written procedures, so "the pools we happened to
     configure" is not enough — the policy has to exist as a document, state
     what it does, and be dated and signed.

This module covers both: a posting check that looks for the entry in
QuickBooks, and a generated procedures memo built from the client's actual
configuration so the document and the computation can never drift apart.
"""
import logging
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.cost_allocation import (
    AllocEmployee,
    AllocPool,
    AllocRun,
    AllocSettings,
    AllocSpace,
)
from models.proposed_entry import ProposedEntry
from models.qbo_connection import QboConnection
from modules.adjustments.service import match_entry_to_qbo

logger = logging.getLogger(__name__)


async def check_posting(db: AsyncSession, run: AllocRun) -> dict:
    """Look for this run's reclass entry in QuickBooks.

    Matching is by SIGNATURE — account, posting side and amount for every line —
    rather than by any id we control, because the user may retype the entry by
    hand instead of importing the CSV. What matters is that the books say the
    right thing, not that they say it through our file.

    A failure to reach QuickBooks is reported as unchecked, never as unposted:
    "we couldn't look" and "it isn't there" are different facts and only one of
    them is a problem with the client's books.
    """
    from modules.recons.service import fetch_posted_journal_entries
    from modules.schedules.calc import _period_bounds

    entry = (await db.execute(
        select(ProposedEntry).where(
            ProposedEntry.source == "allocation",
            ProposedEntry.source_ref == str(run.id),
        ).order_by(ProposedEntry.created_at.desc())
    )).scalars().first()

    if entry is None:
        return {
            "checked": False, "posted": False, "doc_number": None,
            "reason": "This run produced no journal entry, so there is nothing to post.",
        }

    conn = (await db.execute(select(QboConnection))).scalars().first()
    if conn is None:
        return {
            "checked": False, "posted": False, "doc_number": None,
            "reason": "QuickBooks isn't connected, so the books can't be verified.",
        }

    start, end = _period_bounds(run.period_end)
    try:
        qbo_jes = await fetch_posted_journal_entries(conn, db, start=start, end=end)
    except Exception:
        logger.exception("posting check: QBO journal-entry fetch failed for run %s", run.id)
        return {
            "checked": False, "posted": False, "doc_number": None,
            "reason": "Couldn't read journal entries from QuickBooks. Try again.",
        }

    doc = match_entry_to_qbo(entry, qbo_jes)
    now = datetime.now(UTC)
    run.posting_checked_at = now
    if doc is not None:
        run.posted_at = run.posted_at or now
        run.posted_doc_number = doc
    else:
        # Deliberately NOT cleared: an entry that posted and was later deleted
        # should surface as a discrepancy, not silently revert to "never posted".
        pass

    return {
        "checked": True,
        "posted": doc is not None,
        "doc_number": doc,
        "reason": None if doc is not None else (
            "The reclass entry hasn't been posted to QuickBooks yet. Until it is, "
            "the ledger shows ordinary expense while the allocation claims COGS — "
            "§471(c) is a books-and-records method, so the books have to agree."
        ),
    }


# ── The accounting procedures memo ────────────────────────────────────────────

_DRIVER_PROSE = {
    "payroll": "apportioned on production wages as a share of total wages",
    "occupancy": "apportioned on production square footage as a share of total square footage",
    "blended": "apportioned on a weighted blend of the payroll and occupancy factors",
    "fixed": "apportioned at a fixed rate",
}


async def build_procedures_memo(
    db: AsyncSession, *, client_name: str, as_of: date,
) -> dict:
    """The client's written accounting procedures, generated from live config.

    Generated rather than hand-written on purpose: a policy document that is
    typed separately from the system that computes the numbers will drift from
    it, and the drift is invisible until someone reads both. Building the memo
    from the same rows the engine uses means the document is true by
    construction on the day it's produced.
    """
    cfg = (await db.execute(select(AllocSettings))).scalars().first()
    pools = (await db.execute(
        select(AllocPool).where(AllocPool.active.is_(True))
        .order_by(AllocPool.sort_order, AllocPool.name)
    )).scalars().all()
    spaces = (await db.execute(
        select(AllocSpace).where(AllocSpace.effective_to.is_(None)).order_by(AllocSpace.name)
    )).scalars().all()
    employees = (await db.execute(
        select(AllocEmployee).where(AllocEmployee.active.is_(True))
    )).scalars().all()

    total_sqft = sum((s.square_feet for s in spaces), start=0)
    production_sqft = sum(
        (
            s.square_feet * (
                s.production_pct if s.production_pct is not None
                else (100 if s.function in {"cultivation", "processing", "curing", "packaging"} else 0)
            ) / 100
            for s in spaces
        ),
        start=0,
    )
    split_staff = [e for e in employees if 0 < float(e.production_pct or 0) < 100]

    method = (cfg.method if cfg else "books_records")
    lines: list[str] = []
    add = lines.append

    add(f"# Inventory costing procedures — {client_name}")
    add("")
    add(f"Adopted under IRC section 471(c). Prepared as of {as_of.isoformat()}.")
    add("")
    add("## 1. Method")
    add("")
    if method == "afs":
        add(
            "The taxpayer maintains an applicable financial statement and inventories "
            "costs in the manner used in that statement, per section 471(c)(1)(B)(i)."
        )
    else:
        add(
            "The taxpayer does not maintain an applicable financial statement and "
            "inventories costs in accordance with these written accounting procedures, "
            "as reflected in its books and records, per section 471(c)(1)(B)(ii)."
        )
    add("")
    add(
        "Costs determined to be inventoriable under these procedures are recorded to "
        "cost of goods sold accounts in the general ledger each month. Each such "
        'account is named "Other COGS - " followed by the originating expense account, '
        "so the origin of every cost of goods sold balance is identifiable on the face "
        "of the trial balance."
    )
    add("")
    add("## 2. Cost pools")
    add("")
    add("Every expense account is assigned to exactly one pool. The pools are:")
    add("")
    for p in pools:
        if p.treatment == "direct":
            how = "treated as directly attributable to production and fully inventoriable"
        elif p.treatment == "excluded":
            how = "treated as non-production and not inventoriable"
        else:
            how = _DRIVER_PROSE.get(p.driver or "", "apportioned")
            if p.driver == "blended":
                how += f" ({p.blend_payroll_wt}% payroll / {p.blend_occupancy_wt}% occupancy)"
            elif p.driver == "fixed":
                how += f" of {p.fixed_pct}%"
        add(f"- **{p.name}** — {how}.")
    add("")
    add("## 3. Allocation factors")
    add("")
    add(
        "**Occupancy.** Production square footage divided by total square footage, "
        "measured from the facility schedule maintained by the taxpayer. Areas serving "
        "both production and non-production activity carry a stated production "
        "percentage rather than being assigned wholly to either."
    )
    add("")
    if total_sqft:
        add(
            f"As of this date: {production_sqft:,.0f} production square feet of "
            f"{total_sqft:,.0f} total, across {len(spaces)} recorded areas."
        )
        add("")
    add(
        "**Payroll.** Production labor cost divided by total labor cost, taken from the "
        "payroll register for the period. Labor cost comprises gross wages, employer "
        "payroll taxes and employer-paid benefits, applied consistently to both the "
        "numerator and the denominator. Each employee carries a stated production "
        "percentage; employees working across both production and non-production "
        "activities are recorded at a partial percentage rather than being assigned "
        "wholly to either."
    )
    add("")
    if employees:
        add(
            f"As of this date: {len(employees)} employees are classified, of which "
            f"{len(split_staff)} "
            f"{'carries' if len(split_staff) == 1 else 'carry'} a partial "
            "production percentage."
        )
        add("")
    add("## 4. Transaction-level determinations")
    add("")
    add(
        "Where individual general ledger entries within an allocated account are "
        "identified as wholly or partly attributable to production, those entries are "
        "recorded at their determined percentage and only the remaining balance of the "
        "account is apportioned using the pool factor. Such determinations are made "
        "for a specific period and do not carry forward."
    )
    add("")
    add("## 5. Consistency and records")
    add("")
    add(
        "Pool assignments, facility measurements and employee classifications are "
        "effective-dated. A change applies from the period in which it is made and "
        "does not restate prior periods. Each monthly allocation retains the factors "
        "and assignments applied at the time it was prepared, so a prior period "
        "reproduces as issued."
    )
    add("")
    add(
        "Each monthly allocation is prepared by one person and approved by another "
        "before the corresponding journal entry is recorded."
    )
    add("")
    add("## 6. Approval")
    add("")
    add("Prepared by: ______________________________  Date: ______________")
    add("")
    add("Approved by: ______________________________  Date: ______________")
    add("")

    return {
        "client_name": client_name,
        "as_of": as_of.isoformat(),
        "method": method,
        "markdown": "\n".join(lines),
        "pool_count": len(pools),
        "space_count": len(spaces),
        "employee_count": len(employees),
    }
