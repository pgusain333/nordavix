"""Allocate: per-transaction allocation overrides.

Revision ID: 068
Revises: 067
Create Date: 2026-07-31 16:00:00.000000

A driver is an estimate applied to a whole account. When a preparer has actually
looked at the general ledger — this repair was to the flower room, that one to
the retail counter — the specific answer is better evidence than the estimate,
and §471(c) rewards specific evidence.

One row per reviewed transaction. Amount and memo are snapshotted so the
workpaper still reads correctly if the transaction is later edited in
QuickBooks, and so the override can be shown without re-pulling the GL.

Effective per period: the same recurring cost can be production one month and
not the next, so an override belongs to the period it was made for.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "068"
down_revision: str | None = "067"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"


def upgrade() -> None:
    op.create_table(
        "alloc_txn_override",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qbo_account_id", sa.String(length=50), nullable=False),
        sa.Column("qbo_txn_id", sa.String(length=64), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("production_pct", sa.Numeric(7, 4), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("txn_date", sa.Date(), nullable=True),
        sa.Column("txn_type", sa.String(length=60), nullable=True),
        sa.Column("txn_number", sa.String(length=60), nullable=True),
        sa.Column("memo", sa.String(length=300), nullable=True),
        sa.Column("entity_name", sa.String(length=200), nullable=True),
        sa.Column("note", sa.String(length=300), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "production_pct >= 0 AND production_pct <= 100",
            name="ck_alloc_txn_override_pct_range",
        ),
    )
    op.create_index("ix_alloc_txn_override_tenant_id", "alloc_txn_override", ["tenant_id"])
    op.create_index(
        "ix_alloc_txn_override_account_period",
        "alloc_txn_override", ["tenant_id", "qbo_account_id", "period_end"],
    )
    # One override per transaction per period — re-reviewing updates in place.
    op.create_index(
        "uq_alloc_txn_override_txn",
        "alloc_txn_override", ["tenant_id", "qbo_txn_id", "period_end"],
        unique=True,
    )

    op.execute("ALTER TABLE public.alloc_txn_override ENABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.alloc_txn_override")
    op.execute(
        f"CREATE POLICY tenant_isolation ON public.alloc_txn_override "
        f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.alloc_txn_override")
    op.drop_table("alloc_txn_override")
