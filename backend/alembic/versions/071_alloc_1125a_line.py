"""Allocate: which Form 1125-A line each pool lands on.

Revision ID: 071
Revises: 070
Create Date: 2026-08-01 12:00:00.000000

At year end the capitalized cost has to be laid onto Form 1125-A, which splits
it between line 3 (cost of labor) and line 5 (other costs). That split cannot be
derived from the pool's driver: a pool allocated ON payroll may hold rent, and a
direct production pool holds nutrients alongside wages. Guessing produces a
return line that looks reasonable and is wrong.

So it is stated, once, per pool. NULL means other costs — the neutral answer, and
the one that leaves line 3 understated rather than overstated if nobody ever sets
it. Line 4 (additional §263A costs) is deliberately not modelled: §280E denies
§263A to a cannabis business, which is why §471(c) is being used at all.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "071"
down_revision: str | None = "070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alloc_pool",
        sa.Column("form_1125a_line", sa.String(length=10), nullable=True),
    )
    op.create_check_constraint(
        "ck_alloc_pool_1125a_line",
        "alloc_pool",
        "form_1125a_line IS NULL OR form_1125a_line IN ('labor', 'other')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_alloc_pool_1125a_line", "alloc_pool", type_="check")
    op.drop_column("alloc_pool", "form_1125a_line")
