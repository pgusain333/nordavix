"""
TaskAction — overlay rows + manual tasks for the Tasks system.

Two row types in one table, disambiguated by `source_type`:

  1. OVERLAY rows attach to a derived task (e.g. a pending recon
     account). The row is keyed by (source_type, source_id, period_end)
     and carries assignee / snooze / notes / dismissed flags. The
     underlying derived task is computed live; this overlay merges in.

  2. MANUAL rows are standalone tasks with source_type='manual',
     source_id=None, and a populated subject + description. They
     don't have an underlying derived source; they're real persisted
     work items.

Unique index `ux_task_actions_overlay` enforces at most one overlay
per derived task. Manual rows skip the constraint because source_id
is NULL.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class TaskAction(TenantBase):
    __tablename__ = "task_actions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Identity of the underlying derived task. For manual tasks,
    # source_type='manual' and source_id is None.
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)
    source_id:   Mapped[str | None] = mapped_column(String(64))
    period_end:  Mapped[date | None] = mapped_column(Date)

    # Action overlay fields — all nullable.
    # Legacy single-assignee column; superseded by the split preparer/
    # reviewer fields below but kept for backward compat with rows
    # created before migration 015.
    assignee_id:  Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    snooze_until: Mapped[date | None] = mapped_column(Date)
    notes:        Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Admin-set assignments (migration 015). Intent fields — "this user
    # SHOULD prepare/review this task" — distinct from the actor stamps
    # on account_review_status which record who actually DID the work.
    assigned_preparer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    assigned_reviewer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Custom due date override (migration 015). When set, takes precedence
    # over the default `period_end + 15 days`.
    due_date:    Mapped[date | None] = mapped_column(Date)

    # Manual-task fields (NULL on overlay rows).
    subject:     Mapped[str | None] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    priority:    Mapped[str | None] = mapped_column(String(16))

    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
