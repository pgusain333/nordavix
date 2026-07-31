"""Nordavix Allocate — IRC §471(c) cost allocation tables.

Revision ID: 064
Revises: 063
Create Date: 2026-07-30 10:00:00.000000

Creates the eight tables behind the cost-allocation product (a standalone
practice surface, not part of the month-end close). See models/cost_allocation.py
for the full rationale.

Two things worth calling out:

1. CHECK constraints make an inconsistent pool UNREPRESENTABLE rather than
   merely discouraged: an `allocated` pool must name a driver, a `direct` or
   `excluded` pool must not, blended weights must sum to 100, and a `fixed`
   driver must carry a rate. The engine can then trust its inputs.

2. Tier-2 RLS `tenant_isolation` policies are created HERE, in the same file as
   the tables, using the identical predicate as migration 059 — the offline
   coverage guard (test_every_tenant_table_named_in_an_rls_migration) fails the
   build if any TenantBase table isn't named in a migration that creates the
   policy.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "064"
down_revision: str | None = "063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# tenant_id = <GUC>::uuid, fail-closed (NULL/'' → no rows) — identical to 059.
_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"

_TABLES = (
    "alloc_settings",
    "alloc_pool",
    "alloc_account_map",
    "alloc_space",
    "alloc_employee",
    "alloc_payroll_entry",
    "alloc_run",
    "alloc_run_line",
)


def _ts_columns() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def upgrade() -> None:
    # ── alloc_settings — one row per client ─────────────────────────────
    op.create_table(
        "alloc_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("method", sa.String(length=20), server_default="books_records", nullable=False),
        sa.Column("has_afs", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("inventory_method", sa.String(length=20), server_default="rollforward", nullable=False),
        sa.Column("election_attested_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("election_attested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fiscal_year_end", sa.String(length=5), nullable=True),
        sa.Column("gross_receipts_threshold", sa.Numeric(18, 2), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        *_ts_columns(),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("method IN ('books_records', 'afs')", name="ck_alloc_settings_method"),
    )
    op.create_index("ix_alloc_settings_tenant_id", "alloc_settings", ["tenant_id"])
    # Exactly one settings row per client.
    op.create_index("uq_alloc_settings_tenant", "alloc_settings", ["tenant_id"], unique=True)

    # ── alloc_pool — configurable pools + drivers ───────────────────────
    op.create_table(
        "alloc_pool",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("treatment", sa.String(length=20), nullable=False),
        sa.Column("driver", sa.String(length=20), nullable=True),
        sa.Column("blend_payroll_wt", sa.Numeric(7, 4), nullable=True),
        sa.Column("blend_occupancy_wt", sa.Numeric(7, 4), nullable=True),
        sa.Column("fixed_pct", sa.Numeric(7, 4), nullable=True),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        *_ts_columns(),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "treatment IN ('direct', 'allocated', 'excluded')",
            name="ck_alloc_pool_treatment",
        ),
        # An allocated pool MUST name a driver; direct/excluded MUST NOT.
        sa.CheckConstraint(
            "(treatment = 'allocated' AND driver IN ('payroll', 'occupancy', 'blended', 'fixed')) "
            "OR (treatment IN ('direct', 'excluded') AND driver IS NULL)",
            name="ck_alloc_pool_driver",
        ),
        # Blended weights must both be present and sum to 100.
        sa.CheckConstraint(
            "driver IS DISTINCT FROM 'blended' OR ("
            "blend_payroll_wt IS NOT NULL AND blend_occupancy_wt IS NOT NULL "
            "AND blend_payroll_wt + blend_occupancy_wt = 100)",
            name="ck_alloc_pool_blend_weights",
        ),
        sa.CheckConstraint(
            "driver IS DISTINCT FROM 'fixed' OR fixed_pct IS NOT NULL",
            name="ck_alloc_pool_fixed_pct",
        ),
    )
    op.create_index("ix_alloc_pool_tenant_id", "alloc_pool", ["tenant_id"])

    # ── alloc_account_map — GL account → pool ──────────────────────────
    op.create_table(
        "alloc_account_map",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_account_id", sa.String(length=50), nullable=False),
        sa.Column("account_number", sa.String(length=50), nullable=True),
        sa.Column("account_name", sa.String(length=200), nullable=True),
        sa.Column("pool_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("effective_to", sa.Date(), nullable=True),
        *_ts_columns(),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["pool_id"], ["alloc_pool.id"], ondelete="RESTRICT"),
    )
    op.create_index("ix_alloc_account_map_tenant_id", "alloc_account_map", ["tenant_id"])
    op.create_index("ix_alloc_account_map_qbo_account_id", "alloc_account_map", ["qbo_account_id"])
    op.create_index("ix_alloc_account_map_pool_id", "alloc_account_map", ["pool_id"])
    # At most one LIVE mapping per account — re-pooling closes the old row.
    op.create_index(
        "uq_alloc_account_map_live",
        "alloc_account_map",
        ["tenant_id", "qbo_account_id"],
        unique=True,
        postgresql_where=sa.text("effective_to IS NULL"),
    )

    # ── alloc_space — occupancy registry ───────────────────────────────
    op.create_table(
        "alloc_space",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("function", sa.String(length=24), nullable=False),
        sa.Column("square_feet", sa.Numeric(12, 2), nullable=False),
        sa.Column("production_pct", sa.Numeric(7, 4), nullable=True),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        *_ts_columns(),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("square_feet >= 0", name="ck_alloc_space_sqft_non_negative"),
        sa.CheckConstraint(
            "production_pct IS NULL OR (production_pct >= 0 AND production_pct <= 100)",
            name="ck_alloc_space_production_pct_range",
        ),
    )
    op.create_index("ix_alloc_space_tenant_id", "alloc_space", ["tenant_id"])

    # ── alloc_employee — payroll classification ────────────────────────
    op.create_table(
        "alloc_employee",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("external_id", sa.String(length=80), nullable=True),
        sa.Column("qbo_employee_id", sa.String(length=50), nullable=True),
        sa.Column("function", sa.String(length=24), nullable=False),
        sa.Column("production_pct", sa.Numeric(7, 4), server_default="0", nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        *_ts_columns(),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "production_pct >= 0 AND production_pct <= 100",
            name="ck_alloc_employee_production_pct_range",
        ),
    )
    op.create_index("ix_alloc_employee_tenant_id", "alloc_employee", ["tenant_id"])
    op.create_index("ix_alloc_employee_external_id", "alloc_employee", ["external_id"])

    # ── alloc_payroll_entry — monthly wages per employee ───────────────
    op.create_table(
        "alloc_payroll_entry",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("employee_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("gross_wages", sa.Numeric(18, 2), server_default="0", nullable=False),
        sa.Column("employer_taxes", sa.Numeric(18, 2), server_default="0", nullable=False),
        sa.Column("benefits", sa.Numeric(18, 2), server_default="0", nullable=False),
        sa.Column("source", sa.String(length=12), server_default="import", nullable=False),
        sa.Column("import_batch", sa.String(length=64), nullable=True),
        *_ts_columns(),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["employee_id"], ["alloc_employee.id"], ondelete="CASCADE"),
        sa.CheckConstraint("source IN ('import', 'manual', 'qbo')", name="ck_alloc_payroll_entry_source"),
    )
    op.create_index("ix_alloc_payroll_entry_tenant_id", "alloc_payroll_entry", ["tenant_id"])
    op.create_index("ix_alloc_payroll_entry_employee_id", "alloc_payroll_entry", ["employee_id"])
    op.create_index("ix_alloc_payroll_entry_period_end", "alloc_payroll_entry", ["period_end"])
    # Re-importing the same register is idempotent, not double-counted.
    op.create_index(
        "uq_alloc_payroll_entry_period",
        "alloc_payroll_entry",
        ["tenant_id", "employee_id", "period_start", "period_end"],
        unique=True,
    )

    # ── alloc_run — the monthly run + frozen drivers ───────────────────
    op.create_table(
        "alloc_run",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="draft", nullable=False),
        sa.Column("payroll_factor", sa.Numeric(9, 6), nullable=True),
        sa.Column("occupancy_factor", sa.Numeric(9, 6), nullable=True),
        sa.Column("driver_basis", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("total_expenses", sa.Numeric(18, 2), nullable=True),
        sa.Column("direct_total", sa.Numeric(18, 2), nullable=True),
        sa.Column("allocated_total", sa.Numeric(18, 2), nullable=True),
        sa.Column("capitalized_total", sa.Numeric(18, 2), nullable=True),
        sa.Column("disallowed_total", sa.Numeric(18, 2), nullable=True),
        sa.Column("beginning_inventory", sa.Numeric(18, 2), nullable=True),
        sa.Column("additions_purchases", sa.Numeric(18, 2), nullable=True),
        sa.Column("ending_inventory", sa.Numeric(18, 2), nullable=True),
        sa.Column("cogs", sa.Numeric(18, 2), nullable=True),
        sa.Column("eligible", sa.Boolean(), nullable=True),
        sa.Column("gross_receipts_3yr", sa.Numeric(18, 2), nullable=True),
        sa.Column("threshold_used", sa.Numeric(18, 2), nullable=True),
        sa.Column("has_afs", sa.Boolean(), nullable=True),
        sa.Column("blocked_reason", sa.String(length=300), nullable=True),
        sa.Column("prepared_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("prepared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("proposed_entry_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("source_pulled_at", sa.DateTime(timezone=True), nullable=True),
        *_ts_columns(),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('draft', 'in_review', 'approved', 'superseded')",
            name="ck_alloc_run_status",
        ),
        sa.CheckConstraint("period_end >= period_start", name="ck_alloc_run_period_order"),
    )
    op.create_index("ix_alloc_run_tenant_id", "alloc_run", ["tenant_id"])
    op.create_index("ix_alloc_run_period_end", "alloc_run", ["period_end"])
    op.create_index("ix_alloc_run_status", "alloc_run", ["status"])
    # One LIVE run per period — re-running supersedes rather than deletes.
    op.create_index(
        "uq_alloc_run_live_period",
        "alloc_run",
        ["tenant_id", "period_end"],
        unique=True,
        postgresql_where=sa.text("status <> 'superseded'"),
    )

    # ── alloc_run_line — per-account detail (all names snapshotted) ────
    op.create_table(
        "alloc_run_line",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_account_id", sa.String(length=50), nullable=False),
        sa.Column("account_number", sa.String(length=50), nullable=True),
        sa.Column("account_name", sa.String(length=200), nullable=True),
        sa.Column("pool_name", sa.String(length=80), nullable=False),
        sa.Column("treatment", sa.String(length=20), nullable=False),
        sa.Column("driver", sa.String(length=20), nullable=True),
        sa.Column("driver_pct", sa.Numeric(9, 6), server_default="0", nullable=False),
        sa.Column("gross_amount", sa.Numeric(18, 2), server_default="0", nullable=False),
        sa.Column("capitalized_amount", sa.Numeric(18, 2), server_default="0", nullable=False),
        sa.Column("disallowed_amount", sa.Numeric(18, 2), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["run_id"], ["alloc_run.id"], ondelete="CASCADE"),
        # The engine's core identity, enforced at the storage layer too.
        sa.CheckConstraint(
            "gross_amount = capitalized_amount + disallowed_amount",
            name="ck_alloc_run_line_splits_to_gross",
        ),
    )
    op.create_index("ix_alloc_run_line_tenant_id", "alloc_run_line", ["tenant_id"])
    op.create_index("ix_alloc_run_line_run_id", "alloc_run_line", ["run_id"])

    # ── Tier-2 RLS — inert until the request path connects as the
    # non-BYPASSRLS login (APP_DATABASE_URL), same as migrations 059/061/062.
    for table in _TABLES:
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON public.{table}")
        op.execute(
            f"CREATE POLICY tenant_isolation ON public.{table} "
            f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
        )


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON public.{table}")

    op.drop_table("alloc_run_line")
    op.drop_table("alloc_run")
    op.drop_table("alloc_payroll_entry")
    op.drop_table("alloc_employee")
    op.drop_table("alloc_space")
    op.drop_table("alloc_account_map")
    op.drop_table("alloc_pool")
    op.drop_table("alloc_settings")
