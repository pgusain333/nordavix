"""User feedback table

Revision ID: 020
Revises: 019
Create Date: 2026-05-26 12:00:00.000000

Stores in-app feedback submissions: bug reports, feature requests,
general comments. Lightweight — one row per submission with category,
message, optional page-context, and submitter ID. No state machine
yet (no triage workflow); the row's open/triaged/resolved status is
tracked client-side later if/when needed.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "020"
down_revision: str | None = "019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "feedback",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column(
            "category",
            sa.String(20),
            nullable=False,
            # bug | feature | improvement | praise | other
            server_default="other",
        ),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("page_path", sa.String(255)),  # window.location.pathname at submit
        sa.Column("user_agent", sa.String(500)),
        sa.Column("status", sa.String(20), nullable=False, server_default="open"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_feedback_tenant_created",
        "feedback",
        ["tenant_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_feedback_tenant_created", table_name="feedback")
    op.drop_table("feedback")
