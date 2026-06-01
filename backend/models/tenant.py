import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import Base
from core.db.mixins import TimestampMixin


class Tenant(TimestampMixin, Base):
    """
    Represents one accounting firm or company using Nordavix.

    Inherits from Base (not TenantBase) because this table IS the tenant —
    it is not scoped by tenant_id. All other tables reference this via FK.
    """
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # clerk_org_id is the join key between Clerk's auth system and our tenant table
    clerk_org_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    # Flexible settings blob: materiality defaults, account range overrides, branding, etc.
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    # First period the company reconciles against. Reconciliations may not
    # reference period_end < this date. Seeded openings live at
    # period_end = books_start_date - 1 day on AccountReviewStatus.
    # Null until onboarding is complete. Locked after seeding (admin only).
    books_start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    books_seeded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # ── Soft-delete lifecycle ───────────────────────────────────────────────
    # "Delete company" sets deleted_at (immediately blocking all access and
    # revoking the QBO token) and purge_after = deleted_at + 30 days. A
    # scheduled purge job hard-deletes the tenant's data once purge_after
    # passes; until then the deletion is recoverable. Audit logs are archived,
    # not purged. deleted_by is the Clerk user id that initiated the deletion.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    purge_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
