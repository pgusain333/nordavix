"""Split preparer + reviewer tracking on account_review_status

Revision ID: 014
Revises: 013
Create Date: 2026-05-25 16:00:00.000000

Previously we only stored a single `reviewed_by` / `reviewed_at` pair
per account+period. Whoever last changed the status was recorded —
which meant the preparer info got overwritten the moment a reviewer
came along and approved the row.

The Tasks UI wants both: who PREPARED (marked it as reviewed, aka
ready for review) and who APPROVED. We add two new column pairs so
each step is stamped independently.

Existing rows are backfilled from `reviewed_by`/`reviewed_at` using
the current status as a hint:
  - status='reviewed': they prepared but no one approved yet
  - status='approved': we don't know who prepared — assume the same
    person (sole-actor case is common at small CPA firms)
  - status in (pending, flagged): nothing to backfill
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "014"
down_revision: str | None = "013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("account_review_status", sa.Column("prepared_by", UUID(as_uuid=True), nullable=True))
    op.add_column("account_review_status", sa.Column("prepared_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("account_review_status", sa.Column("approved_by", UUID(as_uuid=True), nullable=True))
    op.add_column("account_review_status", sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True))

    # Backfill prepared_* from reviewed_* for any row that's at least
    # at "reviewed" status (i.e. someone marked it ready).
    op.execute(
        """
        UPDATE account_review_status
        SET prepared_by = reviewed_by,
            prepared_at = reviewed_at
        WHERE status IN ('reviewed', 'approved')
          AND reviewed_by IS NOT NULL
        """
    )
    # Backfill approved_* from reviewed_* for any row at "approved".
    op.execute(
        """
        UPDATE account_review_status
        SET approved_by = reviewed_by,
            approved_at = reviewed_at
        WHERE status = 'approved'
          AND reviewed_by IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("account_review_status", "approved_at")
    op.drop_column("account_review_status", "approved_by")
    op.drop_column("account_review_status", "prepared_at")
    op.drop_column("account_review_status", "prepared_by")
