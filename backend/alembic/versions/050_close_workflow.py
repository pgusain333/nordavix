"""Close Management workflow: reusable template steps + per-period instances.

Revision ID: 050
Revises: 049
Create Date: 2026-06-14 12:00:00.000000

close_template_steps — the per-tenant, reusable definition of the close
checklist (seeded with a sensible default; the firm can edit/reorder/remove).
Keyed by a stable `key` slug so editing a step never orphans its history.

close_step_instances — one row per (period_end, step) holding that period's
state (owner, due, status, notes, completion stamps). Display fields are
snapshotted at generation so later template edits don't rewrite a period in
flight, and so cycle-time analytics stay stable.

RLS: enabled with no policies, same posture as every table (042).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "050"
down_revision: str | None = "049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "close_template_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(24), nullable=False, server_default="custom"),
        sa.Column("linked_module", sa.String(24), nullable=True),
        sa.Column("due_offset_days", sa.Integer(), nullable=True),
        sa.Column("default_assignee_role", sa.String(16), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_unique_constraint(
        "uq_close_template_steps_tenant_key",
        "close_template_steps", ["tenant_id", "key"],
    )

    op.create_table(
        "close_step_instances",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("step_key", sa.String(64), nullable=False),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(24), nullable=False, server_default="custom"),
        sa.Column("linked_module", sa.String(24), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("assignee_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_unique_constraint(
        "uq_close_step_instances_tenant_period_step",
        "close_step_instances", ["tenant_id", "period_end", "step_key"],
    )

    op.execute("ALTER TABLE public.close_template_steps ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.close_step_instances ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("close_step_instances")
    op.drop_table("close_template_steps")
