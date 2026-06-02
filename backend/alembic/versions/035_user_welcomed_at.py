"""Track first-sign-in welcome email.

Revision ID: 035
Revises: 034
Create Date: 2026-06-02 12:00:00.000000

`welcomed_at` is set the first time a user hits /api/workspace/me. Null means
they've never been welcomed; once set we never send the welcome email again.
Plain nullable timestamp — no Postgres-version-specific features.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "035"
down_revision: str | None = "034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("welcomed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "welcomed_at")
