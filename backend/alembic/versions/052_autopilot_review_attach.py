"""Close Autopilot: AI Close Review + attach-reports toggles.

Revision ID: 052
Revises: 051
Create Date: 2026-06-14 00:00:00.000000

Two new one-time-setup toggles on autopilot_configs:

  run_review      — gate (and surface) the AI reviewing-partner pass that the
                    engine already performs after flux/evidence. On by default
                    (read-only analysis), so existing rows keep current behavior.
  attach_reports  — attach the Financial Package PDF (IS/BS/CF from the synced
                    snapshot) to the digest email. Off by default.

Both NOT NULL with server defaults so existing rows backfill cleanly.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "052"
down_revision: str | None = "051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "autopilot_configs",
        sa.Column("run_review", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column(
        "autopilot_configs",
        sa.Column("attach_reports", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("autopilot_configs", "attach_reports")
    op.drop_column("autopilot_configs", "run_review")
