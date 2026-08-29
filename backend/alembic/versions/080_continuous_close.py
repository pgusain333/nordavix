"""Continuous close: when a finding was first seen, and when we last looked.

Revision ID: 080
Revises: 079
Create Date: 2026-08-28 15:00:00.000000

Risk Radar already runs eight transaction-level detectors. What it could not do
was tell you anything about TIME, and that is the whole of continuous close.

`first_seen_at` on a finding. The scan deletes and re-inserts every open finding
on each run, so `created_at` resets and after a daily scan every open item looks
brand new. That makes "3 new since yesterday" impossible to compute and makes
"flagged 4 minutes after it was entered" impossible to state. The column is
carried across re-scans by key; the row may churn, the moment we first saw the
problem does not.

`gl_scan_runs`. One row per scan: when it ran, what it covered, how many
transactions it read and how many findings it raised — of which how many were
new. This is what lets a screen say "last checked 12 minutes ago · 1,847
transactions reviewed", which is the honest version of "real-time monitoring":
a clock a client can read beats an adjective they have to trust.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "080"
down_revision: str | None = "079"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Byte-identical to migrations 059 and 061. The predicate reads the GUC the
# request session sets; a different setting name would create a policy that
# silently matches nothing, which is the worst possible failure for RLS.
_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"


def upgrade() -> None:
    op.add_column(
        "gl_accuracy_findings",
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Existing findings have no history to recover, so seed from created_at —
    # truthful for every row scanned once, and the only defensible answer for
    # rows that were re-inserted before this column existed.
    op.execute("UPDATE gl_accuracy_findings SET first_seen_at = created_at "
               "WHERE first_seen_at IS NULL")
    # "New since you last looked" orders by this, per tenant and period.
    op.create_index(
        "ix_gl_findings_first_seen",
        "gl_accuracy_findings",
        ["tenant_id", "period_end", "first_seen_at"],
    )

    op.create_table(
        "gl_scan_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False),
        # How the scan was started: 'sync' (piggybacked on a QBO sync),
        # 'scheduled' (the continuous loop) or 'manual'. Kept because "we check
        # every hour" and "it ran because you pressed sync" are different
        # claims, and only one of them is continuous monitoring.
        sa.Column("trigger", sa.String(16), nullable=False, server_default="sync"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        # NULL until the run finishes. A failed or still-running scan must never
        # be read as "we checked and everything is fine".
        sa.Column("ok", sa.Boolean(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("transactions_reviewed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("accounts_scanned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("findings_total", sa.Integer(), nullable=False, server_default="0"),
        # Findings whose first_seen_at was set by THIS run — the honest count
        # behind "4 new items since you last looked".
        sa.Column("findings_new", sa.Integer(), nullable=False, server_default="0"),
    )
    # The status header reads the latest successful run for a period.
    op.create_index(
        "ix_gl_scan_runs_tenant_period_started",
        "gl_scan_runs",
        ["tenant_id", "period_end", "started_at"],
    )

    # Tier 2 isolation. Every tenant-scoped table carries a `tenant_isolation`
    # policy on top of the app-layer filter, because the app filter can be
    # lifted (skip_tenant_filter) and RLS cannot. Migration 059 hand-listed its
    # tables and missed nine; the offline guard in
    # test_tenant_isolation_comprehensive.py exists so that can't happen again,
    # and this table would fail it without the policy below.
    op.execute("ALTER TABLE public.gl_scan_runs ENABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.gl_scan_runs")
    op.execute(
        "CREATE POLICY tenant_isolation ON public.gl_scan_runs "
        f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
    )


def downgrade() -> None:
    op.drop_index("ix_gl_scan_runs_tenant_period_started", table_name="gl_scan_runs")
    op.drop_table("gl_scan_runs")
    op.drop_index("ix_gl_findings_first_seen", table_name="gl_accuracy_findings")
    op.drop_column("gl_accuracy_findings", "first_seen_at")
