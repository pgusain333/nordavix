"""Bank statement txns — uploaded bank rec lines + match results

Revision ID: 029
Revises: 028
Create Date: 2026-05-31 14:00:00.000000

Adds the bank_statement_txns table. Stores one row per line from an
uploaded bank statement (CSV today, PDF later), with the matcher's
verdict against the period's GL: cleared (matched_gl_txn_id set),
bank_only (no GL match — needs a JE), or unmatched (transient).

Re-uploading a statement for the same (qbo_account_id, period_end)
wipes the prior rows and inserts the new batch — idempotent uploads.

Indexes scope by tenant + account + period since every match runs
within that scope.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "029"
down_revision: str | None = "028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "bank_statement_txns",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_account_id", sa.String(50), nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),

        sa.Column("txn_date",    sa.Date,            nullable=False),
        sa.Column("amount",      sa.Numeric(18, 2),  nullable=False),
        sa.Column("description", sa.String(500)),
        sa.Column("bank_ref",    sa.String(100)),

        sa.Column("match_status",       sa.String(20), nullable=False, server_default=sa.text("'unmatched'")),
        sa.Column("matched_gl_txn_id",  sa.String(50)),
        sa.Column("match_confidence",   sa.Numeric(3, 2)),

        sa.Column("statement_filename", sa.String(255)),
        sa.Column("uploaded_by",        UUID(as_uuid=True)),
        sa.Column("uploaded_at",        sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),

        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_bank_statement_txns_tenant", "bank_statement_txns", ["tenant_id"])
    op.create_index(
        "ix_bank_statement_txns_scope",
        "bank_statement_txns",
        ["tenant_id", "qbo_account_id", "period_end"],
    )


def downgrade() -> None:
    op.drop_index("ix_bank_statement_txns_scope", table_name="bank_statement_txns")
    op.drop_index("ix_bank_statement_txns_tenant", table_name="bank_statement_txns")
    op.drop_table("bank_statement_txns")
