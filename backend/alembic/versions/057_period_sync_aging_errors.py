"""period_sync: ar_error / ap_error columns

Revision ID: 057
Revises: 056
Create Date: 2026-06-16 00:00:00.000000

Surface AR/AP aging-pull failures on sync instead of silently persisting $0
(which reads as a real zero subledger). Mirrors the existing pl_error column —
nullable Text, null means the pull succeeded.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "057"
down_revision: str | None = "056"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("period_sync", sa.Column("ar_error", sa.Text(), nullable=True))
    op.add_column("period_sync", sa.Column("ap_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("period_sync", "ap_error")
    op.drop_column("period_sync", "ar_error")
