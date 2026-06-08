"""Re-engagement drip enrollment table.

Revision ID: 037
Revises: 036
Create Date: 2026-06-08 12:00:00.000000

One row per human (clerk_user_id) tracking the win-back email sequence for users
who signed up but never activated. Cross-tenant (no tenant_id column). Status as
VARCHAR + CHECK (repo convention — no Postgres enums). Unsubscribe state lives
here. UNIQUE(clerk_user_id) is the dedupe backstop for the daily sweep.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "037"
down_revision: str | None = "036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reengagement_enrollment",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("clerk_user_id", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=20), server_default=sa.text("'active'"), nullable=False),
        sa.Column("step_sent", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("enrolled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("unsubscribed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("clerk_user_id", name="uq_reengagement_enrollment_clerk_user_id"),
        sa.CheckConstraint(
            "status in ('active','activated','unsubscribed','completed','suppressed')",
            name="ck_reengagement_enrollment_status",
        ),
    )
    op.create_index(
        "ix_reengagement_enrollment_status", "reengagement_enrollment", ["status"],
    )


def downgrade() -> None:
    op.drop_index("ix_reengagement_enrollment_status", table_name="reengagement_enrollment")
    op.drop_table("reengagement_enrollment")
