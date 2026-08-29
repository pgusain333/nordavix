"""Close Review: a memory of when a finding was raised, and a reviewer's word on it.

Revision ID: 083
Revises: 082
Create Date: 2026-08-29 15:00:00.000000

Three things the module promised and could not record.

`first_seen_at` — a review re-run deletes and re-inserts every OPEN finding, so
`created_at` resets and a problem raised a week ago looks like it appeared on
this run. Without it there is no "what changed since I last ran this", which is
the only question a reviewer has after the preparer says they've fixed things.
Carried forward on the same stable key the engine already uses to keep human
decisions sticky. Backfilled from created_at, which is the best available
approximation for findings that predate the column.

`new_count` / `resolved_count` — that diff, denormalized onto the run, so the
page can show it without re-deriving two key sets on every read.

`signoff_note` — the reviewing partner's statement. The memo is the module's
deliverable and a signature with no words under it is a rubber stamp.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "083"
down_revision: str | None = "082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "close_review_findings",
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE close_review_findings SET first_seen_at = created_at "
               "WHERE first_seen_at IS NULL")
    op.add_column("close_reviews",
                  sa.Column("new_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("close_reviews",
                  sa.Column("resolved_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("close_reviews", sa.Column("signoff_note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("close_reviews", "signoff_note")
    op.drop_column("close_reviews", "resolved_count")
    op.drop_column("close_reviews", "new_count")
    op.drop_column("close_review_findings", "first_seen_at")
