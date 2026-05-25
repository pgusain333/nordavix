"""Task action overlays + manual tasks

Revision ID: 013
Revises: 012
Create Date: 2026-05-25 14:00:00.000000

The Tasks system layers a small per-tenant table on top of the
derived task list (which is computed live from existing data —
pending/flagged recon accounts, sync gaps, etc.).

This table stores TWO kinds of rows:

  1. ACTION OVERLAYS on derived tasks — for an open pending recon
     account, the user can assign it, snooze it, add notes, or
     mark it dismissed. The row is keyed by
        (source_type, source_id, period_end)
     and merged into the derived list at read time.

  2. MANUAL tasks — for ad-hoc work that doesn't come from a
     derived source. These rows have source_type='manual' and
     a populated subject/description, with source_id NULL.

A single table for both — simpler than two — disambiguated by
source_type. Unique index on (tenant_id, source_type, source_id,
period_end) means there's at most one overlay per derived task.
Manual tasks aren't constrained by the unique index because
source_id is NULL (Postgres treats NULL as distinct).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "013"
down_revision: str | None = "012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "task_actions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),

        # Identity of the underlying derived task. For manual tasks,
        # source_type='manual' and source_id is NULL.
        sa.Column("source_type", sa.String(32), nullable=False),
        sa.Column("source_id",   sa.String(64), nullable=True),
        sa.Column("period_end",  sa.Date(),     nullable=True),

        # Action overlay fields — all nullable, all optional.
        sa.Column("assignee_id",  UUID(as_uuid=True), nullable=True),
        sa.Column("snooze_until", sa.Date(),          nullable=True),
        sa.Column("notes",        sa.Text(),          nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),

        # Manual-task fields (NULL on overlay rows for derived tasks).
        sa.Column("subject",     sa.String(200), nullable=True),
        sa.Column("description", sa.Text(),      nullable=True),
        sa.Column("priority",    sa.String(16),  nullable=True),

        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
    )
    # One overlay per derived task. Skipped for manual rows because
    # source_id is NULL there and Postgres considers NULLs distinct.
    op.create_index(
        "ux_task_actions_overlay",
        "task_actions",
        ["tenant_id", "source_type", "source_id", "period_end"],
        unique=True,
        postgresql_where=sa.text("source_type <> 'manual'"),
    )
    op.create_index(
        "ix_task_actions_assignee",
        "task_actions",
        ["tenant_id", "assignee_id"],
    )
    op.create_index(
        "ix_task_actions_period",
        "task_actions",
        ["tenant_id", "period_end"],
    )


def downgrade() -> None:
    op.drop_index("ix_task_actions_period",   table_name="task_actions")
    op.drop_index("ix_task_actions_assignee", table_name="task_actions")
    op.drop_index("ux_task_actions_overlay",  table_name="task_actions")
    op.drop_table("task_actions")
