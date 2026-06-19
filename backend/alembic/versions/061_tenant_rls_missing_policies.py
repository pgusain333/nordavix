"""Tier 2 RLS: add tenant_isolation to the tenant tables migration 059 missed.

Migration 042 blanket-ENABLED row-level security on every table; migration 059
then attached the ``tenant_isolation`` policy — but from a HARD-CODED list that
undercounted (it claimed "the 41 TenantBase tables" yet omitted these 9, which
are equally TenantBase). The result: these 9 had RLS on with NO policy, so under
the non-bypass ``nordavix_app`` login they would deny ALL rows (recons, GL
snapshots, flux drill-in, bank rec, fixed-asset candidates, task history would
read empty). This adds the exact same flat tenant-scoping policy 059 used — every
one of these tables has a ``tenant_id`` column, so the predicate applies cleanly.

Inert until the request path connects as a non-BYPASSRLS login (APP_DATABASE_URL),
same as 059. Lesson captured in tests: the coverage check now derives the table
set from the model registry + scans migrations, so a hard-coded omission fails CI.

Revision ID: 061
Revises: 060
Create Date: 2026-06-19
"""
from alembic import op

revision = "061"
down_revision = "060"
branch_labels = None
depends_on = None

# tenant_id = <GUC>::uuid, fail-closed (NULL/'' → no rows, never an error) —
# identical to migration 059's _TENANT_PRED.
_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"

# The 9 TenantBase tables that had RLS enabled (042) but no policy (omitted from
# 059's hard-coded list). All carry a tenant_id column.
_MISSED_TABLES = [
    "reconciliations",
    "reconciliation_items",
    "recon_transactions",
    "recon_notes",
    "gl_balance_snapshots",
    "variance_transactions",
    "bank_statement_txns",
    "fixed_asset_candidates",
    "task_actions",
]


def upgrade() -> None:
    for table in _MISSED_TABLES:
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON public.{table}")
        op.execute(
            f"CREATE POLICY tenant_isolation ON public.{table} "
            f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
        )


def downgrade() -> None:
    for table in _MISSED_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON public.{table}")
