"""Make an adjusting entry able to explain itself: reason, maker/checker, proof.

Revision ID: 085
Revises: 084
Create Date: 2026-09-01 10:00:00.000000

Four gaps in the adjustment chain, all of the same kind — a fact the product
acts on but never records:

1. `dismiss_reason`. Dismiss took no reason at all, so every passed adjustment
   was unauditable ("we decided not to book six things" — why?) and Client
   Memory had nothing to learn from.

2. `prepared_by` / `approved_by`. These were ONE column, status_changed_by,
   written by both the edit endpoint and every status transition. The
   maker/checker gate read it, so the control's own action overwrote the
   control's input: after a reviewer approved, the row no longer knew who
   prepared the entry, and a reviewer who reopened one could not re-approve it
   because the row now named them as its last preparer.

3. `posted_qbo_doc` / `posted_confirmed_at`. The posting check matched entries
   against real QuickBooks journal entries and returned the doc number to the
   browser, where it lived in component state until the period dropdown
   changed. "This adjustment is in the books as JE-1043, confirmed 16 Aug" is
   the single most defensible fact this module produces and it was discarded.

Backfill reconstructs the split from what status_changed_by MEANS in each
state — the last editor while a row is open, the approver once it is not. That
is the best available reading and it is deliberately conservative: rows whose
history is genuinely ambiguous are left NULL rather than guessed, because a
wrong prepared_by would weaken a segregation-of-duties control rather than
merely leave it uninformed. The audit log holds the exact history either way.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "085"
down_revision: str | None = "084"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("proposed_entries", sa.Column("dismiss_reason", sa.String(500), nullable=True))
    op.add_column("proposed_entries", sa.Column("prepared_by", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("proposed_entries", sa.Column("approved_by", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("proposed_entries", sa.Column("posted_qbo_doc", sa.String(100), nullable=True))
    op.add_column("proposed_entries", sa.Column("posted_confirmed_at", sa.DateTime(timezone=True), nullable=True))

    # An open row's last toucher is whoever last prepared/edited it.
    op.execute("""
        UPDATE proposed_entries
           SET prepared_by = status_changed_by
         WHERE status = 'open' AND status_changed_by IS NOT NULL
    """)
    # A row past review was last touched by the approver. We cannot recover who
    # prepared it (that id was overwritten) — the audit log has it; the row
    # stays honest by leaving prepared_by NULL rather than inventing one.
    op.execute("""
        UPDATE proposed_entries
           SET approved_by = status_changed_by
         WHERE status IN ('accepted', 'posted') AND status_changed_by IS NOT NULL
    """)


def downgrade() -> None:
    op.drop_column("proposed_entries", "posted_confirmed_at")
    op.drop_column("proposed_entries", "posted_qbo_doc")
    op.drop_column("proposed_entries", "approved_by")
    op.drop_column("proposed_entries", "prepared_by")
    op.drop_column("proposed_entries", "dismiss_reason")
