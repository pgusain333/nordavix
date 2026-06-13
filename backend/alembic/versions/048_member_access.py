"""member access: delegated_powers + suspended on users

Adds the per-member capability layer behind the Team access panel:
  * delegated_powers — JSONB array of admin-powers granted to a non-admin
    (subset of {autopilot, pbc, period_lock, qbo}); admins implicitly have all.
  * suspended        — view-only flag; the tenant middleware turns a suspended
    member's request read-only (DB writes blocked) so they can look, not touch.

Revision ID: 048_member_access
Revises: 047_advisory
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "048"
down_revision = "047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "delegated_powers",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "suspended",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "suspended")
    op.drop_column("users", "delegated_powers")
