"""Client Memory: learning signals + distilled facts.

Revision ID: 049
Revises: 048
Create Date: 2026-06-13 12:00:00.000000

client_memory_signals — raw learning observations: what the AI proposed on an
adjusting entry vs what the human changed it to (offset-account swaps, memo
edits, dismissals).

client_memory_facts — durable conventions distilled from repeated signals
(e.g. "for this account's adjustments, book the offset to 6120"). Applied to
AI runs ONLY once a reviewer confirms the fact (status active) — confirm-first.

RLS: enabled with no policies, same posture as every table (042).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "049"
down_revision: str | None = "048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "client_memory_signals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("signal_type", sa.String(30), nullable=False, index=True),
        sa.Column("source", sa.String(10), nullable=False),
        sa.Column("source_ref", sa.String(100), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("account_key", sa.String(160), nullable=True, index=True),
        sa.Column("proposed_entry_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("before", postgresql.JSONB(), nullable=True),
        sa.Column("after", postgresql.JSONB(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "client_memory_facts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("fact_key", sa.String(200), nullable=False, index=True),
        sa.Column("title", sa.String(400), nullable=False),
        sa.Column("value", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("confidence", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(20), nullable=False, server_default="suggested", index=True),
        sa.Column("provenance", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("confirmed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    # One fact row per convention per tenant — the distiller upserts on this.
    # Tenant-leading so a fact_key can never collide ACROSS tenants, and the
    # SELECT-or-insert in distill_offset_swap is race-safe at the DB layer.
    op.create_unique_constraint(
        "uq_client_memory_facts_tenant_factkey",
        "client_memory_facts", ["tenant_id", "fact_key"],
    )
    op.execute("ALTER TABLE public.client_memory_signals ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.client_memory_facts ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("client_memory_facts")
    op.drop_table("client_memory_signals")
