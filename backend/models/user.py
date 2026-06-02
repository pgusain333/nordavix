import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase
from core.db.mixins import TimestampMixin


class User(TimestampMixin, TenantBase):
    """
    A Clerk user provisioned within a tenant.

    The same Clerk identity (clerk_user_id) can belong to multiple
    tenants — each membership is its own User row with its own role.
    Uniqueness is enforced on the composite (clerk_user_id, tenant_id)
    via migration 022; a plain non-unique index on clerk_user_id stays
    for the few lookup paths that filter by user alone (Clerk webhooks,
    admin tools). See migration 022 for the rationale: the single-
    column unique constraint blocked multi-workspace founders from
    ever appearing as admin in a second workspace.

    Roles in v1: "admin" | "reviewer" | "preparer" (enforced at the
    application layer via core.auth.dependencies.require_role).
    """
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("clerk_user_id", "tenant_id", name="uq_users_clerk_user_id_tenant_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    # role: "admin" | "reviewer" | "preparer" — enforced at the application layer
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="preparer")
    # Per-user opt-out for transactional notification emails (mentions,
    # assignments, review-ready, closes). Default on; toggled in Settings.
    email_notifications_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true"),
    )
    # Set the first time the user reaches /workspace/me — gates the one-time
    # welcome email so we never send it twice.
    welcomed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
