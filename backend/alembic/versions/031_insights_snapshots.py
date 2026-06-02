"""Insights snapshots — persist the computed Insights overview per period.

Revision ID: 031
Revises: 030
Create Date: 2026-06-01 13:00:00.000000

Insights used to recompute (and call QBO live for AR/AP aging) on every load.
This table caches the full computed overview JSON per (tenant, period_end,
period_start) so a revisit is instant; a "Sync" action recomputes and upserts.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

from alembic import op

revision: str = "031"
down_revision: str | None = "030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "insights_snapshots",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("period_end", sa.Date, nullable=False),
        sa.Column("period_start", sa.Date, nullable=True),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    # One cached snapshot per (tenant, window). NULLS NOT DISTINCT so a
    # month-mode row (period_start present) and a no-start row stay unique.
    op.create_index(
        "ix_insights_snapshots_tenant_period",
        "insights_snapshots",
        ["tenant_id", "period_end", "period_start"],
        unique=True,
        postgresql_nulls_not_distinct=True,
    )


def downgrade() -> None:
    op.drop_index("ix_insights_snapshots_tenant_period", table_name="insights_snapshots")
    op.drop_table("insights_snapshots")
