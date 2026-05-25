"""GL balance snapshots for internal-source financial statements

Revision ID: 017
Revises: 016
Create Date: 2026-05-26 09:00:00.000000

Captures every account's GL balance at a given period_end, persisted
to our DB on every reconciliations sync. Powers the Financial
Package's "Nordavix synced" source — lets the Balance Sheet,
Income Statement, and (eventually) Cash Flow render from our own
data rather than calling QBO reports live on every render.

One row per (tenant, qbo_account_id, period_end). Upsert on conflict
(same account + period gets the latest value). The balance is
stored signed (debit-positive, credit-negative) just like QBO's
TrialBalance returns it.

For P&L accounts: the snapshot captures YTD activity (the TB query
uses start_date=Jan 1 of the period_end's calendar year). For BS
accounts: it captures the end-of-period balance. Both behaviors come
"for free" from QBO's TrialBalance behavior.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "017"
down_revision: str | None = "016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "gl_balance_snapshots",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("qbo_account_id", sa.String(50), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        # Account metadata — denormalized so reads don't need a QBO call
        sa.Column("account_number", sa.String(50)),
        sa.Column("account_name",   sa.String(255), nullable=False),
        sa.Column("account_type",   sa.String(50),  nullable=False),
        # Signed balance: debits positive, credits negative.
        sa.Column("balance", sa.Numeric(18, 2), nullable=False),
        sa.Column(
            "captured_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ux_gl_snapshot_acct_period",
        "gl_balance_snapshots",
        ["tenant_id", "qbo_account_id", "period_end"],
        unique=True,
    )
    op.create_index(
        "ix_gl_snapshot_period",
        "gl_balance_snapshots",
        ["tenant_id", "period_end"],
    )


def downgrade() -> None:
    op.drop_index("ix_gl_snapshot_period",    table_name="gl_balance_snapshots")
    op.drop_index("ux_gl_snapshot_acct_period", table_name="gl_balance_snapshots")
    op.drop_table("gl_balance_snapshots")
