"""Allocate: backfill registry rows stranded by the effective-dating bug.

Revision ID: 066
Revises: 065
Create Date: 2026-07-31 09:00:00.000000

Rows in the three registries were originally stamped effective_from = TODAY,
but every read evaluates them as-of the period being worked — normally a month
that has already closed. So anything entered during setup was invisible to the
very period it was entered for: readiness reported "no square footage" while the
Spaces tab listed three rooms, and mapped accounts came back unmapped.

Migration 065's sibling code change (MAP_EPOCH in setup_service) fixed NEW rows.
This fixes the ones already entered, which the code change can't reach.

Scope is deliberately narrow: only rows that are still LIVE (effective_to IS
NULL) and that start in the future relative to the epoch we want. A row that was
deliberately dated forward by a user would also be live, but the feature is new
enough that no such row can exist yet, and leaving a stranded row would be worse
than re-basing one that was never intentionally dated.

Pure data repair — no schema change, and it re-runs harmlessly.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "066"
down_revision: str | None = "065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Same sentinel as setup_service.MAP_EPOCH — "has always been true".
_EPOCH = "2000-01-01"

_TABLES = ("alloc_space", "alloc_employee", "alloc_account_map")


def upgrade() -> None:
    for table in _TABLES:
        op.execute(
            f"UPDATE public.{table} "
            f"SET effective_from = DATE '{_EPOCH}' "
            f"WHERE effective_to IS NULL AND effective_from > DATE '{_EPOCH}'"
        )


def downgrade() -> None:
    # Not reversible in any meaningful sense: the original per-row dates were the
    # bug, and reinstating them would re-strand the data. Intentionally a no-op.
    pass
