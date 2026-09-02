"""Let a new check time take effect today, not tomorrow.

Revision ID: 087
Revises: 086
Create Date: 2026-09-01 18:00:00.000000

Continuous close runs at most once a day, guarded by "has the schedule already
completed a check today". That guard is what makes the hourly sweep idempotent
and it is right — but it had no idea when the schedule itself last changed.

So: move the daily check from 10:00 to 14:00 at lunchtime, and the 10:00 run
has already happened. At 14:00 the guard reads "checked today" and skips. The
setting the user just chose does nothing until tomorrow, and nothing on screen
explains the delay, because from the outside it is indistinguishable from the
feature not working.

`schedule_changed_at` records when the WHEN last changed — the hour or the
timezone, not the other toggles. Scheduled checks older than it stop counting
against the current schedule. They stay in the run history; they simply stop
answering a question about a schedule that did not exist when they ran.

NULL for every existing row, which reads as "never changed" and leaves today's
behaviour exactly as it is until someone edits their time.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "087"
down_revision: str | None = "086"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "autopilot_configs",
        sa.Column("schedule_changed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("autopilot_configs", "schedule_changed_at")
