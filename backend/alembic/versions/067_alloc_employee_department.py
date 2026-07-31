"""Allocate: carry the payroll register's department and job title.

Revision ID: 067
Revises: 066
Create Date: 2026-07-31 12:00:00.000000

Every payroll provider already holds the client's own org structure — ADP's
"Home Department", Gusto's "Department", plus a job title. That's the client's
own classification of the person, which is exactly the books-and-records basis
§471(c) keys off, and a far better answer to "why is this person production?"
than a preparer's unsourced judgement.

Storing it means the import can suggest a function instead of asking the user to
hand-type a roster, and the Employees tab can show WHY each person is classified
the way they are.

Additive and nullable; no backfill needed. alloc_employee keeps its
tenant_isolation RLS policy from 064 — adding columns doesn't affect it.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "067"
down_revision: str | None = "066"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("alloc_employee", sa.Column("department", sa.String(length=120), nullable=True))
    op.add_column("alloc_employee", sa.Column("job_title", sa.String(length=120), nullable=True))


def downgrade() -> None:
    op.drop_column("alloc_employee", "job_title")
    op.drop_column("alloc_employee", "department")
