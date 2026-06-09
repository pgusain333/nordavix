"""Proposed adjusting entries.

Revision ID: 040
Revises: 039
Create Date: 2026-06-09 10:00:00.000000

One row per AI-drafted (or deterministically-derived) adjusting journal entry
that the user reviews and copies into QuickBooks. Turns close-difference
explanations (bank reconciliation, recon agentic commentary, flux variance)
into reviewable JEs. We never write to QBO — the human posts; status tracks
the open → accepted → posted / dismissed lifecycle. See
models/proposed_entry.py.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "040"
down_revision: str | None = "039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "proposed_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source", sa.String(length=10), nullable=False),
        sa.Column("source_ref", sa.String(length=100), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column(
            "lines",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("memo", sa.String(length=500), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("confidence", sa.String(length=10), server_default="medium", nullable=False),
        sa.Column("status", sa.String(length=20), server_default="open", nullable=False),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status_changed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_proposed_entries_tenant_id", "proposed_entries", ["tenant_id"])
    op.create_index("ix_proposed_entries_source", "proposed_entries", ["source"])
    op.create_index("ix_proposed_entries_source_ref", "proposed_entries", ["source_ref"])
    op.create_index("ix_proposed_entries_period_end", "proposed_entries", ["period_end"])
    op.create_index("ix_proposed_entries_status", "proposed_entries", ["status"])
    # The hot read path (inline cards + queue + idempotent regen) filters by
    # tenant + period and often source/source_ref — one composite covers it.
    op.create_index(
        "ix_proposed_entries_lookup",
        "proposed_entries",
        ["tenant_id", "period_end", "source", "source_ref"],
    )


def downgrade() -> None:
    op.drop_index("ix_proposed_entries_lookup", table_name="proposed_entries")
    op.drop_index("ix_proposed_entries_status", table_name="proposed_entries")
    op.drop_index("ix_proposed_entries_period_end", table_name="proposed_entries")
    op.drop_index("ix_proposed_entries_source_ref", table_name="proposed_entries")
    op.drop_index("ix_proposed_entries_source", table_name="proposed_entries")
    op.drop_index("ix_proposed_entries_tenant_id", table_name="proposed_entries")
    op.drop_table("proposed_entries")
