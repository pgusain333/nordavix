"""A manual task that comes back every month.

Revision ID: 079
Revises: 077
Create Date: 2026-08-28 11:00:00.000000

Every manual task in `task_actions` is a one-off: you create "email the client
for the September bank statement", complete it, and in October you create it
again by hand. Close work is overwhelmingly the same list every month, so the
list people actually keep lives in a spreadsheet next to Nordavix.

`recurrence` is NULL for a one-time task — which is every existing row and stays
the default — or one of 'monthly' | 'quarterly' | 'annually'. Completing a
recurring task writes the next occurrence, so the chain only ever advances when
the work is actually done and an open period never accumulates duplicates.

Only meaningful on manual rows. Overlay rows (source_type != 'manual') describe
a derived task that the underlying module already regenerates per period, so
they leave this NULL.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "079"
down_revision: str | None = "077"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("task_actions", sa.Column("recurrence", sa.String(16), nullable=True))
    # Each occurrence points at the one it was generated from, so a recurring
    # series is walkable for audit without a separate series table. Deliberately
    # not a FK: deleting an old occurrence must not cascade away its successors.
    op.add_column(
        "task_actions",
        sa.Column("recurred_from_id", UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("task_actions", "recurred_from_id")
    op.drop_column("task_actions", "recurrence")
