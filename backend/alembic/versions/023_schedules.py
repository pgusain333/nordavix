"""Schedules module — Prepaids, Accruals, Fixed Assets, Leases, Loans

Revision ID: 023
Revises: 022
Create Date: 2026-05-27 19:00:00.000000

Adds support for supporting schedules — the per-account workpapers that
back balance-sheet GL accounts that aren't reconciled via a subledger
QBO can export (AR/AP aging) or a bank statement. These are accountant-
maintained registers: a list of prepaid invoices, fixed assets, loans,
leases, accrued items.

Each schedule type gets its own table (different columns + validation),
plus one shared schedule_snapshots table that records the period-end
roll-forward and links the schedule to the corresponding GL account's
reconciliation by writing into account_review_status.subledger_total.

Five item tables:
  - schedule_prepaids       — paid-up-front items, amortized straight-line
  - schedule_accruals       — expenses incurred but not paid; reverse on payment
  - schedule_fixed_assets   — capitalized assets w/ straight-line depreciation
  - schedule_leases         — operating leases (+ optional ASC 842 fields)
  - schedule_loans          — term loans with computed amortization

One header table:
  - schedule_snapshots      — period-end roll-forward (beg / add / exp / pay / end)
                              committed snapshot writes to account_review_status,
                              making the recon module read the schedule value
                              as the subledger automatically.

Indexes follow the rest of the app: tenant_id always indexed, plus
(qbo_account_id, period_end) on snapshots for the recon-lookup path.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "023"
down_revision: str | None = "022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _common_cols() -> list[sa.Column]:
    """Columns every schedule_* item table shares."""
    return [
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        # The GL account this schedule item rolls up to. We store the QBO
        # account id directly so the lookup is fast and survives TB resyncs.
        sa.Column("qbo_account_id", sa.String(50), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("vendor", sa.String(255)),
        sa.Column("reference", sa.String(255)),  # invoice / contract / asset tag
        sa.Column("notes", sa.Text),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("created_by", UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    ]


def upgrade() -> None:
    # ── Prepaids ──────────────────────────────────────────────────────────────
    op.create_table(
        "schedule_prepaids",
        *_common_cols(),
        sa.Column("invoice_date", sa.Date),
        sa.Column("total_amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("start_date", sa.Date, nullable=False),  # amortization start
        sa.Column("end_date", sa.Date, nullable=False),    # amortization end
    )
    op.create_index("ix_schedule_prepaids_tenant_id", "schedule_prepaids", ["tenant_id"])
    op.create_index("ix_schedule_prepaids_account", "schedule_prepaids", ["tenant_id", "qbo_account_id"])

    # ── Accruals ──────────────────────────────────────────────────────────────
    op.create_table(
        "schedule_accruals",
        *_common_cols(),
        sa.Column("accrual_date", sa.Date, nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("reverses_on", sa.Date),     # date the accrual reverses (typically paid)
        sa.Column("is_reversed", sa.Boolean, nullable=False, server_default=sa.text("false")),
    )
    op.create_index("ix_schedule_accruals_tenant_id", "schedule_accruals", ["tenant_id"])
    op.create_index("ix_schedule_accruals_account", "schedule_accruals", ["tenant_id", "qbo_account_id"])

    # ── Fixed Assets ──────────────────────────────────────────────────────────
    op.create_table(
        "schedule_fixed_assets",
        *_common_cols(),
        sa.Column("category", sa.String(100)),  # Furniture, Equipment, etc.
        sa.Column("in_service_date", sa.Date, nullable=False),
        sa.Column("cost", sa.Numeric(18, 2), nullable=False),
        sa.Column("salvage_value", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("useful_life_months", sa.Integer, nullable=False),
        sa.Column("depreciation_method", sa.String(20), nullable=False, server_default=sa.text("'straight_line'")),
        # Optional: which accumulated-depreciation GL account is paired with cost
        sa.Column("accumulated_dep_qbo_account_id", sa.String(50)),
        sa.Column("disposed_on", sa.Date),
        sa.Column("disposal_proceeds", sa.Numeric(18, 2)),
    )
    op.create_index("ix_schedule_fixed_assets_tenant_id", "schedule_fixed_assets", ["tenant_id"])
    op.create_index("ix_schedule_fixed_assets_account", "schedule_fixed_assets", ["tenant_id", "qbo_account_id"])

    # ── Leases ────────────────────────────────────────────────────────────────
    op.create_table(
        "schedule_leases",
        *_common_cols(),
        sa.Column("lessor", sa.String(255)),
        sa.Column("lease_start", sa.Date, nullable=False),
        sa.Column("lease_end", sa.Date, nullable=False),
        sa.Column("monthly_payment", sa.Numeric(18, 2), nullable=False),
        # ASC 842 fields — optional. Filled when the lease is on the
        # balance sheet (modern GAAP). Empty for cash-basis lease tracking.
        sa.Column("discount_rate_pct", sa.Numeric(6, 4)),  # e.g. 5.2500
        sa.Column("initial_rou_asset", sa.Numeric(18, 2)),
        sa.Column("initial_liability", sa.Numeric(18, 2)),
        # Optional pairing — when ASC 842 is used, the liability sits on
        # one account and ROU asset on another. The qbo_account_id on
        # the common cols is the LIABILITY; this points to the ROU asset.
        sa.Column("rou_qbo_account_id", sa.String(50)),
    )
    op.create_index("ix_schedule_leases_tenant_id", "schedule_leases", ["tenant_id"])
    op.create_index("ix_schedule_leases_account", "schedule_leases", ["tenant_id", "qbo_account_id"])

    # ── Loans ─────────────────────────────────────────────────────────────────
    op.create_table(
        "schedule_loans",
        *_common_cols(),
        sa.Column("lender", sa.String(255)),
        sa.Column("loan_date", sa.Date, nullable=False),
        sa.Column("original_principal", sa.Numeric(18, 2), nullable=False),
        sa.Column("interest_rate_pct", sa.Numeric(6, 4), nullable=False),  # annual %
        sa.Column("term_months", sa.Integer, nullable=False),
        sa.Column("monthly_payment", sa.Numeric(18, 2)),  # required for amortizing loans
        # amortizing | interest_only | balloon
        sa.Column("payment_type", sa.String(20), nullable=False, server_default=sa.text("'amortizing'")),
    )
    op.create_index("ix_schedule_loans_tenant_id", "schedule_loans", ["tenant_id"])
    op.create_index("ix_schedule_loans_account", "schedule_loans", ["tenant_id", "qbo_account_id"])

    # ── Snapshot header — period-end roll-forward per schedule type+account ──
    # The snapshot is what links a schedule to the reconciliation: at commit
    # time, the snapshot's ending_balance is written to the matching
    # account_review_status row's subledger_total, and the recon module
    # picks it up on the next render.
    op.create_table(
        "schedule_snapshots",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("schedule_type", sa.String(20), nullable=False),
        sa.Column("qbo_account_id", sa.String(50), nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),
        sa.Column("beginning_balance", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("additions", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("period_expense", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("payments", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("other", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("ending_balance", sa.Numeric(18, 2), nullable=False, server_default=sa.text("0")),
        sa.Column("item_count", sa.Integer, nullable=False, server_default=sa.text("0")),
        # draft | committed
        sa.Column("status", sa.String(20), nullable=False, server_default=sa.text("'draft'")),
        sa.Column("committed_by", UUID(as_uuid=True)),
        sa.Column("committed_at", sa.DateTime(timezone=True)),
        sa.Column("notes", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_schedule_snapshots_tenant_id", "schedule_snapshots", ["tenant_id"])
    op.create_index(
        "ix_schedule_snapshots_account_period",
        "schedule_snapshots",
        ["tenant_id", "qbo_account_id", "period_end"],
    )
    # One snapshot per (tenant, type, account, period) — re-running the
    # roll-forward upserts in place rather than stacking duplicates.
    op.create_unique_constraint(
        "uq_schedule_snapshots_type_account_period",
        "schedule_snapshots",
        ["tenant_id", "schedule_type", "qbo_account_id", "period_end"],
    )


def downgrade() -> None:
    op.drop_table("schedule_snapshots")
    op.drop_table("schedule_loans")
    op.drop_table("schedule_leases")
    op.drop_table("schedule_fixed_assets")
    op.drop_table("schedule_accruals")
    op.drop_table("schedule_prepaids")
