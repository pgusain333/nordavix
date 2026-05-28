"""Add amortization_method to schedule_prepaids (Phase 3 of AI-prepaids spec)

Revision ID: 025
Revises: 024
Create Date: 2026-05-28 19:30:00.000000

Adds an explicit amortization_method column on schedule_prepaids so the
user can choose between days-based and straight-line monthly recognition
for each prepaid item. Default 'daily_rate' preserves the existing
behavior — every pre-existing prepaid keeps amortizing exactly as it
did before this migration.

  daily_rate     — total / days_inclusive(start, end) per day. Precise
                   for policies that start mid-month or have unusual
                   term lengths. Existing default behavior.
  straight_line  — total / N per calendar month touched, where N =
                   count of distinct (year, month) pairs in
                   [start, end]. Recognized at month-end. The "even
                   monthly amortization" CPAs typically prefer for
                   annual SaaS / insurance / dues with clean term
                   boundaries.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "025"
down_revision: str | None = "024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "schedule_prepaids",
        sa.Column(
            "amortization_method",
            sa.String(20),
            nullable=False,
            server_default=sa.text("'daily_rate'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("schedule_prepaids", "amortization_method")
