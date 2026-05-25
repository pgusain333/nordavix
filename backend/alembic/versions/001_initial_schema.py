"""Initial schema

Revision ID: 001
Revises:
Create Date: 2026-05-23 00:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

from alembic import op

revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── tenants ───────────────────────────────────────────────────────────────
    # No tenant_id here — this IS the tenant table
    op.create_table(
        "tenants",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("clerk_org_id", sa.String(255), nullable=False),
        sa.Column("settings", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_unique_constraint("uq_tenants_clerk_org_id", "tenants", ["clerk_org_id"])
    op.create_index("ix_tenants_clerk_org_id", "tenants", ["clerk_org_id"])

    # ── users ─────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("clerk_user_id", sa.String(255), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("role", sa.String(50), nullable=False, server_default="member"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_unique_constraint("uq_users_clerk_user_id", "users", ["clerk_user_id"])
    op.create_index("ix_users_tenant_id", "users", ["tenant_id"])
    op.create_index("ix_users_clerk_user_id", "users", ["clerk_user_id"])

    # ── trial_balances ────────────────────────────────────────────────────────
    op.create_table(
        "trial_balances",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("period_current", sa.Date, nullable=False),
        sa.Column("period_prior", sa.Date, nullable=False),
        sa.Column("status", sa.String(50), nullable=False, server_default="pending"),
        sa.Column("r2_key", sa.String(500)),
        sa.Column("materiality_threshold", sa.Numeric(18, 2), nullable=False),
        sa.Column("column_mapping", JSONB, nullable=False, server_default="{}"),
        sa.Column("fs_line_mapping", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_by", UUID(as_uuid=True), nullable=False),
        sa.Column("error_detail", sa.String(1000)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
    )
    op.create_index("ix_trial_balances_tenant_id", "trial_balances", ["tenant_id"])

    # ── accounts ──────────────────────────────────────────────────────────────
    op.create_table(
        "accounts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("trial_balance_id", UUID(as_uuid=True), nullable=False),
        sa.Column("account_number", sa.String(50), nullable=False),
        sa.Column("account_name", sa.String(255), nullable=False),
        sa.Column("current_balance", sa.Numeric(18, 4), nullable=False),
        sa.Column("prior_balance", sa.Numeric(18, 4), nullable=False),
        sa.Column("fs_category", sa.String(50)),
        sa.Column("fs_line", sa.String(100)),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["trial_balance_id"], ["trial_balances.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_accounts_tenant_id", "accounts", ["tenant_id"])
    op.create_index("ix_accounts_trial_balance_id", "accounts", ["trial_balance_id"])

    # ── variances ─────────────────────────────────────────────────────────────
    op.create_table(
        "variances",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("account_id", UUID(as_uuid=True), nullable=False),
        sa.Column("dollar_variance", sa.Numeric(18, 4), nullable=False),
        sa.Column("pct_variance", sa.Numeric(12, 4)),  # NULL when prior_balance = 0
        sa.Column("is_material", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("anomaly_flags", JSONB, nullable=False, server_default="[]"),
        sa.Column("status", sa.String(50), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_variances_tenant_id", "variances", ["tenant_id"])
    op.create_index("ix_variances_account_id", "variances", ["account_id"])

    # ── narratives ────────────────────────────────────────────────────────────
    op.create_table(
        "narratives",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("variance_id", UUID(as_uuid=True), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("cache_key", sa.String(64), nullable=False),
        sa.Column("confidence_score", sa.Numeric(4, 3)),
        sa.Column("input_tokens", sa.Integer, nullable=False),
        sa.Column("output_tokens", sa.Integer, nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("edited_by", UUID(as_uuid=True)),
        sa.Column("edited_at", sa.DateTime(timezone=True)),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variance_id"], ["variances.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["edited_by"], ["users.id"]),
    )
    op.create_unique_constraint("uq_narratives_variance_id", "narratives", ["variance_id"])
    op.create_unique_constraint("uq_narratives_cache_key", "narratives", ["cache_key"])
    op.create_index("ix_narratives_tenant_id", "narratives", ["tenant_id"])
    op.create_index("ix_narratives_cache_key", "narratives", ["cache_key"])

    # ── audit_log ─────────────────────────────────────────────────────────────
    # No FK on user_id — deleted users must still appear in the audit trail (SOC 2)
    op.create_table(
        "audit_log",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True)),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("entity_type", sa.String(100)),
        sa.Column("entity_id", UUID(as_uuid=True)),
        sa.Column("event_data", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_audit_log_tenant_id", "audit_log", ["tenant_id"])
    op.create_index("ix_audit_log_created_at", "audit_log", ["created_at"])

    # ── ai_usage ──────────────────────────────────────────────────────────────
    op.create_table(
        "ai_usage",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", UUID(as_uuid=True), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("input_tokens", sa.Integer, nullable=False),
        sa.Column("output_tokens", sa.Integer, nullable=False),
        sa.Column("cost_usd_estimate", sa.Numeric(10, 6), nullable=False),
        sa.Column("operation", sa.String(100)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )
    # Compound index supports "total tokens this month for tenant X" query
    op.create_index("ix_ai_usage_tenant_created", "ai_usage", ["tenant_id", "created_at"])


def downgrade() -> None:
    op.drop_table("ai_usage")
    op.drop_table("audit_log")
    op.drop_table("narratives")
    op.drop_table("variances")
    op.drop_table("accounts")
    op.drop_table("trial_balances")
    op.drop_table("users")
    op.drop_table("tenants")
