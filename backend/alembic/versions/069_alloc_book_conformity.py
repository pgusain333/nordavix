"""Allocate: record whether the books actually reflect the method.

Revision ID: 069
Revises: 068
Create Date: 2026-07-31 18:00:00.000000

§471(c)(1)(B)(ii) lets a small business taxpayer inventory costs per its books
and records "as prepared in accordance with the taxpayer's accounting
procedures". The operative word is BOOKS: if the reclass entry is exported and
never posted, the general ledger shows ordinary expense while the return claims
COGS, and the method fails on its own terms no matter how good the allocation
was.

So a run now records whether its entry was found in QuickBooks, when that was
last checked, and the document number it matched. Unverified is a distinct
state from unposted — "we haven't looked" must never read as "it's fine".
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "069"
down_revision: str | None = "068"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("alloc_run", sa.Column("posted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("alloc_run", sa.Column("posted_doc_number", sa.String(length=60), nullable=True))
    op.add_column(
        "alloc_run", sa.Column("posting_checked_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alloc_run", "posting_checked_at")
    op.drop_column("alloc_run", "posted_doc_number")
    op.drop_column("alloc_run", "posted_at")
