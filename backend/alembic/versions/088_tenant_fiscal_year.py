"""A client's year doesn't have to start in January.

Revision ID: 088
Revises: 087
Create Date: 2026-09-08 09:00:00.000000

Every date derivation in the close app assumed a calendar year: year-to-date
was pulled from 1 January, "the first month of the year" meant January, and a
window spanning 31 December was refused as crossing a year boundary. For a
client on a June year end all three are wrong — not errors, plausible figures
computed on a basis nobody chose.

Nordavix Allocate already stores a client's fiscal_year_end and reasons about
it correctly. This is the same "MM-DD" convention on the tenant, for the close.

NULL means 31 December, so every existing workspace keeps exactly the behaviour
it has today and nothing recomputes on deploy. The field only starts mattering
when a firm sets it — and setting it changes what year-to-date MEANS for that
workspace, so the periods captured under the old basis need re-syncing. The
settings screen says so at the point of the change.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "088"
down_revision: str | None = "087"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tenants", sa.Column("fiscal_year_end", sa.String(5), nullable=True))


def downgrade() -> None:
    op.drop_column("tenants", "fiscal_year_end")
