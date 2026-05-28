"""Missed accrual AI candidates + accrual unreversed-detection plumbing

Revision ID: 026
Revises: 025
Create Date: 2026-05-28 21:00:00.000000

Adds the missed_accrual_candidates table that persists AI-detected
potential missed accruals — payments hitting expense accounts that
look like they were for PRIOR-period services. The "Scan for missed
accruals" action on the Accruals page populates this.

Feature (d) — detect unreversed accruals — doesn't need a new table;
it's computed at request time from schedule_accruals + live QBO GL.

Dedup key: (tenant_id, gl_txn_id). Mirrors prepaid_candidates so a
rescan is a free no-op for already-seen txns.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "026"
down_revision: str | None = "025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "missed_accrual_candidates",
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
        sa.Column("ai_vendor",             sa.String(255)),
        sa.Column("ai_service_period_end", sa.Date),
        sa.Column("ai_suggested_amount",   sa.Numeric(18, 2)),
        sa.Column("ai_confidence",         sa.Numeric(3, 2), nullable=False, server_default=sa.text("0.50")),
        sa.Column("ai_reasoning",          sa.Text),
        sa.Column("ai_target_account_id",  sa.String(50)),

        # Lifecycle
        sa.Column("status",            sa.String(20), nullable=False, server_default=sa.text("'open'")),
        sa.Column("status_changed_at", sa.DateTime(timezone=True)),
        sa.Column("status_changed_by", UUID(as_uuid=True)),
        sa.Column("accepted_item_id",  UUID(as_uuid=True)),

        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),

        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_missed_accrual_candidates_tenant_id", "missed_accrual_candidates", ["tenant_id"])
    op.create_index("ix_missed_accrual_candidates_period",    "missed_accrual_candidates", ["tenant_id", "period_end"])
    op.create_index("ix_missed_accrual_candidates_status",    "missed_accrual_candidates", ["tenant_id", "status"])
    op.create_index(
        "uq_missed_accrual_candidates_txn",
        "missed_accrual_candidates",
        ["tenant_id", "gl_txn_id"],
        unique=True,
        postgresql_where=sa.text("gl_txn_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_missed_accrual_candidates_txn", table_name="missed_accrual_candidates")
    op.drop_index("ix_missed_accrual_candidates_status", table_name="missed_accrual_candidates")
    op.drop_index("ix_missed_accrual_candidates_period", table_name="missed_accrual_candidates")
    op.drop_index("ix_missed_accrual_candidates_tenant_id", table_name="missed_accrual_candidates")
    op.drop_table("missed_accrual_candidates")
