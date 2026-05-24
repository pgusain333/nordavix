"""Account-level reconciliation review status

Revision ID: 005
Revises: 004
Create Date: 2026-05-24 23:00:00.000000

Per-account, per-period review state. The Reconciliations dashboard is
LIVE (pulled from QBO each time), so we need a small persistence layer
just for the workflow:

  - status: pending / reviewed / approved / flagged
  - reviewed_by + reviewed_at: who clicked the button + when
  - notes: free-text per (account, period)

Keyed by (tenant_id, qbo_account_id, period_end). Unique so the same
account+period can only have one status row at a time.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "account_review_status",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_account_id", sa.String(50), nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),
        # pending | reviewed | approved | flagged
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("reviewed_by", UUID(as_uuid=True)),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("notes", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_account_review_status_tenant_id", "account_review_status", ["tenant_id"])
    op.create_unique_constraint(
        "uq_account_review_status_tenant_acct_period",
        "account_review_status",
        ["tenant_id", "qbo_account_id", "period_end"],
    )


def downgrade() -> None:
    op.drop_table("account_review_status")
