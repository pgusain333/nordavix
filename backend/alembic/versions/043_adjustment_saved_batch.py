"""Adjustments: saved-batch stamp.

Revision ID: 043
Revises: 042
Create Date: 2026-06-09 14:00:00.000000

Adds saved_at / saved_by to proposed_entries. Set when the user clicks "Save"
on a fully-approved batch for a period: it locks those entries (immutable —
they can no longer be dismissed) and unlocks the QuickBooks CSV export + the
posting check. Saved (and approved/posted) entries are never deleted.

RLS: proposed_entries already had RLS enabled in migration 042; adding columns
needs no RLS change.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "043"
down_revision: str | None = "042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "proposed_entries",
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "proposed_entries",
        sa.Column("saved_by", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("proposed_entries", "saved_by")
    op.drop_column("proposed_entries", "saved_at")
