"""Period-sync ingest integrity: tb_balanced + tb_diff.

Revision ID: 039
Revises: 038
Create Date: 2026-06-08 14:00:00.000000

Records whether the parsed QuickBooks trial balance tied out (Σdebits =
Σcredits) on the last sync for a (tenant, period). A real QBO trial balance
always balances, so a non-zero diff means our ingest dropped/misread a cell —
the dashboard flags it and period close is blocked until a clean re-sync.
Nullable: legacy rows synced before this check keep NULL (treated as unknown).
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "039"
down_revision: str | None = "038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("period_sync", sa.Column("tb_balanced", sa.Boolean(), nullable=True))
    op.add_column("period_sync", sa.Column("tb_diff", sa.Numeric(18, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("period_sync", "tb_diff")
    op.drop_column("period_sync", "tb_balanced")
