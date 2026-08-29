"""Continuous close on a schedule: a workspace timezone and an hour to check.

Revision ID: 081
Revises: 080
Create Date: 2026-08-28 16:00:00.000000

Migration 080 gave Risk Radar a memory of when it looked. This gives it a
reason to look without being asked.

`tenants.timezone` is an IANA name ("America/New_York"), never a UTC offset. An
offset is wrong twice a year, and a monitoring feature that drifts an hour every
March is worse than one that never claimed a time at all. NULL means UTC, which
is what every existing workspace effectively runs on today.

`continuous_enabled` and `check_hour` sit on autopilot_configs because that row
already IS the per-workspace automation config — one row, admin-owned, with the
monthly `run_day` beside it. A second table would have bought nothing but a join
and another RLS policy to remember.

check_hour is 0–23 in the workspace's own timezone. The cron ticks hourly and
each workspace fires in its own window, so "9am" means 9am where the books are.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "081"
down_revision: str | None = "080"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column("timezone", sa.String(64), nullable=True))
    op.add_column(
        "autopilot_configs",
        sa.Column("continuous_enabled", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "autopilot_configs",
        sa.Column("check_hour", sa.Integer(), nullable=False, server_default="9"),
    )


def downgrade() -> None:
    op.drop_column("autopilot_configs", "check_hour")
    op.drop_column("autopilot_configs", "continuous_enabled")
    op.drop_column("tenants", "timezone")
