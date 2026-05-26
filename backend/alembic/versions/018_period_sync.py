"""Period sync metadata — caches per-period AR/AP aging + YTD net income

Revision ID: 018
Revises: 017
Create Date: 2026-05-26 10:00:00.000000

Snapshots the QBO data that doesn't live cleanly in `gl_balance_snapshots`:
the AR and AP aging totals (which feed AR/AP subledger calculations) and the
YTD Net Income off the P&L (which feeds the trial-balance check).

Together with `gl_balance_snapshots` this is everything the reconciliations
overview needs — meaning navigation (clicking month tiles, switching between
dashboards) can serve from our DB instead of hitting QBO live every time.
The explicit "Sync" button is the one place that touches QBO.

One row per (tenant, period_end). Upsert on every sync — the row's
`synced_at` doubles as a "last-known-good" timestamp for the UI.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "018"
down_revision: str | None = "017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "period_sync",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False),
        # Aging report totals at period_end. Both natural-positive
        # magnitudes (QBO returns them this way; sign handling lives in
        # the subledger derivation, not here).
        sa.Column("ar_aging_total", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("ap_aging_total", sa.Numeric(18, 2), nullable=False, server_default="0"),
        # YTD Net Income from the P&L (independent cross-check for the
        # trial-balance verification on the dashboard). Nullable because
        # the P&L pull can fail without invalidating the rest of the
        # sync (we just hide the TB check card in that case).
        sa.Column("actual_net_income", sa.Numeric(18, 2)),
        sa.Column("pl_error", sa.Text()),
        sa.Column(
            "synced_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ux_period_sync_tenant_period",
        "period_sync",
        ["tenant_id", "period_end"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ux_period_sync_tenant_period", table_name="period_sync")
    op.drop_table("period_sync")
