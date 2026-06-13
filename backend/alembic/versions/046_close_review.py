"""AI Close Review: per-period review + findings.

Revision ID: 046
Revises: 045
Create Date: 2026-06-12 23:30:00.000000

close_reviews — one row per (workspace, period): status, the AI analytical
narrative, denormalized exception counts, and the reviewer sign-off.

close_review_findings — one row per exception raised by a run, each with its
own clear / action / accept lifecycle so the reviewer's decisions persist
across re-runs.

RLS: enabled with no policies, same posture as every table (042).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "046"
down_revision: str | None = "045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "close_reviews",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="open"),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("high_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("review_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("info_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cleared_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("checks_run", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("passed", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("generated_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("signed_off_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("signed_off_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_unique_constraint(
        "ux_close_review_tenant_period", "close_reviews", ["tenant_id", "period_end"],
    )
    op.create_table(
        "close_review_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("review_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("code", sa.String(60), nullable=False),
        sa.Column("category", sa.String(20), nullable=False),
        sa.Column("severity", sa.String(10), nullable=False, index=True),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("detail", sa.String(1000), nullable=False, server_default=""),
        sa.Column("recommended_action", sa.String(300), nullable=True),
        sa.Column("qbo_account_id", sa.String(50), nullable=True),
        sa.Column("account_label", sa.String(300), nullable=True),
        sa.Column("entity_ref", sa.String(100), nullable=True),
        sa.Column("link_hint", sa.String(60), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="open", index=True),
        sa.Column("status_changed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("status_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.execute("ALTER TABLE public.close_reviews ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.close_review_findings ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("close_review_findings")
    op.drop_constraint("ux_close_review_tenant_period", "close_reviews", type_="unique")
    op.drop_table("close_reviews")
