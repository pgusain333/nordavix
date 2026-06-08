"""Bank statement header (control totals + GL cache).

Revision ID: 038
Revises: 037
Create Date: 2026-06-08 13:00:00.000000

One row per (tenant_id, qbo_account_id, period_end) bank / credit-card
reconciliation. Holds the statement's parsed opening/ending balance + the
cross-foot tie-out result, plus a cached copy of the period's GL transactions
so the auto-match worksheet doesn't re-pull QBO on every open. Complements
bank_statement_txns (the parsed statement lines).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "038"
down_revision: str | None = "037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "bank_statements",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_account_id", sa.String(length=50), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("statement_filename", sa.String(length=255), nullable=True),
        sa.Column("opening_balance", sa.Numeric(18, 2), nullable=True),
        sa.Column("ending_balance", sa.Numeric(18, 2), nullable=True),
        sa.Column("line_sum", sa.Numeric(18, 2), nullable=True),
        sa.Column("tie_out_ok", sa.Boolean(), nullable=True),
        sa.Column("tie_out_diff", sa.Numeric(18, 2), nullable=True),
        sa.Column(
            "gl_txns_cache",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("gl_refreshed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id", "qbo_account_id", "period_end",
            name="uq_bank_statement_acct_period",
        ),
    )
    op.create_index("ix_bank_statements_tenant_id", "bank_statements", ["tenant_id"])
    op.create_index("ix_bank_statements_qbo_account_id", "bank_statements", ["qbo_account_id"])
    op.create_index("ix_bank_statements_period_end", "bank_statements", ["period_end"])


def downgrade() -> None:
    op.drop_index("ix_bank_statements_period_end", table_name="bank_statements")
    op.drop_index("ix_bank_statements_qbo_account_id", table_name="bank_statements")
    op.drop_index("ix_bank_statements_tenant_id", table_name="bank_statements")
    op.drop_table("bank_statements")
