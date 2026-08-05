import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.chain import compute_row_hash
from models.audit_log import AuditLog

logger = logging.getLogger(__name__)


async def write_audit_event(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID | None,
    action: str,
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """
    Record a user or system action to the audit log.

    Required for future SOC 2 compliance. Every action that modifies data
    or triggers AI generation should be logged here.

    Do NOT include client data (balances, account names) in metadata —
    the audit log is for who-did-what, not what-was-in-the-data.

    Args:
        action: Verb describing the action, e.g. "trial_balance.upload",
                "narrative.approve", "narrative.edit", "flux.run"
        entity_type: The resource type affected, e.g. "trial_balance", "narrative"
        entity_id: The primary key of the affected record
        metadata: Non-PII context, e.g. {"status_before": "pending", "status_after": "approved"}
    """
    entry = AuditLog(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        event_data=metadata or {},
        # Set in PYTHON, not by the server default: created_at is part of the
        # hashed content, so it has to exist before the row is hashed and be the
        # exact value that lands in the column.
        created_at=datetime.now(UTC),
    )

    await _chain(session, entry)

    session.add(entry)
    # Caller is responsible for committing the session so the audit entry
    # and the business operation are in the same transaction.


async def _chain(session: AsyncSession, entry: AuditLog) -> None:
    """Link this row onto the tenant's chain. See core/audit/chain.py.

    Serialized per tenant by a transaction-scoped advisory lock. Without it two
    concurrent requests could read the same tail and both link to it, forking
    the chain — which the verifier would (correctly) report as a break, turning
    a race into a false tamper alarm. The lock is per tenant and there is only
    ever one, so it can't deadlock; audit volume per tenant is human-paced, so
    the serialization costs nothing real.

    Never fatal. A hash is computed over data that is already validated, so
    failure here is close to impossible — but an audit-log implementation
    detail must not be able to fail a user's actual work. On error the row is
    written unhashed and the verifier reports it as unchained, which is visible
    rather than silent.
    """
    try:
        # hashtext() is int4; pg_advisory_xact_lock widens it. A collision
        # between two tenants only means they briefly serialize — harmless.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
            {"k": f"audit-chain:{entry.tenant_id}"},
        )

        # The tenant's current head. Explicit tenant filter AND skip the
        # automatic one so this also works in system contexts that carry no
        # request tenant (Celery tasks) — same scoping, no reliance on context.
        prev_hash = (await session.execute(
            select(AuditLog.row_hash)
            .where(AuditLog.tenant_id == entry.tenant_id, AuditLog.row_hash.isnot(None))
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(1)
            .execution_options(skip_tenant_filter=True)
        )).scalars().first()

        entry.prev_hash = prev_hash
        entry.row_hash = compute_row_hash(
            prev_hash=prev_hash,
            row_id=entry.id,
            tenant_id=entry.tenant_id,
            user_id=entry.user_id,
            action=entry.action,
            entity_type=entry.entity_type,
            entity_id=entry.entity_id,
            event_data=entry.event_data,
            created_at=entry.created_at,
        )
        # Flush so a second audit event in this same transaction chains onto
        # this one rather than onto the row before it.
        session.add(entry)
        await session.flush()
    except Exception:
        logger.exception(
            "Could not hash-chain an audit row (action=%s). Writing it unchained; "
            "the integrity check will report it as such.", entry.action,
        )
