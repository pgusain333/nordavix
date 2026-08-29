"""Continuous close can email the workspace when it catches something new.

Revision ID: 082
Revises: 081
Create Date: 2026-08-29 11:00:00.000000

081 gave the watch a schedule. This gives it a voice outside the app.

Default FALSE, deliberately. An unattended daily job that starts mailing every
existing workspace the morning after a deploy is how a useful feature becomes a
filter rule. Someone has to ask for it, in the same panel where they set the
hour.

The per-USER opt-out already exists (`users.email_notifications_enabled`) and
still applies: this column decides whether the workspace sends at all, not who
receives. Both have to say yes.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "082"
down_revision: str | None = "081"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "autopilot_configs",
        sa.Column("continuous_email", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("autopilot_configs", "continuous_email")
