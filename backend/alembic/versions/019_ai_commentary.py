"""ai_commentary column on account_review_status

Revision ID: 019
Revises: 018
Create Date: 2026-05-26 11:00:00.000000

Stores the structured commentary the Agentic preparer attaches when it
ties out a reconciliation. JSONB so the schema can evolve without
migrations — current shape is documented in modules/recons/agentic.py
in build_ai_commentary().

The column is populated only by the AI preparer flow. Human-prepared
rows leave it NULL; the dashboard renders the AI Commentary card only
when the column is non-null.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "019"
down_revision: str | None = "018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "account_review_status",
        sa.Column("ai_commentary", JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("account_review_status", "ai_commentary")
