"""Closed (locked) reconciliation periods

Revision ID: 012
Revises: 011
Create Date: 2026-05-25 03:00:00.000000

When all accounts for a period are approved, an admin can "close the
books" for that period. Once closed, reviewers and preparers cannot
modify anything for that period (no status flips, no subledger edits,
no manual items, no evidence upload). Admin can re-open later — both
actions are audit-logged.

A row in this table = the period is currently closed.
Closing the same period twice is prevented by the unique index.
Re-opening DELETES the row (with an audit event for history).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "closed_periods",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("closed_by", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "closed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.create_index(
        "ux_closed_periods_tenant_period",
        "closed_periods",
        ["tenant_id", "period_end"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ux_closed_periods_tenant_period", table_name="closed_periods")
    op.drop_table("closed_periods")
