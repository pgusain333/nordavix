"""Schedule offset (expense/cash) account.

Revision ID: 041
Revises: 040
Create Date: 2026-06-09 12:00:00.000000

Adds the offsetting account (the P&L / cash side of a schedule's journal
entries) to every schedule item type. qbo_account_id already holds the
balance-sheet side (prepaid asset, accrued liability, …); this holds the
expense/cash side so Nordavix can draft complete, two-sided proposed adjusting
entries (e.g. Dr Amortization expense / Cr Prepaid). See models/schedule.py.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "041"
down_revision: str | None = "040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = (
    "schedule_prepaids",
    "schedule_accruals",
    "schedule_fixed_assets",
    "schedule_leases",
    "schedule_loans",
)


def upgrade() -> None:
    for t in _TABLES:
        op.add_column(t, sa.Column("offset_qbo_account_id", sa.String(length=50), nullable=True))
        op.add_column(t, sa.Column("offset_account_name", sa.String(length=255), nullable=True))


def downgrade() -> None:
    for t in _TABLES:
        op.drop_column(t, "offset_account_name")
        op.drop_column(t, "offset_qbo_account_id")
