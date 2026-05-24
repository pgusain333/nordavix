"""Manual subledger override on account_review_status

Revision ID: 006
Revises: 005
Create Date: 2026-05-25 00:00:00.000000

For account types where QBO doesn't have a separate subledger (Bank,
Credit Card, Fixed Asset, Prepaid, etc.) the user enters the balance
from their external source (bank statement, FA register, prepaid
schedule) so we can compute a real GL-vs-subledger variance.

When subledger_total is NULL, the live overview falls back to the
account-type default (aging report for AR/AP, GL copy for others).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "account_review_status",
        sa.Column("subledger_total", sa.Numeric(18, 2), nullable=True),
    )
    op.add_column(
        "account_review_status",
        sa.Column("subledger_source", sa.String(255), nullable=True),
    )
    op.add_column(
        "account_review_status",
        sa.Column("subledger_entered_by", UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "account_review_status",
        sa.Column("subledger_entered_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("account_review_status", "subledger_entered_at")
    op.drop_column("account_review_status", "subledger_entered_by")
    op.drop_column("account_review_status", "subledger_source")
    op.drop_column("account_review_status", "subledger_total")
