"""Fixed-asset AI candidates — capitalization-miss detection

Revision ID: 028
Revises: 027
Create Date: 2026-05-31 10:00:00.000000

Adds the fixed_asset_candidates table that persists AI-detected
potential capitalizations found in the GL. The "Scan GL for missed
capitalizations" action on the Fixed Assets page pulls expense-account
transactions above the company's cap threshold, asks Claude which look
like tangible-asset acquisitions that should sit on the BS and
depreciate, and persists each suggestion here for the user to
accept / dismiss.

Mirrors prepaid_candidates (024) and missed_accrual_candidates (026)
structure. FA-specific AI fields: ai_description (clean asset name),
ai_category (asset class), ai_in_service_date, ai_cost,
ai_salvage_value, ai_useful_life_months.

Dedup key: (tenant_id, gl_txn_id). A second scan reuses existing rows
instead of duplicating — only NEW transactions produce new candidates.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "028"
down_revision: str | None = "027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "fixed_asset_candidates",
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
        sa.Column("ai_description",        sa.String(255)),
        sa.Column("ai_vendor",             sa.String(255)),
        sa.Column("ai_category",           sa.String(100)),
        sa.Column("ai_in_service_date",    sa.Date),
        sa.Column("ai_cost",               sa.Numeric(18, 2)),
        sa.Column("ai_salvage_value",      sa.Numeric(18, 2)),
        sa.Column("ai_useful_life_months", sa.Integer),
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
    op.create_index("ix_fixed_asset_candidates_tenant_id", "fixed_asset_candidates", ["tenant_id"])
    op.create_index("ix_fixed_asset_candidates_period",    "fixed_asset_candidates", ["tenant_id", "period_end"])
    op.create_index("ix_fixed_asset_candidates_status",    "fixed_asset_candidates", ["tenant_id", "status"])
    # Dedup index — keeps "rescan same period" from creating duplicate
    # rows for the same QBO txn. A txn without an id is allowed (rare —
    # GL journal manual lines) and won't collide on this constraint.
    op.create_index(
        "uq_fixed_asset_candidates_txn",
        "fixed_asset_candidates",
        ["tenant_id", "gl_txn_id"],
        unique=True,
        postgresql_where=sa.text("gl_txn_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_fixed_asset_candidates_txn", table_name="fixed_asset_candidates")
    op.drop_index("ix_fixed_asset_candidates_status", table_name="fixed_asset_candidates")
    op.drop_index("ix_fixed_asset_candidates_period", table_name="fixed_asset_candidates")
    op.drop_index("ix_fixed_asset_candidates_tenant_id", table_name="fixed_asset_candidates")
    op.drop_table("fixed_asset_candidates")
