"""ai_commentary column on variances

Revision ID: 021
Revises: 020
Create Date: 2026-05-27 17:00:00.000000

Mirrors the AccountReviewStatus.ai_commentary column (migration 019).
Stores the structured commentary the deeper Agentic Mode produces for
a single flux variance:

    {
      "generated_at":   "2026-05-27T17:00:00+00:00",
      "narrative":      "4–6 sentence prose",
      "risk_level":     "low" | "medium" | "high",
      "justified":      "yes" | "no" | "needs_review",
      "key_entities":   [{"name": "...", "type": "customer|vendor|other", "amount": "..."}],
      "recommendations":["short action 1", "short action 2", ...],
      "confidence":     "high" | "medium" | "low"
    }

JSONB so the schema can evolve without migrations. Populated only by
the deeper Agentic flow (per-row + bulk). NULL for variances that
only have the legacy Narrative.content prose.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "021"
down_revision: str | None = "020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "variances",
        sa.Column("ai_commentary", JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("variances", "ai_commentary")
