"""Flux Expectation Engine: actual-vs-expected lens + comparison-mode toggle.

Revision ID: 053
Revises: 052
Create Date: 2026-06-14 00:00:00.000000

Adds the data behind the "Actual vs Expected | Actual vs Prior" toggle:

  trial_balances.comparison_mode  — 'prior' (default) | 'expected'; persisted
                                    per analysis so the lens choice sticks.
  variances.expected_value            — NDVX's expected balance (run-rate / rule)
  variances.expected_basis            — human-readable "why" for the expectation
  variances.dollar_variance_expected  — actual − expected (dollar)
  variances.pct_variance_expected     — actual vs expected (%)
  variances.pre_explained             — a confirmed rule explains it up-front

All variance columns are NULLable (no expectation on older analyses or when
there isn't enough history); pre_explained defaults False. Nothing changes for
existing analyses — they stay in 'prior' mode with NULL expectation fields.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "053"
down_revision: str | None = "052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "trial_balances",
        sa.Column("comparison_mode", sa.String(20), nullable=False, server_default="prior"),
    )
    op.add_column("variances", sa.Column("expected_value", sa.Numeric(18, 4), nullable=True))
    op.add_column("variances", sa.Column("expected_basis", sa.String(200), nullable=True))
    op.add_column("variances", sa.Column("dollar_variance_expected", sa.Numeric(18, 4), nullable=True))
    op.add_column("variances", sa.Column("pct_variance_expected", sa.Numeric(12, 4), nullable=True))
    op.add_column(
        "variances",
        sa.Column("pre_explained", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("variances", "pre_explained")
    op.drop_column("variances", "pct_variance_expected")
    op.drop_column("variances", "dollar_variance_expected")
    op.drop_column("variances", "expected_basis")
    op.drop_column("variances", "expected_value")
    op.drop_column("trial_balances", "comparison_mode")
