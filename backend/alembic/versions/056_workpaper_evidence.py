"""Workpaper evidence — generalized supporting-document attachments.

Revision ID: 056
Revises: 055
Create Date: 2026-06-15 13:00:00.000000

workpaper_evidence — a file (in R2; this row is metadata + the R2 key) attached
to any workpaper in a period, keyed by (tenant_id, period_end, ref_type, ref_id).
Powers the Workpapers workspace and the Close Binder's evidence appendix.

RLS: enabled with no policies, same posture as every table (042 / 049 / 054).
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "056"
down_revision: str | None = "055"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workpaper_evidence",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("ref_type", sa.String(20), nullable=False, index=True),
        sa.Column("ref_id", sa.String(80), nullable=True, index=True),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("r2_key", sa.String(500), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("verification", postgresql.JSONB(), nullable=True),
    )
    op.execute("ALTER TABLE public.workpaper_evidence ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("workpaper_evidence")
