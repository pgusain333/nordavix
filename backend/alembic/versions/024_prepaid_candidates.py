"""Prepaid AI candidates (Phase 2 of AI-prepaids spec)

Revision ID: 024
Revises: 023
Create Date: 2026-05-28 18:00:00.000000

Adds the prepaid_candidates table that persists AI-detected potential
prepaid items found in the GL. The "Scan GL for prepaids" action on the
Prepaids page pulls recent expense-account transactions, sends them to
Claude, and persists each likely-prepaid suggestion here for the user
to accept / dismiss.

Dedup key: (tenant_id, gl_txn_id). A second scan reuses existing rows
instead of duplicating — only NEW transactions produce new candidates.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "024"
down_revision: str | None = "023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "prepaid_candidates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),

        # GL txn context
        sa.Column("gl_account_id",   sa.String(50),  nullable=False),
        sa.Column("gl_account_name", sa.String(255), nullable=False),
        sa.Column("gl_txn_id",       sa.String(50)),
        sa.Column("gl_txn_date",     sa.Date, nullable=False),
        sa.Column("gl_amount",       sa.Numeric(18, 2), nullable=False),
        sa.Column("gl_memo",         sa.String(500)),
        sa.Column("gl_vendor",       sa.String(255)),

        # AI fields
        sa.Column("ai_vendor",            sa.String(255)),
        sa.Column("ai_service_start",     sa.Date),
        sa.Column("ai_service_months",    sa.Integer),
        sa.Column("ai_method",            sa.String(20), nullable=False, server_default=sa.text("'straight_line'")),
        sa.Column("ai_confidence",        sa.Numeric(3, 2), nullable=False, server_default=sa.text("0.50")),
        sa.Column("ai_reasoning",         sa.Text),
        sa.Column("ai_target_account_id", sa.String(50)),

        # Lifecycle
        sa.Column("status",            sa.String(20), nullable=False, server_default=sa.text("'open'")),
        sa.Column("status_changed_at", sa.DateTime(timezone=True)),
        sa.Column("status_changed_by", UUID(as_uuid=True)),
        sa.Column("accepted_item_id",  UUID(as_uuid=True)),

        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),

        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_prepaid_candidates_tenant_id", "prepaid_candidates", ["tenant_id"])
    op.create_index("ix_prepaid_candidates_period",    "prepaid_candidates", ["tenant_id", "period_end"])
    op.create_index("ix_prepaid_candidates_status",    "prepaid_candidates", ["tenant_id", "status"])
    # Dedup index — keeps "rescan same period" from creating duplicate
    # rows for the same QBO txn. A txn without an id is allowed (rare —
    # GL journal manual lines) and won't collide on this constraint.
    op.create_index(
        "uq_prepaid_candidates_txn",
        "prepaid_candidates",
        ["tenant_id", "gl_txn_id"],
        unique=True,
        postgresql_where=sa.text("gl_txn_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_prepaid_candidates_txn", table_name="prepaid_candidates")
    op.drop_index("ix_prepaid_candidates_status", table_name="prepaid_candidates")
    op.drop_index("ix_prepaid_candidates_period", table_name="prepaid_candidates")
    op.drop_index("ix_prepaid_candidates_tenant_id", table_name="prepaid_candidates")
    op.drop_table("prepaid_candidates")
