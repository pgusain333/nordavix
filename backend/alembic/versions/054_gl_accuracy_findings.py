"""GL Accuracy findings + widen proposed_entries.source.

Revision ID: 054
Revises: 053
Create Date: 2026-06-14 12:00:00.000000

gl_accuracy_findings — one flagged GL entry the deterministic watchdog believes
may be miscoded, with the arithmetic evidence (dominant_count / total_count) and
the lifecycle (open → in_adjustments → linked ProposedEntry, or dismissed). The
finding never touches QuickBooks; Accept files a reclass into Adjustments.

Also widens proposed_entries.source 10→20 so the new 'gl_accuracy' source fits.

RLS: enabled with no policies, same posture as every table (042 / 049).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "054"
down_revision: str | None = "053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "proposed_entries", "source",
        existing_type=sa.String(10), type_=sa.String(20), existing_nullable=False,
    )

    op.create_table(
        "gl_accuracy_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("finding_key", sa.String(160), nullable=False, index=True),
        sa.Column("vendor", sa.String(255), nullable=False, index=True),
        sa.Column("qbo_txn_id", sa.String(50), nullable=True),
        sa.Column("txn_type", sa.String(60), nullable=True),
        sa.Column("txn_number", sa.String(60), nullable=True),
        sa.Column("txn_date", sa.Date(), nullable=True),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("memo", sa.String(500), nullable=True),
        sa.Column("posted_account_id", sa.String(50), nullable=True),
        sa.Column("posted_account_name", sa.String(255), nullable=True),
        sa.Column("suggested_account_id", sa.String(50), nullable=True),
        sa.Column("suggested_account_name", sa.String(255), nullable=True),
        sa.Column("dominant_count", sa.Integer(), nullable=False),
        sa.Column("total_count", sa.Integer(), nullable=False),
        sa.Column("posted_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.String(10), nullable=False, server_default="medium"),
        sa.Column("status", sa.String(20), nullable=False, server_default="open", index=True),
        sa.Column("linked_proposed_entry_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("status_changed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    # One finding per (tenant, period, txn+posted-account) — idempotent re-scan.
    op.create_unique_constraint(
        "uq_gl_accuracy_findings_tenant_period_key",
        "gl_accuracy_findings", ["tenant_id", "period_end", "finding_key"],
    )
    op.execute("ALTER TABLE public.gl_accuracy_findings ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("gl_accuracy_findings")
    # Remove gl_accuracy-sourced proposals before narrowing the column — the
    # 11-char source value won't fit String(10) and would abort the ALTER.
    op.execute("DELETE FROM proposed_entries WHERE source = 'gl_accuracy'")
    op.alter_column(
        "proposed_entries", "source",
        existing_type=sa.String(20), type_=sa.String(10), existing_nullable=False,
    )
