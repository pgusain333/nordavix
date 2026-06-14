"""Close workflow: step dependencies (depends_on_key).

Revision ID: 051
Revises: 050
Create Date: 2026-06-14 16:00:00.000000

Adds close_template_steps.depends_on_key — the stable key of the step that must
be done before this one (NULL = no prerequisite). A step is "blocked" until its
prerequisite's effective status is done.

Backfills the default linear-ish chain for any already-seeded default steps
(Slice 1 shipped without dependencies), only where depends_on_key IS NULL so it
never overwrites a firm's own choice:

  recon/schedule  ← sync
  adjustments     ← recon
  flux            ← recon
  financials      ← flux
  review          ← financials
  close           ← review

RLS: column on an existing RLS-enabled table; no policy change needed.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "051"
down_revision: str | None = "050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# step key -> its single prerequisite key (the default close chain).
_CHAIN = {
    "recon": "sync",
    "schedule": "sync",
    "adjustments": "recon",
    "flux": "recon",
    "financials": "flux",
    "review": "financials",
    "close": "review",
}


def upgrade() -> None:
    op.add_column(
        "close_template_steps",
        sa.Column("depends_on_key", sa.String(64), nullable=True),
    )
    # Backfill existing default steps' dependencies (only where unset).
    for key, prereq in _CHAIN.items():
        op.execute(
            sa.text(
                "UPDATE close_template_steps SET depends_on_key = :prereq "
                "WHERE key = :key AND depends_on_key IS NULL"
            ).bindparams(prereq=prereq, key=key)
        )


def downgrade() -> None:
    op.drop_column("close_template_steps", "depends_on_key")
