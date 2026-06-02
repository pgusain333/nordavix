"""Per-user email-notification opt-out.

Revision ID: 034
Revises: 033
Create Date: 2026-06-02 11:05:00.000000

Adds users.email_notifications_enabled (default true). Gates transactional
notification emails per user; toggled in Settings. Server default keeps every
existing row opted in.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "034"
down_revision: str | None = "033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "email_notifications_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "email_notifications_enabled")
