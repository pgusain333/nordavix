"""Allocate: the square-footage document the client actually supplied.

Revision ID: 075
Revises: 074
Create Date: 2026-08-01 22:00:00.000000

The occupancy driver is production square feet over total, and it moves every
occupancy-driven pool. What's in the Spaces registry is a preparer's
transcription of something the client sent — a floor plan, a surveyor's
schedule, a lease exhibit. On examination the question isn't "what did you
enter", it's "what did you enter it FROM", and square footage with no source
document behind it is a number the preparer produced.

So the source lives with the registry rather than in an email thread. The file
goes to R2 under the standard tenant-scoped key; this row is metadata plus the
key, mirroring subledger_evidence in the close app.

`as_of` records the date the plan speaks to. Superseded plans stay on file: a
facility re-measured in June is new evidence from June, not a correction that
invalidates the March allocation.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "075"
down_revision: str | None = "074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"


def upgrade() -> None:
    op.create_table(
        "alloc_space_map",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=False),
        sa.Column("r2_key", sa.String(length=500), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=True),
        sa.Column("as_of", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("uploaded_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_alloc_space_map_tenant_id", "alloc_space_map", ["tenant_id"])

    op.execute("ALTER TABLE public.alloc_space_map ENABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.alloc_space_map")
    op.execute(
        f"CREATE POLICY tenant_isolation ON public.alloc_space_map "
        f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.alloc_space_map")
    op.drop_table("alloc_space_map")
