"""Record when a learned fact actually FIRED, so reuse can be counted honestly.

Revision ID: 084
Revises: 083
Create Date: 2026-08-31 09:00:00.000000

Client Memory learns a client's conventions and applies them — a confirmed
vendor→account pairing stops Risk Radar re-flagging it, a recurring variance
expectation explains a movement, an offset convention pre-fills an entry. All
of it works, and none of it leaves a trace, so the product cannot say how much
of a close it did from memory.

That number is the argument for the product compounding, which means it has to
be true. `last_seen_at` on the fact is not it: that records when the fact was
last WRITTEN, not when it was last USED, and a fact fetched into a candidate
set has not necessarily done anything. This table records a fact having an
effect on a specific period.

UNIQUE (tenant, fact, period) — a re-scan applies the same fact again and must
not inflate the count. Every write is an upsert that does nothing on conflict.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "084"
down_revision: str | None = "083"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "client_memory_applications",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("fact_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("period_end", sa.Date(), nullable=False, index=True),
        # Which part of the product the fact acted on — so the brief can say
        # "Risk Radar reused 14" rather than an undifferentiated total.
        sa.Column("surface", sa.String(30), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "fact_id", "period_end",
                            name="uq_memory_application_fact_period"),
    )
    # Every tenant table carries the isolation policy — see migration 059. A new
    # one without it is a hole in the second wall.
    op.execute("ALTER TABLE client_memory_applications ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY tenant_isolation ON client_memory_applications
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    """)


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_isolation ON client_memory_applications")
    op.drop_table("client_memory_applications")
