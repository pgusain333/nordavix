"""Tamper-evidence for the audit log.

Revision ID: 076
Revises: 075
Create Date: 2026-08-02 09:00:00.000000

The audit log was an ordinary table: anyone reaching the database could edit or
delete a row and nothing would show. Every row now carries a hash of its own
content chained to the row before it, so alteration and deletion both become
visible on inspection.

Nullable on purpose. Existing rows pre-date the chain and stay unhashed — the
verifier counts them as UNCHAINED rather than broken, because reporting historic
records as tampered would be a false accusation and would teach everyone to
ignore the check. The chain begins at the first row written after this migration.

The composite index is what makes verification cheap: the chain is per tenant and
walked oldest-first, and (created_at, id) is the deterministic order the write
path uses to find the previous row.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "076"
down_revision: str | None = "075"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audit_log", sa.Column("prev_hash", sa.String(length=64), nullable=True))
    op.add_column("audit_log", sa.Column("row_hash", sa.String(length=64), nullable=True))
    op.create_index(
        "ix_audit_log_tenant_chain", "audit_log", ["tenant_id", "created_at", "id"],
    )


def downgrade() -> None:
    op.drop_index("ix_audit_log_tenant_chain", table_name="audit_log")
    op.drop_column("audit_log", "row_hash")
    op.drop_column("audit_log", "prev_hash")
