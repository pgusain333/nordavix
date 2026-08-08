"""The frozen working paper behind an approved reconciliation.

Revision ID: 077
Revises: 076
Create Date: 2026-08-02 12:00:00.000000

`account_review_status` records what was concluded; it does not record how the
conclusion was reached, and the recon screen pulls GL balances live from
QuickBooks on every render. A reconciliation approved in March and reopened in
June can therefore show different numbers — the approval was a signature on a
view that no longer exists.

This freezes the derivation at sign-off: both balances with their sources, the
reconciling items with the ORIGIN of each (system / human / ai, and for ai, who
accepted it), and the variance. The same discipline `alloc_run` already applies
by snapshotting its drivers, which is why a §471(c) workpaper still reproduces.

Superseded rather than replaced on reopen, so "what did we approve in March"
survives. Content-hashed, because evidence that can be edited without trace
isn't evidence.

Also adds `subledger_evidence_id` to `account_review_status`: the source
document is already stored in R2 with a hash, and `subledger_source` describes
it in prose instead of pointing at it. Nullable and additive — the free-text
column stays for rows that predate this.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "077"
down_revision: str | None = "076"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"


def upgrade() -> None:
    op.create_table(
        "recon_conclusion",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_account_id", sa.String(length=50), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("gl_balance", sa.Numeric(18, 2), nullable=True),
        sa.Column("gl_source", sa.String(length=120), nullable=True),
        sa.Column("gl_as_of", sa.DateTime(timezone=True), nullable=True),
        sa.Column("subledger_total", sa.Numeric(18, 2), nullable=True),
        sa.Column("subledger_origin", sa.String(length=20),
                  server_default="human", nullable=False),
        sa.Column("subledger_evidence_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("variance", sa.Numeric(18, 2), nullable=True),
        sa.Column("reconciled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("items", postgresql.JSONB(astext_type=sa.Text()),
                  server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("ai_basis", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("prepared_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("status", sa.String(length=20), server_default="active", nullable=False),
        sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_recon_conclusion_tenant_id", "recon_conclusion", ["tenant_id"])
    op.create_index(
        "ix_recon_conclusion_lookup", "recon_conclusion",
        ["tenant_id", "qbo_account_id", "period_end", "status"],
    )
    op.create_check_constraint(
        "ck_recon_conclusion_status", "recon_conclusion",
        "status IN ('active', 'superseded')",
    )

    op.execute("ALTER TABLE public.recon_conclusion ENABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.recon_conclusion")
    op.execute(
        f"CREATE POLICY tenant_isolation ON public.recon_conclusion "
        f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
    )

    # Point at the evidence document instead of describing it in prose.
    op.add_column(
        "account_review_status",
        sa.Column("subledger_evidence_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("account_review_status", "subledger_evidence_id")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.recon_conclusion")
    op.drop_table("recon_conclusion")
