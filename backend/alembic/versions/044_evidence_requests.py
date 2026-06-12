"""PBC portal: evidence_requests table.

Revision ID: 044
Revises: 043
Create Date: 2026-06-12 18:00:00.000000

Client document requests ("Prepared By Client"). A preparer asks the
client for a document; the client uploads via an expiring magic link
(no account). Only the SHA-256 of the token is stored — the link itself
is the credential. Uploaded files become ordinary subledger_evidence
rows; this table tracks the request lifecycle.

RLS: enabled with no policies, same posture as every table (migration
042) — the app connects as table owner and filters by tenant in the
session layer; Supabase REST roles see nothing.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "044"
down_revision: str | None = "043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "evidence_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("tenants.id"), nullable=False, index=True),
        sa.Column("qbo_account_id", sa.String(50), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("note", sa.String(1000), nullable=True),
        sa.Column("account_label", sa.String(255), nullable=True),
        sa.Column("recipient_email", sa.String(255), nullable=False),
        sa.Column("recipient_name", sa.String(255), nullable=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("fulfilled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("files", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("send_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.execute("ALTER TABLE public.evidence_requests ENABLE ROW LEVEL SECURITY")


def downgrade() -> None:
    op.drop_table("evidence_requests")
