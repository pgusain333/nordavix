"""Allocate: the §448(c) small-business-taxpayer test, as performed.

Revision ID: 070
Revises: 069
Create Date: 2026-08-01 09:00:00.000000

§471(c) is only open to a small business taxpayer — three-year average gross
receipts at or under the annually indexed §448(c) threshold. Above it, the
client cannot use the method at all, and every allocation built on it is
unusable.

The test AGGREGATES. §448(c)(2) pulls in §52(a)/(b) and §414(m)/(o), so gross
receipts of commonly controlled entities are combined. Cannabis groups are
routinely multi-entity — a cultivation LLC, a retail LLC, a management company,
often a property entity — and three entities at $12M each pass individually and
fail together. Testing the client in isolation is the error this table exists to
prevent.

Stored as a SNAPSHOT of the test as performed, not as live inputs: which
entities were included, each one's receipts by year, the threshold used, and who
concluded on it. A year later the question is "what did you test and on what
basis", and that has to be answerable without re-deriving anything.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "070"
down_revision: str | None = "069"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TENANT_PRED = "tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid"


def upgrade() -> None:
    op.create_table(
        "alloc_eligibility",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        # The year the method is being used FOR; the test looks at the three
        # years before it.
        sa.Column("tax_year", sa.Integer(), nullable=False),
        sa.Column("threshold", sa.Numeric(18, 2), nullable=False),
        # [{entity, year, amount, source}] — the whole basis, frozen.
        sa.Column("entities", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("three_year_avg", sa.Numeric(18, 2), nullable=False),
        sa.Column("eligible", sa.Boolean(), nullable=False),
        sa.Column("has_afs", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        # afs | books_records | NULL when ineligible
        sa.Column("method_available", sa.String(length=20), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("aggregation_note", sa.String(length=500), nullable=True),
        sa.Column("tested_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("tested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_alloc_eligibility_tenant_id", "alloc_eligibility", ["tenant_id"])
    # One conclusion per tax year — re-testing replaces it.
    op.create_index(
        "uq_alloc_eligibility_year", "alloc_eligibility",
        ["tenant_id", "tax_year"], unique=True,
    )

    op.execute("ALTER TABLE public.alloc_eligibility ENABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.alloc_eligibility")
    op.execute(
        f"CREATE POLICY tenant_isolation ON public.alloc_eligibility "
        f"USING ({_TENANT_PRED}) WITH CHECK ({_TENANT_PRED})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON public.alloc_eligibility")
    op.drop_table("alloc_eligibility")
