"""Reconciling items selected to explain GL-vs-subledger variance

Revision ID: 008
Revises: 007
Create Date: 2026-05-25 01:00:00.000000

When a manual subledger value doesn't tie to GL, the user picks which
current-period transactions explain the gap (the classic bank-rec
"outstanding items" pattern). We store the selected txn IDs + amounts
as JSON on the review row so the same selection is shown when the
user re-opens the modal next time.

Shape of the JSONB column:
  [
    {"txn_id": "12", "txn_type": "Check", "txn_number": "1234",
     "txn_date": "2026-04-28", "amount": "-500.00", "memo": "ABC Co"},
    ...
  ]
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "008"
down_revision: str | None = "007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "account_review_status",
        sa.Column(
            "reconciling_items",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("account_review_status", "reconciling_items")
