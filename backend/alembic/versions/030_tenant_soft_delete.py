"""Tenant soft-delete — deleted_at / purge_after / deleted_by

Revision ID: 030
Revises: 029
Create Date: 2026-06-01 12:00:00.000000

Adds the soft-delete lifecycle to tenants. "Delete company" now sets
deleted_at (immediately blocking all access + revoking the QBO token)
and purge_after = deleted_at + 30 days. A scheduled purge job hard-deletes
the tenant's data after that grace window (recoverable until then, matching
the Privacy Policy's deletion language). Audit logs are archived, not
purged.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "030"
down_revision: str | None = "029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("tenants", sa.Column("purge_after", sa.DateTime(timezone=True), nullable=True))
    op.add_column("tenants", sa.Column("deleted_by", UUID(as_uuid=True), nullable=True))
    # Partial index so the purge job can cheaply find tenants due for hard-delete.
    op.create_index(
        "ix_tenants_purge_after",
        "tenants",
        ["purge_after"],
        postgresql_where=sa.text("deleted_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_tenants_purge_after", table_name="tenants")
    op.drop_column("tenants", "deleted_by")
    op.drop_column("tenants", "purge_after")
    op.drop_column("tenants", "deleted_at")
