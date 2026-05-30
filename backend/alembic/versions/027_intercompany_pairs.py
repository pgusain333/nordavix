"""Intercompany pairs — cross-tenant matched accounts

Revision ID: 027
Revises: 026
Create Date: 2026-05-30 22:30:00.000000

A pair links an IC account in THIS tenant to an IC account in another
tenant the user has access to (via shared Clerk org membership). Two
rows are written per pair — one in each tenant — sharing a
`pair_group_id` so each tenant sees the pair from its own perspective
without bypassing the tenant_id row-level filter.

Why two rows instead of one cross-tenant row: the rest of the schema
filters all reads via tenant_id automatically (TenantBase). Storing one
row per tenant keeps the elimination + consolidation queries idiomatic
and avoids special-case query plumbing.

Unique key:
  (tenant_id, my_qbo_account_id, counterparty_tenant_id, counterparty_qbo_account_id)
prevents the same account from being paired twice with the same other-side
account.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision: str = "027"
down_revision: str | None = "026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "intercompany_pairs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        # Shared across both halves of the pair so DELETE removes both.
        sa.Column("pair_group_id", UUID(as_uuid=True), nullable=False),

        # "My side" — the account in THIS tenant
        sa.Column("my_qbo_account_id", sa.String(50), nullable=False),

        # "Other side" — the matching account in the counterparty tenant
        sa.Column("counterparty_tenant_id",     UUID(as_uuid=True), nullable=False),
        sa.Column("counterparty_clerk_org_id",  sa.String(255), nullable=False),
        sa.Column("counterparty_qbo_account_id", sa.String(50), nullable=False),
        # Cached display label "AcmeCo · 2150 Intercompany Payable" so the UI
        # doesn't have to re-resolve it on every render.
        sa.Column("counterparty_label", sa.String(500), nullable=False),

        sa.Column("notes", sa.Text),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),

        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_intercompany_pairs_tenant_id",     "intercompany_pairs", ["tenant_id"])
    op.create_index("ix_intercompany_pairs_group",         "intercompany_pairs", ["pair_group_id"])
    op.create_index(
        "uq_intercompany_pairs_unique",
        "intercompany_pairs",
        ["tenant_id", "my_qbo_account_id", "counterparty_tenant_id", "counterparty_qbo_account_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_intercompany_pairs_unique", table_name="intercompany_pairs")
    op.drop_index("ix_intercompany_pairs_group", table_name="intercompany_pairs")
    op.drop_index("ix_intercompany_pairs_tenant_id", table_name="intercompany_pairs")
    op.drop_table("intercompany_pairs")
