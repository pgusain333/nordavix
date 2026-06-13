"""Close Autopilot: config + run history.

Revision ID: 045
Revises: 044
Create Date: 2026-06-12 22:00:00.000000

autopilot_configs — one row per workspace: enabled, run day, the flux
toggle, and the EXPLICIT opt-in for auto-emailing clients for missing
bank/card statements (off by default — outward-facing email must be a
deliberate one-time-setup choice).

autopilot_runs — one row per execution (workspace, period): status,
trigger source, and a JSONB per-step results summary the digest and the
Settings history list both read.

RLS: enabled with no policies, same posture as every table (042).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "045"
down_revision: str | None = "044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "autopilot_configs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, unique=True, index=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("run_day", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("run_flux", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("send_pbc_requests", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("pbc_recipient_email", sa.String(255), nullable=True),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "autopilot_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="running"),
        sa.Column("triggered_by", sa.String(20), nullable=False, server_default="manual"),
        sa.Column("started_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("results", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("started_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("ALTER TABLE public.autopilot_configs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.autopilot_runs ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("autopilot_runs")
    op.drop_table("autopilot_configs")
