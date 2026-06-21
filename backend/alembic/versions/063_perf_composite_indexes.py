"""Performance: composite indexes for the hottest read paths.

Revision ID: 063
Revises: 062
Create Date: 2026-06-21 12:00:00.000000

Pure additive, read-path-only indexes — they change NO query results and NO
behavior, they only let Postgres stop sequentially scanning at scale. Every
TenantBase SELECT is auto-filtered with `tenant_id = ...` (core/db/session.py),
so the composite indexes lead with tenant_id, and the existing single-column
tenant_id indexes / unique constraints (which lead with a different 2nd column)
can't serve these period/time predicates.

Covered hot queries:
  • account_review_status (tenant_id, period_end)        — recon dashboard loads
        every account for a period on each render (overview.py).
  • audit_log (tenant_id, created_at)                    — audit list (DESC) +
        export range scan; fastest-growing table.
  • subledger_evidence (tenant_id, period_end)           — recon dashboard, same
        per-period load alongside account_review_status.
  • gl_accuracy_findings (tenant_id, period_end, status) — Risk Radar scan/list +
        the idempotent open-findings replace.

Built with CREATE INDEX CONCURRENTLY (no write lock on these large/hot tables).
CONCURRENTLY can't run inside a transaction, and Alembic wraps migrations in
one, so we use the autocommit escape hatch. IF NOT EXISTS keeps it idempotent.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "063"
down_revision: str | None = "062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_INDEXES: list[tuple[str, str, str]] = [
    ("ix_ars_tenant_period", "account_review_status", "(tenant_id, period_end)"),
    ("ix_audit_log_tenant_created", "audit_log", "(tenant_id, created_at DESC)"),
    ("ix_subledger_evidence_tenant_period", "subledger_evidence", "(tenant_id, period_end)"),
    ("ix_gl_accuracy_tenant_period_status", "gl_accuracy_findings", "(tenant_id, period_end, status)"),
]


def upgrade() -> None:
    # CONCURRENTLY must run outside a transaction.
    with op.get_context().autocommit_block():
        for name, table, cols in _INDEXES:
            op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} {cols}")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name, _table, _cols in _INDEXES:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
