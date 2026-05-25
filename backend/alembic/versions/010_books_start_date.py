"""Books starting date for a tenant + seeded-at marker

Revision ID: 010
Revises: 009
Create Date: 2026-05-25 02:00:00.000000

Companies set this once at onboarding. It anchors the roll-forward
chain: every reconciliation period_end must be >= books_start_date,
and the very first reconciliation uses opening balances stored at
period_end = books_start_date - 1 day. Locked after seeding; admin
override comes later.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("books_start_date", sa.Date(), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("books_seeded_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tenants", "books_seeded_at")
    op.drop_column("tenants", "books_start_date")
