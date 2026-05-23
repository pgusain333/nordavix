import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class AuditLog(TenantBase):
    """
    Immutable record of every user or system action.

    Required for SOC 2 Type II. Records must never be deleted or modified.
    Implement retention policy at the storage layer (e.g., archive to cold storage
    after 7 years) rather than deleting rows.

    user_id is nullable to support system-generated events (e.g., Celery tasks
    that run without a direct user request). The FK is intentionally absent so
    that deleting a user does not cascade to audit records.

    Do NOT store client financial data in metadata — audit log is who/when/what,
    not a replica of the data. metadata may contain status transitions, counts,
    or identifiers, but never account names, balances, or narrative content.
    """
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # No FK on user_id: deleted users must still appear in the audit trail
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(100))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Named `event_data` — `metadata` is reserved by SQLAlchemy's DeclarativeBase
    event_data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
