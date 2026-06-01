"""
Tenant data purge — the hard-delete half of the soft-delete lifecycle.

When a workspace is deleted it is first SOFT-deleted (tenant.deleted_at set,
access blocked everywhere via the tenancy middleware, QBO token revoked). After
a 30-day grace window this purge runs and PERMANENTLY removes the tenant's data:

  * every tenant-scoped table row (WHERE tenant_id = …), EXCEPT audit_log,
    which is retained for compliance (SOC 2 / legal hold);
  * the tenant's entire R2 object prefix ({tenant_id}/…);
  * the tenant row itself.

There are no DB-level foreign keys between our tables (relationships are
enforced in application code), so row-deletion order doesn't matter — but we
still iterate metadata.sorted_tables in reverse (child → parent) for tidiness
and to stay correct if FK constraints are ever introduced.

Trigger this from a daily scheduler (Fly scheduled machine / cron) via either:
  * `python -m scripts.purge_tenants` (calls purge_expired_tenants directly), or
  * POST /api/internal/purge-expired-tenants with the X-Internal-Secret header.
"""
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

import models  # noqa: F401 — ensure every model is registered on Base.metadata
from core.db.base import Base
from core.db.session import AsyncSessionLocal
from core.storage.r2 import delete_prefix
from models.tenant import Tenant

logger = logging.getLogger(__name__)

# Tenant-scoped tables we never purge. Audit logs outlive the tenant by design
# (immutable compliance record) — they keep the tenant_id but are not deleted.
_RETAIN_TABLES = {"audit_log"}

# Skip the SELECT auto-tenant-filter — the purge runs without a request-scoped
# current_tenant_id and deletes across tenants by explicit WHERE tenant_id.
_SKIP = {"skip_tenant_filter": True}


async def purge_tenant(session: AsyncSession, tenant_id: uuid.UUID) -> dict[str, int]:
    """
    Hard-delete one tenant's data within the caller's transaction.

    Returns a per-table deleted-row count (plus `_r2_objects`). The caller is
    responsible for committing — keeping the row deletes in one transaction
    means a failure rolls the whole tenant back rather than leaving it
    half-purged. (R2 deletion is not transactional; it is best-effort and
    logged.)
    """
    deleted: dict[str, int] = {}

    for table in reversed(Base.metadata.sorted_tables):
        if table.name in _RETAIN_TABLES:
            continue
        if "tenant_id" not in table.c:
            # Cross-tenant tables (e.g. `tenants`) — handled separately below.
            continue
        result = await session.execute(
            table.delete().where(table.c.tenant_id == tenant_id),
            execution_options=_SKIP,
        )
        deleted[table.name] = result.rowcount or 0

    # R2 footprint — every object is keyed under "{tenant_id}/…".
    try:
        deleted["_r2_objects"] = delete_prefix(f"{tenant_id}/")
    except Exception:
        logger.exception("R2 purge failed for tenant %s", tenant_id)
        deleted["_r2_objects"] = -1

    # Finally drop the tenant row itself (no FKs reference it, so this is safe
    # even though audit_log rows retain the tenant_id).
    await session.execute(
        delete(Tenant).where(Tenant.id == tenant_id),
        execution_options=_SKIP,
    )

    return deleted


async def purge_expired_tenants(now: datetime | None = None) -> list[dict]:
    """
    Find every soft-deleted tenant whose grace window has elapsed and purge it.

    Idempotent + safe to run repeatedly: purged tenants no longer match the
    query (their row is gone). One transaction per tenant so a single failure
    is isolated and the rest still purge. Returns a per-tenant summary.
    """
    now = now or datetime.now(UTC)
    summaries: list[dict] = []

    async with AsyncSessionLocal() as session:
        due = list((await session.execute(
            select(Tenant).where(
                Tenant.deleted_at.is_not(None),
                Tenant.purge_after.is_not(None),
                Tenant.purge_after <= now,
            ),
            execution_options=_SKIP,
        )).scalars().all())

    logger.info("Purge sweep: %d tenant(s) past their grace window.", len(due))

    for tenant in due:
        tid, name = tenant.id, tenant.name
        # Fresh session per tenant so one rollback can't poison the others.
        async with AsyncSessionLocal() as session:
            try:
                counts = await purge_tenant(session, tid)
                await session.commit()
                logger.info("Purged tenant %s (%s): %s", tid, name, counts)
                summaries.append({"tenant_id": str(tid), "ok": True, "deleted": counts})
            except Exception as exc:
                await session.rollback()
                logger.exception("Purge failed for tenant %s (%s)", tid, name)
                summaries.append({"tenant_id": str(tid), "ok": False, "error": str(exc)})

    return summaries
