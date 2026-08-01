"""Allocate: maker-checker on the §448(c) conclusion, and Form 1125-A line 9.

Revision ID: 074
Revises: 073
Create Date: 2026-08-01 20:00:00.000000

TWO THINGS.

1. The §448(c) conclusion becomes maker-checker, like a run. It used to need a
   reviewer to record at all, which put the person who does the work outside the
   task: a preparer gathers the receipts, identifies the affiliates and performs
   the aggregation, then had to fetch someone to type it in. Now the preparer
   records it and a reviewer signs it off — the same shape as every other
   conclusion in the product, and the same rule: nobody approves their own work.

   `status` carries draft | approved. An UNAPPROVED conclusion still gates runs
   the way an approved one does when it says NOT eligible — a negative finding
   is a stop the moment anyone reaches it, whether or not it has been signed.

2. Form 1125-A line 9 — the whole second half of the form, previously absent.
   Lines 1 through 8 are arithmetic; line 9 is the declarations, and for a
   cannabis §471(c) taxpayer two of them carry real weight:

     9e — do the §263A rules apply? For this taxpayer, NO. §280E denies §263A,
          which is precisely why §471(c) is being used. Answering it wrongly
          contradicts the method on the face of the return.
     9f — was there a change in determining quantities, cost or valuations? YES
          in the first year §471(c) is adopted, and that is a change in method of
          accounting requiring Form 3115 and a §481(a) adjustment.

   Stored on settings because they're properties of the client's method, not of
   a period. Defaults match the ordinary §471(c) cannabis position (cost basis,
   no LIFO, §263A not applicable) but every one is editable — a default that
   can't be overridden is a guess wearing a uniform.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "074"
down_revision: str | None = "073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── 1. Maker-checker on the §448(c) conclusion ────────────────────────────
    op.add_column(
        "alloc_eligibility",
        sa.Column("status", sa.String(length=20), server_default="draft", nullable=False),
    )
    op.add_column(
        "alloc_eligibility",
        sa.Column("approved_by", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "alloc_eligibility",
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "ck_alloc_eligibility_status", "alloc_eligibility",
        "status IN ('draft', 'approved')",
    )
    # Anything already on file was recorded under the reviewer-only rule, so it
    # was already reviewed — marking it draft would raise a control exception on
    # work that was correctly done.
    op.execute(
        "UPDATE alloc_eligibility SET status = 'approved', "
        "approved_by = tested_by, approved_at = tested_at "
        "WHERE tested_at IS NOT NULL"
    )

    # ── 2. Form 1125-A line 9 ─────────────────────────────────────────────────
    # 9a: cost | lower_of_cost_or_market | other
    op.add_column(
        "alloc_settings",
        sa.Column("inv_valuation_method", sa.String(length=30),
                  server_default="cost", nullable=False),
    )
    op.add_column("alloc_settings", sa.Column("inv_valuation_other", sa.Text(), nullable=True))
    # 9b writedown of subnormal goods · 9c LIFO adopted (Form 970)
    op.add_column(
        "alloc_settings",
        sa.Column("inv_writedown_subnormal", sa.Boolean(),
                  server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "alloc_settings",
        sa.Column("lifo_adopted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    # 9d percentage of closing inventory under LIFO
    op.add_column("alloc_settings", sa.Column("lifo_closing_pct", sa.Numeric(7, 4), nullable=True))
    # 9e §263A applies. FALSE for a 280E taxpayer — the whole reason for 471(c).
    op.add_column(
        "alloc_settings",
        sa.Column("sec263a_applies", sa.Boolean(),
                  server_default=sa.text("false"), nullable=False),
    )
    # 9f change in determining quantities / cost / valuations, plus its
    # explanation and whether the Form 3115 that goes with it has been filed.
    op.add_column(
        "alloc_settings",
        sa.Column("method_change_this_year", sa.Boolean(),
                  server_default=sa.text("false"), nullable=False),
    )
    op.add_column("alloc_settings", sa.Column("method_change_note", sa.Text(), nullable=True))
    op.add_column(
        "alloc_settings",
        sa.Column("form_3115_filed", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column("alloc_settings", sa.Column("sec481a_adjustment", sa.Numeric(18, 2), nullable=True))
    op.create_check_constraint(
        "ck_alloc_settings_inv_valuation", "alloc_settings",
        "inv_valuation_method IN ('cost', 'lower_of_cost_or_market', 'other')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_alloc_settings_inv_valuation", "alloc_settings", type_="check")
    for col in (
        "sec481a_adjustment", "form_3115_filed", "method_change_note",
        "method_change_this_year", "sec263a_applies", "lifo_closing_pct",
        "lifo_adopted", "inv_writedown_subnormal", "inv_valuation_other",
        "inv_valuation_method",
    ):
        op.drop_column("alloc_settings", col)

    op.drop_constraint("ck_alloc_eligibility_status", "alloc_eligibility", type_="check")
    for col in ("approved_at", "approved_by", "status"):
        op.drop_column("alloc_eligibility", col)
