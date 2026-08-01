"""Allocate: how often a client's §471(c) allocation is actually performed.

Revision ID: 072
Revises: 071
Create Date: 2026-08-01 15:00:00.000000

Most cannabis clients allocate monthly, alongside the close. A smaller book is
often done ONCE, after year end, straight onto the return. Both are legitimate
under §471(c); what isn't legitimate is a workpaper that presents one as the
other.

The distinction has to live in the data because it changes arithmetic, not just
labels. An annual client's run covers the fiscal year, so its expense window and
its payroll window are the YEAR — derive them as "the month of period_end" and
the figure is understated by roughly eleven twelfths while looking ordinary. The
year-end roll-up likewise expects twelve periods for a monthly client and one for
an annual one; get that wrong and a complete year reports eleven months missing.

Defaults to monthly: the majority case, and the safer default. A monthly client
mislabelled annual would hide eleven genuinely missing periods.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "072"
down_revision: str | None = "071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alloc_settings",
        sa.Column(
            "allocation_frequency", sa.String(length=10),
            server_default="monthly", nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_alloc_settings_frequency",
        "alloc_settings",
        "allocation_frequency IN ('monthly', 'annual')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_alloc_settings_frequency", "alloc_settings", type_="check")
    op.drop_column("alloc_settings", "allocation_frequency")
