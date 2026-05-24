"""Subledger evidence — attached source documents for manual overrides

Revision ID: 007
Revises: 006
Create Date: 2026-05-25 00:30:00.000000

When a user enters a manual subledger override (bank balance, FA register
total, prepaid schedule), they upload the supporting document — a bank
statement PDF, a register Excel — as audit evidence. Each row here points
at one file in R2 keyed by (tenant_id, qbo_account_id, period_end), so a
single override can have multiple attachments.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "subledger_evidence",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("qbo_account_id", sa.String(50), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("r2_key", sa.String(500), nullable=False),
        sa.Column("uploaded_by", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_subledger_evidence_lookup",
        "subledger_evidence",
        ["tenant_id", "qbo_account_id", "period_end"],
    )


def downgrade() -> None:
    op.drop_index("ix_subledger_evidence_lookup", table_name="subledger_evidence")
    op.drop_table("subledger_evidence")
