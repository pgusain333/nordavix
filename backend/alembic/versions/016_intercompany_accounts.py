"""Intercompany account marks

Revision ID: 016
Revises: 015
Create Date: 2026-05-25 18:00:00.000000

The Intercompany module tracks accounts that represent transactions
between related entities — typical names: "Due to Acme Sub", "Due from
Parent Co", "Intercompany Receivable / Payable". Auto-detected by
name pattern on first run; can be manually marked/unmarked.

One row per (tenant, qbo_account_id). `kind` records whether the
account is a receivable or payable from the host entity's
perspective. `counterparty` is the human-readable name of the related
party (free-text). `auto_detected` distinguishes pattern-matched
rows from explicit user choices, so a re-run of auto-detect doesn't
clobber manual classifications.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "016"
down_revision: str | None = "015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "intercompany_accounts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("qbo_account_id", sa.String(50), nullable=False),
        sa.Column("counterparty",   sa.String(200), nullable=True),
        # 'receivable' | 'payable' | 'unknown'
        sa.Column("kind",           sa.String(20), nullable=False, server_default="unknown"),
        sa.Column("auto_detected",  sa.Boolean(),  nullable=False, server_default=sa.text("false")),
        sa.Column("notes",          sa.Text(),     nullable=True),
        sa.Column("created_by",     UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ux_intercompany_accounts_tenant_qbo",
        "intercompany_accounts",
        ["tenant_id", "qbo_account_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ux_intercompany_accounts_tenant_qbo", table_name="intercompany_accounts")
    op.drop_table("intercompany_accounts")
