"""Allow one User row per (clerk_user_id, tenant_id) pair

Revision ID: 022
Revises: 021
Create Date: 2026-05-27 18:00:00.000000

Migration 001 created the users table with a unique constraint on
clerk_user_id ALONE:

    op.create_unique_constraint("uq_users_clerk_user_id", "users", ["clerk_user_id"])

That made each Clerk user single-tenant at the DB level. The tenancy
middleware was later rewritten to look up / provision a User row PER
(clerk_user_id, tenant_id) pair so the same Clerk identity can belong
to multiple workspaces with independent roles — but the schema was
never relaxed to match. Result: when a user (e.g. the founder) tried
to create a SECOND workspace, the middleware's User INSERT collided
with their existing row and failed. The founder ended up still bound
to their old tenant — appearing as a non-member / non-admin in the
new workspace's Team page, and blocked from connecting QBO (admin-only
endpoint).

This migration:
  • Drops the single-column unique constraint uq_users_clerk_user_id.
  • Drops the matching unique index if Postgres auto-created one.
  • Adds a composite unique constraint on (clerk_user_id, tenant_id)
    so each Clerk identity gets exactly one row per workspace.
  • Keeps a plain (non-unique) index on clerk_user_id for the lookup
    paths that filter by user alone (Clerk webhooks, admin tools).

Downgrade is a best-effort restore. If multiple rows for the same
clerk_user_id exist by then (the very situation this migration
enables), the downgrade will fail at the unique-constraint creation
step — which is the correct behavior; we don't want to silently lose
per-tenant rows.
"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "022"
down_revision: str | None = "021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. Drop the legacy single-column unique constraint.
    op.drop_constraint("uq_users_clerk_user_id", "users", type_="unique")

    # 2. Recreate the index on clerk_user_id as a NON-unique index. The
    #    original migration added both a unique constraint AND a plain
    #    `ix_users_clerk_user_id` index — Postgres may have folded the
    #    two together depending on the alembic version. Drop-and-recreate
    #    to guarantee a non-unique index regardless of how it ended up
    #    being represented on disk.
    op.drop_index("ix_users_clerk_user_id", table_name="users", if_exists=True)
    op.create_index("ix_users_clerk_user_id", "users", ["clerk_user_id"], unique=False)

    # 3. Add the composite unique constraint that actually matches the
    #    middleware's lookup contract.
    op.create_unique_constraint(
        "uq_users_clerk_user_id_tenant_id",
        "users",
        ["clerk_user_id", "tenant_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_users_clerk_user_id_tenant_id", "users", type_="unique")
    # Restore the original single-column unique constraint. Will fail if
    # multiple rows for the same clerk_user_id now exist — by design.
    op.create_unique_constraint("uq_users_clerk_user_id", "users", ["clerk_user_id"])
