"""Risk Radar spine — generalize gl_accuracy_findings to many detector kinds.

Revision ID: 055
Revises: 054
Create Date: 2026-06-15 12:00:00.000000

The misclassification watchdog becomes the first detector in a broader "Risk
Radar". Additive only — every new column has a server default (or is nullable),
so the existing misclassification rows stay valid with no data migration:

  kind        — which detector raised it (default 'misclassification')
  severity    — cross-kind triage rank high|medium|low (backfilled from confidence)
  action_kind — how it's resolved: reclass | accrual | flag (default 'reclass')
  title       — short human headline (nullable; serializer composes one if null)
  detail      — longer plain-English explanation (nullable)
  evidence    — per-detector structured evidence, JSONB (nullable)

No RLS change — the table already has RLS enabled (054).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "055"
down_revision: str | None = "054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("gl_accuracy_findings",
        sa.Column("kind", sa.String(40), nullable=False, server_default="misclassification"))
    op.add_column("gl_accuracy_findings",
        sa.Column("severity", sa.String(10), nullable=False, server_default="medium"))
    op.add_column("gl_accuracy_findings",
        sa.Column("action_kind", sa.String(20), nullable=False, server_default="reclass"))
    op.add_column("gl_accuracy_findings",
        sa.Column("title", sa.String(200), nullable=True))
    op.add_column("gl_accuracy_findings",
        sa.Column("detail", sa.Text(), nullable=True))
    op.add_column("gl_accuracy_findings",
        sa.Column("evidence", postgresql.JSONB(), nullable=True))

    # Existing rows are all misclassifications; rank them by their statistical
    # confidence so cross-kind severity sorting is correct from day one.
    op.execute("UPDATE gl_accuracy_findings SET severity = confidence")


def downgrade() -> None:
    op.drop_column("gl_accuracy_findings", "evidence")
    op.drop_column("gl_accuracy_findings", "detail")
    op.drop_column("gl_accuracy_findings", "title")
    op.drop_column("gl_accuracy_findings", "action_kind")
    op.drop_column("gl_accuracy_findings", "severity")
    op.drop_column("gl_accuracy_findings", "kind")
