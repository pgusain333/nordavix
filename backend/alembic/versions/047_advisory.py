"""Longitudinal advisory: KPI targets + tracked recommendations.

Revision ID: 047
Revises: 046
Create Date: 2026-06-13 00:30:00.000000

kpi_targets — one firm-set target per (workspace, kpi_key) used to grade the
KPI trend (met / missed).

tracked_recommendations — persisted advisory items (from the exec report's AI
recommendations, insights heuristics, or manual) with a status lifecycle so a
firm can track "advised X; client did Y".

RLS: enabled with no policies, same posture as every table (042).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "047"
down_revision: str | None = "046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "kpi_targets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("kpi_key", sa.String(60), nullable=False),
        sa.Column("comparator", sa.String(10), nullable=False, server_default="gte"),
        sa.Column("target_value", sa.Numeric(18, 4), nullable=False),
        sa.Column("target_value_upper", sa.Numeric(18, 4), nullable=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_unique_constraint(
        "ux_kpi_target_tenant_key", "kpi_targets", ["tenant_id", "kpi_key"],
    )
    op.create_table(
        "tracked_recommendations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("source", sa.String(30), nullable=False, server_default="exec_report_ai"),
        sa.Column("priority", sa.String(10), nullable=False, server_default="medium"),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("kpi_key", sa.String(60), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="open", index=True),
        sa.Column("client_action", sa.Text(), nullable=True),
        sa.Column("outcome_note", sa.Text(), nullable=True),
        sa.Column("status_changed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.execute("ALTER TABLE public.kpi_targets ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.tracked_recommendations ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("tracked_recommendations")
    op.drop_constraint("ux_kpi_target_tenant_key", "kpi_targets", type_="unique")
    op.drop_table("kpi_targets")
