"""Backfill existing users to 'admin' role

Revision ID: 011
Revises: 010
Create Date: 2026-05-25 02:30:00.000000

We're introducing a 3-tier role system: admin / reviewer / preparer.
Existing tenants today have a single signed-in user — that user becomes
the admin so nobody loses access. New users default to "preparer"
(set at provisioning time) until an admin promotes them.

No schema change — the `role` column is already a String. This migration
just rewrites legacy 'member' values to 'admin'.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "011"
down_revision: str | None = "010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE users SET role = 'admin' WHERE role IN ('member', '')")


def downgrade() -> None:
    op.execute("UPDATE users SET role = 'member' WHERE role = 'admin'")
