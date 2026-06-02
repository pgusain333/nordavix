"""In-app notifications.

Revision ID: 032
Revises: 031
Create Date: 2026-06-02 10:00:00.000000

One row per (recipient user, event). Drives the bell + unread badge. Events are
created alongside the actions that already write the audit log (period close,
etc.). Plain unique-free table — no Postgres-version-specific features.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "032"
down_revision: str | None = "031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("recipient_user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("type", sa.String(50), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("body", sa.Text, nullable=True),
        sa.Column("link", sa.String(500), nullable=True),
        sa.Column("entity_type", sa.String(50), nullable=True),
        sa.Column("entity_id", sa.String(100), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    # Unread lookups + recency listing per recipient.
    op.create_index(
        "ix_notifications_recipient_unread",
        "notifications",
        ["tenant_id", "recipient_user_id", "read_at"],
    )
    op.create_index(
        "ix_notifications_recipient_recent",
        "notifications",
        ["tenant_id", "recipient_user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_recipient_recent", table_name="notifications")
    op.drop_index("ix_notifications_recipient_unread", table_name="notifications")
    op.drop_table("notifications")
