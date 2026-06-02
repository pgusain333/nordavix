"""Tenant is_demo flag (sample-company read-only demo).

Revision ID: 036
Revises: 035
Create Date: 2026-06-02 13:00:00.000000

Marks the seeded read-only "sample company" tenant. The tenancy middleware
serves it (read-only) when a request carries the X-Nordavix-Demo header, and the
purge job skips it. Plain boolean default false — no Postgres-version features.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "036"
down_revision: str | None = "035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("is_demo", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("tenants", "is_demo")
