"""Allocate: the inventory account the monthly reclass entry debits.

Revision ID: 065
Revises: 064
Create Date: 2026-07-30 12:00:00.000000

The §471(c) run emits a reclass journal entry moving capitalized cost out of
expense and into inventory. That needs a debit target, and guessing it would be
worse than asking — so it's configured per client and the entry is withheld (the
run and workpaper still complete) until it's set.

Additive and nullable, so it applies to existing rows without a backfill.
alloc_settings already carries its tenant_isolation RLS policy from 064; adding
columns doesn't change that.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "065"
down_revision: str | None = "064"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("alloc_settings", sa.Column("inventory_account_id", sa.String(length=50), nullable=True))
    op.add_column("alloc_settings", sa.Column("inventory_account_name", sa.String(length=200), nullable=True))


def downgrade() -> None:
    op.drop_column("alloc_settings", "inventory_account_name")
    op.drop_column("alloc_settings", "inventory_account_id")
