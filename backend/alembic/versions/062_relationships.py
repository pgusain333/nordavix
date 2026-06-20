"""Accounting knowledge graph — generic relationships (edges) table.

Revision ID: 062
Revises: 061
Create Date: 2026-06-20 12:00:00.000000

One row per directed edge connecting two objects:
    (src_type, src_id) --relation--> (dst_type, dst_id)
so Nordavix can store the relationships between close objects (journal entries,
reconciliations, accounts, findings, schedules, tasks, memos) as first-class,
queryable data. Polymorphic refs (string type + string id), not foreign keys —
the allowed vocabulary is enforced in code (core/graph/schema.py); the existing
per-object FKs stay the source of truth. See models/relationship.py.

Includes the Tier-2 RLS `tenant_isolation` policy IN THIS FILE (same predicate
as migration 059) so the offline coverage guard
(test_every_tenant_table_named_in_an_rls_migration) is satisfied — every
TenantBase table must be named in a migration that creates the policy.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "062"
down_revision: str | None = "061"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# tenant_id = <GUC>::uuid, fail-closed (NULL/'' → no rows) — identical to 059.
_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"


def upgrade() -> None:
    op.create_table(
        "relationships",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("src_type", sa.String(length=40), nullable=False),
        sa.Column("src_id", sa.String(length=64), nullable=False),
        sa.Column("relation", sa.String(length=40), nullable=False),
        sa.Column("dst_type", sa.String(length=40), nullable=False),
        sa.Column("dst_id", sa.String(length=64), nullable=False),
        sa.Column("attributes", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("origin", sa.String(length=12), server_default="system", nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_relationships_tenant_id", "relationships", ["tenant_id"])
    # Outgoing: "what does X point to" — tenant + source object.
    op.create_index(
        "ix_relationships_out", "relationships", ["tenant_id", "src_type", "src_id"]
    )
    # Incoming: "what points to X" — tenant + target object.
    op.create_index(
        "ix_relationships_in", "relationships", ["tenant_id", "dst_type", "dst_id"]
    )
    # Idempotency: at most one LIVE edge per (tenant, src, relation, dst).
    # Partial so a soft-deleted edge can be re-created later.
    op.create_index(
        "uq_relationships_live_edge",
        "relationships",
        ["tenant_id", "src_type", "src_id", "relation", "dst_type", "dst_id"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    # Tier-2 RLS — inert until the request path connects as a non-BYPASSRLS
    # login (APP_DATABASE_URL), same as migrations 059/061.
    op.execute("ALTER TABLE public.relationships ENABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.relationships")
    op.execute(
        f"CREATE POLICY tenant_isolation ON public.relationships "
        f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.relationships")
    op.drop_index("uq_relationships_live_edge", table_name="relationships")
    op.drop_index("ix_relationships_in", table_name="relationships")
    op.drop_index("ix_relationships_out", table_name="relationships")
    op.drop_index("ix_relationships_tenant_id", table_name="relationships")
    op.drop_table("relationships")
