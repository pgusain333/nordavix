"""
Close Management workflow — the milestone checklist that sits ABOVE the
granular Tasks list.

Two tables:

  1. CloseTemplateStep — the reusable, per-tenant definition of one close
     step (e.g. "Reconcile balance-sheet accounts"). Seeded with a sensible
     default checklist on first use; the firm can add / edit / reorder /
     deactivate steps per client. Keyed by a stable `key` slug so instances
     never orphan when a step is edited or removed.

  2. CloseStepInstance — one row per (period_end, step) capturing that
     period's state: who owns it, when it's due, whether it's done, notes.
     Display fields are snapshotted at generation so a later template edit
     doesn't rewrite a period already in flight (and keeps cycle-time
     analytics stable). For LINKED steps (recon / flux / schedule / sync /
     close) the live status is computed from the underlying module at read
     time; the row still records completed_at the first time it's observed
     done, for analytics.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class CloseTemplateStep(TenantBase):
    __tablename__ = "close_template_steps"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Stable slug, unique per tenant. Default steps use fixed keys
    # ('sync','recon',…); custom steps get a generated slug. Instances
    # reference this, so editing/removing a step never orphans history.
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    # 'sync'|'recon'|'schedule'|'adjustments'|'flux'|'financials'|'review'|'close'|'custom'
    category: Mapped[str] = mapped_column(String(24), nullable=False, default="custom")
    # When set, the step's status is auto-derived from that module's state for
    # the period: 'sync'|'recon'|'schedule'|'flux'|'close'. NULL = manual step.
    linked_module: Mapped[str | None] = mapped_column(String(24))
    # Days after period_end the step is due (drives the default due_date).
    due_offset_days: Mapped[int | None] = mapped_column(Integer)
    # 'preparer'|'reviewer'|'admin' — a hint for who usually owns it. Optional.
    default_assignee_role: Mapped[str | None] = mapped_column(String(16))
    is_active: Mapped[bool] = mapped_column(nullable=False, default=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("tenant_id", "key", name="uq_close_template_steps_tenant_key"),
    )


class CloseStepInstance(TenantBase):
    __tablename__ = "close_step_instances"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # Stable link back to the template step (by slug, tenant-scoped) so this
    # row survives template edits/removals.
    step_key: Mapped[str] = mapped_column(String(64), nullable=False)

    # Snapshot of the step at generation time (stable for this period).
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(24), nullable=False, default="custom")
    linked_module: Mapped[str | None] = mapped_column(String(24))

    # 'pending' | 'in_progress' | 'done' | 'skipped'. Authoritative for manual
    # steps; for linked steps the live module status overlays this on read.
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    due_date: Mapped[date | None] = mapped_column(Date)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("tenant_id", "period_end", "step_key",
                         name="uq_close_step_instances_tenant_period_step"),
    )
