"""Task assignments (preparer + reviewer) + custom due dates

Revision ID: 015
Revises: 014
Create Date: 2026-05-25 17:00:00.000000

Admins can now assign a preparer AND a reviewer per task, plus
override the auto-computed due date (which defaults to period_end
+ 15 days). All three fields live on the overlay row in
`task_actions` — they're intent ("this person SHOULD prepare it")
not actor ("this person DID prepare it"). The actor stamps stay
on `account_review_status.prepared_by/_at` and `approved_by/_at`
(migration 014).

The old single `assignee_id` column stays for backward compatibility
but is no longer written or read by the UI. Manual tasks created
before this migration still surface their assignee via that column,
which is fine — assigning via the new preparer/reviewer fields
overrides it on next write.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "015"
down_revision: str | None = "014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("task_actions", sa.Column("assigned_preparer_id", UUID(as_uuid=True), nullable=True))
    op.add_column("task_actions", sa.Column("assigned_reviewer_id", UUID(as_uuid=True), nullable=True))
    # Custom due date — when set, overrides the auto-computed default.
    op.add_column("task_actions", sa.Column("due_date", sa.Date(), nullable=True))

    op.create_index(
        "ix_task_actions_assigned_preparer",
        "task_actions",
        ["tenant_id", "assigned_preparer_id"],
    )
    op.create_index(
        "ix_task_actions_assigned_reviewer",
        "task_actions",
        ["tenant_id", "assigned_reviewer_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_task_actions_assigned_reviewer", table_name="task_actions")
    op.drop_index("ix_task_actions_assigned_preparer", table_name="task_actions")
    op.drop_column("task_actions", "due_date")
    op.drop_column("task_actions", "assigned_reviewer_id")
    op.drop_column("task_actions", "assigned_preparer_id")
