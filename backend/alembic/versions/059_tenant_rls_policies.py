"""Tier 2: Row-Level Security — per-tenant policies.

Attaches a ``tenant_isolation`` policy to every tenant-scoped table comparing
``tenant_id`` to the ``app.current_tenant`` GUC (set per-transaction in
core/db/session.py), plus a self-scoped policy on ``tenants`` so the request
login sees only its own row.

This migration adds POLICIES ONLY. It deliberately does NOT create the
``nordavix_app`` role or grant it privileges — that requires CREATEROLE, which a
data migration shouldn't depend on (a failure there would block every deploy).
Role creation + grants + password are a one-time operator step done in the
Supabase SQL editor at cutover; see docs/RLS_CUTOVER.md.

DORMANT until the app connects as a NON-BYPASSRLS login via ``APP_DATABASE_URL``:
today's login (Supabase ``postgres``) has BYPASSRLS and ignores every policy
below, so this migration changes nothing observable on its own, and is reversible.

Table list is HARD-CODED on purpose: a migration is history and must not depend
on current model definitions, which drift. The CI test
``test_every_tenant_table_has_rls_policy`` asserts every *current* tenant table
has this policy, so a future table added without one fails the build.

Revision ID: 059
Revises: 058
Create Date: 2026-06-18
"""
from alembic import op

revision = "059"
down_revision = "058"
branch_labels = None
depends_on = None

# tenant_id = <GUC>::uuid, fail-closed (NULL/'' → no rows, never an error).
_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"
# tenants has no tenant_id; the row's own id IS the tenant.
_SELF_PRED = "id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"

# Every tenant-scoped table as of revision 059 (the 41 TenantBase tables).
_TENANT_TABLES = [
    "account_review_status", "accounts", "ai_usage", "audit_log",
    "autopilot_configs", "autopilot_runs", "bank_statements",
    "client_memory_facts", "client_memory_signals", "close_review_findings",
    "close_reviews", "close_step_instances", "close_template_steps",
    "closed_periods", "comments", "evidence_requests", "feedback",
    "gl_accuracy_findings", "insights_snapshots", "intercompany_accounts",
    "intercompany_pairs", "kpi_targets", "missed_accrual_candidates",
    "narratives", "notifications", "period_sync", "prepaid_candidates",
    "proposed_entries", "qbo_connections", "schedule_accruals",
    "schedule_fixed_assets", "schedule_leases", "schedule_loans",
    "schedule_prepaids", "schedule_snapshots", "subledger_evidence",
    "tracked_recommendations", "trial_balances", "users", "variances",
    "workpaper_evidence",
]


def upgrade() -> None:
    # Per-tenant isolation policy on every tenant-scoped table. RLS was already
    # ENABLED in migration 042; re-enabling is idempotent and guards any table
    # that slipped through. Policies apply only to non-BYPASSRLS logins, so this
    # is inert until APP_DATABASE_URL points at nordavix_app.
    for table in _TENANT_TABLES:
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON public.{table}")
        op.execute(
            f"CREATE POLICY tenant_isolation ON public.{table} "
            f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
        )

    # tenants: the request login may read/modify only its OWN row. INSERT is left
    # open (WITH CHECK true) so provisioning never breaks — though provisioning
    # runs on the BYPASS engine today (middleware bootstrap).
    op.execute("ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_self ON public.tenants")
    op.execute(
        f"CREATE POLICY tenant_self ON public.tenants "
        f"USING ({_SELF_PRED}) WITH CHECK (true)"
    )


def downgrade() -> None:
    for table in _TENANT_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON public.{table}")
    op.execute("DROP POLICY IF EXISTS tenant_self ON public.tenants")
