"""Allocate: why an employee's time is split the way it is.

Revision ID: 073
Revises: 072
Create Date: 2026-08-01 18:00:00.000000

A employee at 100% or 0% production is a classification — it follows from the
job. An employee at 60% is an ESTIMATE, and it is the single most questionable
input in the whole allocation: it moves the payroll factor, the payroll factor
moves every allocated pool, and nothing in the workpaper says where 60 came from.

"The grow manager spends three days a week in cultivation and two on retail
ordering; 60% is the split from the January time study" is a defensible position.
The same 60% with nothing behind it is a number a preparer invented, and on
examination it will be treated as one.

So the basis is captured beside the percentage, on the row where the judgement is
made — not in a memo somewhere else that drifts out of step with it. Only splits
need one: a full-time grower at 100% has nothing to justify.

Nullable, because the roster is built by the payroll import and most people
aren't split. Readiness warns when a split lacks a basis rather than blocking:
an unsupported split is a weakness, not an impossibility.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "073"
down_revision: str | None = "072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("alloc_employee", sa.Column("split_basis", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("alloc_employee", "split_basis")
