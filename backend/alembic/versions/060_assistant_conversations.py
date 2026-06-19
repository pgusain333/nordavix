"""Assistant conversation persistence (Tier 3 Phase 1).

Creates assistant_threads + assistant_messages (saved chat history for the client
assistant) and — consistent with migration 059 — enables RLS + attaches the
tenant_isolation policy to each, so the constrained app role is scoped under
Tier 2 and the CI policy-coverage test stays green.

Revision ID: 060
Revises: 059
Create Date: 2026-06-18
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "060"
down_revision = "059"
branch_labels = None
depends_on = None

_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"


def upgrade() -> None:
    op.create_table(
        "assistant_threads",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_assistant_threads_tenant_id", "assistant_threads", ["tenant_id"])

    op.create_table(
        "assistant_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("thread_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("sources", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_assistant_messages_tenant_id", "assistant_messages", ["tenant_id"])
    op.create_index("ix_assistant_messages_thread_id", "assistant_messages", ["thread_id"])

    # RLS — inert under the BYPASSRLS app login today, enforced once cut over.
    for table in ("assistant_threads", "assistant_messages"):
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON public.{table}")
        op.execute(
            f"CREATE POLICY tenant_isolation ON public.{table} "
            f"USING ({_PRED}) WITH CHECK ({_PRED})"
        )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.assistant_messages")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.assistant_threads")
    op.drop_table("assistant_messages")
    op.drop_table("assistant_threads")
