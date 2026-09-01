"""Give a recommendation something to be graded against.

Revision ID: 086
Revises: 085
Create Date: 2026-09-01 15:00:00.000000

The advisory module could record that a firm gave advice and never find out
whether the advice worked. A recommendation was one AI sentence with a
hardcoded "medium" priority, a NULL detail, and a kpi_key nothing ever wrote —
while the KPI trend sat on the same page with six months of history and no
join between them.

These columns are that join:

  baseline_value / baseline_at   what the metric read WHEN THE ADVICE WAS
                                 GIVEN. Stored, not derived — recomputing it
                                 from today's series would silently
                                 re-baseline every time the history changed,
                                 and a hypothesis you can move the start of is
                                 not a hypothesis.
  target_value / due_date        where it should get to, by when. Both
                                 nullable: some advice is directional, and
                                 saying so beats inventing a number to fill a
                                 column.
  expected_impact / impact_note  what it is worth and why that figure.
  owner                          free text, because the owner is often someone
                                 at the client who has no login here.

Nothing is backfilled. Existing rows were written without a metric, a baseline
or a priority anyone chose, and inventing those now would produce a scorecard
grading advice against numbers no one ever set. They stay ungraded and say so.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "086"
down_revision: str | None = "085"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLS = [
    ("baseline_value",  sa.Numeric(18, 4)),
    ("baseline_at",     sa.DateTime(timezone=True)),
    ("target_value",    sa.Numeric(18, 4)),
    ("due_date",        sa.Date()),
    ("expected_impact", sa.Numeric(18, 2)),
    ("impact_note",     sa.String(300)),
    ("owner",           sa.String(120)),
]


def upgrade() -> None:
    for name, type_ in _COLS:
        op.add_column("tracked_recommendations", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(_COLS):
        op.drop_column("tracked_recommendations", name)
