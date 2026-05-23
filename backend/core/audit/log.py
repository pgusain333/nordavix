import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from models.audit_log import AuditLog


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
    )
    session.add(entry)
    # Caller is responsible for committing the session so the audit entry
    # and the business operation are in the same transaction.
