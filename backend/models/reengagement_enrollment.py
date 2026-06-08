import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import Base
from core.db.mixins import TimestampMixin


class ReengagementEnrollment(TimestampMixin, Base):
    """
    One re-engagement (win-back) drip enrollment per human, keyed by clerk_user_id.

    Targets users who signed up but never activated (no QuickBooks connection and
    no reconciliation). They receive up to 5 feature-focused emails, one every
    3 days, and exit the moment they activate or unsubscribe.

    Cross-tenant by design — it inherits ``Base`` (not ``TenantBase``) because a
    person can belong to several tenants but must only ever be in ONE drip. The
    eligibility sweep (``modules/reengagement/service.py``) runs without a tenant
    context, so this table must not be auto-filtered by tenant_id.

    status state machine:
      * active        — in the sequence; receives the next email when due
      * activated     — connected QBO or ran a reconciliation → permanently exited
      * unsubscribed  — opted out via the email link → permanently exited
      * completed     — all 5 emails sent
      * suppressed    — manual / edge case (e.g. unusable email)

    Unsubscribe state lives here (not on ``users``): the existing
    ``User.email_notifications_enabled`` governs *transactional* email and is
    per-tenant-membership, whereas this drip is lifecycle/marketing and one per
    human. The unsubscribe endpoint is public/no-auth and resolves exactly one
    row by signed token — this is the clean write target.
    """
    __tablename__ = "reengagement_enrollment"
    __table_args__ = (
        UniqueConstraint("clerk_user_id", name="uq_reengagement_enrollment_clerk_user_id"),
        CheckConstraint(
            "status in ('active','activated','unsubscribed','completed','suppressed')",
            name="ck_reengagement_enrollment_status",
        ),
        Index("ix_reengagement_enrollment_status", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    # See class docstring for the state machine.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", server_default=text("'active'"),
    )
    # Emails already sent (0..5). The next step to send is step_sent + 1.
    step_sent: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0"),
    )
    # Cadence anchor — copied from the user's welcomed_at so the schedule is
    # stable regardless of when the enrollment row was created.
    enrolled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    unsubscribed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
