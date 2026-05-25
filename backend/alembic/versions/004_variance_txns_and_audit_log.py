"""Variance transactions + audit_log index helper

Revision ID: 004
Revises: 003
Create Date: 2026-05-24 22:00:00.000000

Adds:
- accounts.qbo_account_id: stable QBO ref so we can pull per-account
  transactions on demand (used by the variance drill-down).
- variance_transactions: per-variance evidence rows pulled from QBO on
  click. Each row carries a check/approval flag so the reviewer can tick
  them off as they investigate.
- ix_audit_log_entity: composite index on (entity_type, entity_id) so the
  activity-feed-per-entity query is fast. The audit_log table itself
  already exists from migration 001.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Stable QBO reference on accounts so we can drill into transactions
    op.add_column("accounts", sa.Column("qbo_account_id", sa.String(50), nullable=True))
    op.create_index("ix_accounts_qbo_account_id", "accounts", ["qbo_account_id"])

    # Variance transactions: evidence rows for a specific variance
    op.create_table(
        "variance_transactions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("variance_id", UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_txn_id", sa.String(50)),
        sa.Column("txn_type", sa.String(50), nullable=False),
        sa.Column("txn_number", sa.String(100)),
        sa.Column("txn_date", sa.Date),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("memo", sa.String(500)),
        # Customer / vendor / counterparty name where applicable
        sa.Column("entity_name", sa.String(255)),
        # Reviewer-controlled "this transaction has been checked/approved"
        sa.Column("is_checked", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("checked_by", UUID(as_uuid=True)),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variance_id"], ["variances.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_variance_transactions_tenant_id", "variance_transactions", ["tenant_id"])
    op.create_index("ix_variance_transactions_variance_id", "variance_transactions", ["variance_id"])

    # Speed up "show me all activity on entity X" queries against the
    # existing audit_log table.
    op.create_index("ix_audit_log_entity", "audit_log", ["entity_type", "entity_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_log_entity", table_name="audit_log")
    op.drop_table("variance_transactions")
    op.drop_index("ix_accounts_qbo_account_id", table_name="accounts")
    op.drop_column("accounts", "qbo_account_id")
