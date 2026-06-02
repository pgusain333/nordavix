"""Comments & @mentions.

Revision ID: 033
Revises: 032
Create Date: 2026-06-02 11:00:00.000000

A discussion thread per entity, addressed polymorphically by (entity_type,
entity_id) — same shape as notifications. `mentions` holds the internal user
ids @mentioned in the body (drives mention notifications). Plain table, no
Postgres-version-specific features.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

from alembic import op

revision: str = "033"
down_revision: str | None = "032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "comments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("entity_type", sa.String(50), nullable=False),
        sa.Column("entity_id", sa.String(100), nullable=False),
        sa.Column("author_user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("mentions", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("link", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Thread lookup: all comments for one entity, in chronological order.
    op.create_index(
        "ix_comments_entity",
        "comments",
        ["tenant_id", "entity_type", "entity_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_comments_entity", table_name="comments")
    op.drop_table("comments")
