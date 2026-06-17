"""close_review_findings: meta JSONB column

Revision ID: 058
Revises: 057
Create Date: 2026-06-17 00:00:00.000000

Structured extras for a finding — currently the journal-entry Dr/Cr lines
(account + debit/credit) plus amount/date/flags/memo for the manual-JE anomaly,
so the UI can render the entry's account breakdown instead of a text blob.
Nullable; every non-anomaly finding leaves it null.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "058"
down_revision: str | None = "057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("close_review_findings", sa.Column("meta", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("close_review_findings", "meta")
