"""
ClosedPeriod — one row per (tenant_id, period_end) currently closed.

When a row exists, that tenant's reconciliations for that period are
read-only for everyone except admins (who can re-open). Re-opening
deletes the row; both close and reopen are audit-logged for history.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class ClosedPeriod(TenantBase):
    __tablename__ = "closed_periods"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    closed_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    closed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    notes: Mapped[str | None] = mapped_column(Text)
