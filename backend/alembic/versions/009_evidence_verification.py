"""AI verification result on subledger evidence

Revision ID: 009
Revises: 008
Create Date: 2026-05-25 01:30:00.000000

When a user uploads supporting evidence for a manual subledger, we can
ask Anthropic to read the document and pull out the actual balance,
statement date, and document type — then compare against what the user
typed. The result lives here so the verification is cached (Anthropic
calls cost money) and surfaced on the reviewer dashboard.

Shape of `verification`:
  {
    "extracted_balance":  "12345.67",          // null if not found
    "statement_date":     "2026-04-30",        // ISO; null if not found
    "doc_type":           "bank_statement",    // free-text classifier
    "doc_identifier":     "BoA acct ****1234", // best-effort account ref
    "match_status":       "match" | "mismatch" | "unknown",
    "difference":         "0.00",              // entered - extracted, null if unknown
    "confidence":         "high" | "medium" | "low",
    "summary":            "...",               // 1-2 sentence human summary
    "model":              "claude-sonnet-4-5",
    "verified_at":        "2026-05-25T01:30:00Z"
  }
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "009"
down_revision: str | None = "008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "subledger_evidence",
        sa.Column("verification", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("subledger_evidence", "verification")
