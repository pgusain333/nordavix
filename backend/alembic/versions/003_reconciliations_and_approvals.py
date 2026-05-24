"""Reconciliations module + approval tracking for analyses/variances

Revision ID: 003
Revises: 002
Create Date: 2026-05-24 04:00:00.000000

Adds:
- reconciliations: header per AR/AP/Bank/CC reconciliation run
- reconciliation_items: per-customer/vendor row (GL vs subledger)
- recon_transactions: unmatched / unapplied / duplicate txn evidence for detail page
- recon_notes: free-text notes attached to a reconciliation or item
- TrialBalance.approved_by / approved_at, Variance.approved_by / approved_at
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── reconciliations ────────────────────────────────────────────────────────
    op.create_table(
        "reconciliations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        # AR | AP | BANK | CC | OTHER
        sa.Column("recon_type", sa.String(20), nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),
        # Snapshot of totals at time of run
        sa.Column("gl_total", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("subledger_total", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("difference", sa.Numeric(18, 2), nullable=False, server_default="0"),
        # pending | syncing | computing | in_review | approved | error
        sa.Column("status", sa.String(30), nullable=False, server_default="pending"),
        # Aggregate AI commentary for the whole reconciliation
        sa.Column("ai_summary", sa.Text),
        sa.Column("assigned_to", UUID(as_uuid=True)),
        sa.Column("approved_by", UUID(as_uuid=True)),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("error_detail", sa.String(1000)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_reconciliations_tenant_id", "reconciliations", ["tenant_id"])
    op.create_index("ix_reconciliations_type_period", "reconciliations", ["recon_type", "period_end"])

    # ── reconciliation_items (per customer / vendor / account) ─────────────────
    op.create_table(
        "reconciliation_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("reconciliation_id", UUID(as_uuid=True), nullable=False),
        # QBO entity refs — kept as strings since QBO Ids are stable
        sa.Column("entity_name", sa.String(255), nullable=False),
        sa.Column("entity_qbo_id", sa.String(50)),
        # Balances at period_end
        sa.Column("gl_balance", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("subledger_balance", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("difference", sa.Numeric(18, 2), nullable=False, server_default="0"),
        # Aging buckets (subledger side)
        sa.Column("aging_current", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("aging_1_30", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("aging_31_60", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("aging_61_90", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("aging_over_90", sa.Numeric(18, 2), nullable=False, server_default="0"),
        # low | medium | high — computed by service
        sa.Column("risk_level", sa.String(10), nullable=False, server_default="low"),
        # pending | reviewed | approved | flagged | resolved
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("ai_commentary", sa.Text),
        sa.Column("approved_by", UUID(as_uuid=True)),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("notes", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reconciliation_id"], ["reconciliations.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_reconciliation_items_tenant_id", "reconciliation_items", ["tenant_id"])
    op.create_index("ix_reconciliation_items_recon_id", "reconciliation_items", ["reconciliation_id"])

    # ── recon_transactions (unmatched/unapplied/duplicate evidence) ────────────
    op.create_table(
        "recon_transactions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("reconciliation_item_id", UUID(as_uuid=True), nullable=False),
        # Invoice | Payment | CreditMemo | JournalEntry | Bill | VendorCredit
        sa.Column("txn_type", sa.String(50), nullable=False),
        sa.Column("txn_number", sa.String(100)),
        sa.Column("txn_date", sa.Date),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("memo", sa.String(500)),
        # unmatched | unapplied_cash | duplicate | manual_je
        sa.Column("category", sa.String(30), nullable=False),
        # Free-form extra context, e.g. {"duplicate_of": "INV-1234"}
        sa.Column("meta", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reconciliation_item_id"], ["reconciliation_items.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_recon_transactions_tenant_id", "recon_transactions", ["tenant_id"])
    op.create_index("ix_recon_transactions_item_id", "recon_transactions", ["reconciliation_item_id"])
    op.create_index("ix_recon_transactions_category", "recon_transactions", ["category"])

    # ── recon_notes (audit trail) ──────────────────────────────────────────────
    op.create_table(
        "recon_notes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("reconciliation_id", UUID(as_uuid=True), nullable=False),
        # Null if note is attached to the recon as a whole, else the specific item
        sa.Column("reconciliation_item_id", UUID(as_uuid=True)),
        sa.Column("author_id", UUID(as_uuid=True), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reconciliation_id"], ["reconciliations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reconciliation_item_id"], ["reconciliation_items.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_recon_notes_recon_id", "recon_notes", ["reconciliation_id"])

    # ── Approval columns on flux models ────────────────────────────────────────
    op.add_column("trial_balances", sa.Column("approved_by", UUID(as_uuid=True)))
    op.add_column("trial_balances", sa.Column("approved_at", sa.DateTime(timezone=True)))
    op.add_column("variances", sa.Column("approved_by", UUID(as_uuid=True)))
    op.add_column("variances", sa.Column("approved_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("variances", "approved_at")
    op.drop_column("variances", "approved_by")
    op.drop_column("trial_balances", "approved_at")
    op.drop_column("trial_balances", "approved_by")
    op.drop_table("recon_notes")
    op.drop_table("recon_transactions")
    op.drop_table("reconciliation_items")
    op.drop_table("reconciliations")
