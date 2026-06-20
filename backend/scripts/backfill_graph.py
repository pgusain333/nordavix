"""
Backfill the accounting knowledge graph from existing data (idempotent).

Creates the same edges the live dual-write hooks now produce, for rows that
predate them:
  * each GlAccuracyFinding      -> found_on account, part_of period
  * each committed ScheduleSnapshot -> supports the account's reconciliation
    (the schedule = its subledger)

Safe to run repeatedly: core.graph.link() is find-or-create, so re-running never
duplicates an edge. Run once after deploying the graph foundation.

    cd backend
    python -m scripts.backfill_graph                 # all tenants
    python -m scripts.backfill_graph <tenant_uuid>   # a single tenant
"""
import asyncio
import sys
import uuid

from sqlalchemy import select

from core.db.base import tenant_scope
from core.db.session import AsyncSessionLocal
from core.graph import Node, link
from models.gl_accuracy_finding import GlAccuracyFinding
from models.schedule import ScheduleSnapshot
from models.tenant import Tenant


async def backfill_tenant(db, tenant_id: uuid.UUID) -> dict:
    """Build all graph edges for one tenant's existing findings + committed
    schedule snapshots. Reads are tenant-scoped (auto-filter) and link() is
    idempotent. Commits once at the end."""
    edges = 0
    with tenant_scope(tenant_id):
        findings = (await db.execute(select(GlAccuracyFinding))).scalars().all()
        for f in findings:
            await link(
                db, Node("finding", f.finding_key), "part_of",
                Node("period", f.period_end.isoformat()), origin="backfill",
            )
            edges += 1
            if f.posted_account_id:
                await link(
                    db, Node("finding", f.finding_key), "found_on",
                    Node("account", str(f.posted_account_id)), origin="backfill",
                )
                edges += 1

        snaps = (await db.execute(
            select(ScheduleSnapshot).where(ScheduleSnapshot.status == "committed")
        )).scalars().all()
        for s in snaps:
            await link(
                db,
                Node("schedule", f"{s.schedule_type}:{s.qbo_account_id}:{s.period_end.isoformat()}"),
                "supports",
                Node("reconciliation", f"{s.qbo_account_id}:{s.period_end.isoformat()}"),
                origin="backfill",
            )
            edges += 1

    await db.commit()
    return {"tenant_id": str(tenant_id), "edges": edges,
            "findings": len(findings), "snapshots": len(snaps)}


async def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    async with AsyncSessionLocal() as db:
        if arg:
            tenant_ids = [uuid.UUID(arg)]
        else:
            tenant_ids = list((await db.execute(select(Tenant.id))).scalars().all())

        total = 0
        for tid in tenant_ids:
            res = await backfill_tenant(db, tid)
            total += res["edges"]
            print(  # noqa: T201 — CLI progress output
                f"tenant {res['tenant_id']}: {res['edges']} edges "
                f"({res['findings']} findings, {res['snapshots']} snapshots)"
            )
        print(f"done: {total} edges across {len(tenant_ids)} tenant(s)")  # noqa: T201


if __name__ == "__main__":
    asyncio.run(main())
