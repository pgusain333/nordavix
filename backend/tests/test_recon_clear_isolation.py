"""
Tenant-isolation regression test for the recon bulk-delete paths.

Reproduces and locks down a cross-tenant data-destruction vulnerability found in
the penetration test: the `clear-synced-data` endpoint (and the books
`setup/seed` reset) issued SQLAlchemy delete() statements with NO tenant_id
predicate. The session tenant filter (core/db/session.py) only rewrites
SELECTs — it returns early for INSERT/UPDATE/DELETE — and the backend connects
as the table owner, so Postgres RLS does not scope it either. An unscoped
delete() therefore wiped EVERY tenant's rows, not just the caller's.

Against a real Postgres these tests prove:
  1. an UNSCOPED delete() destroys another tenant's rows (the pre-fix bug), and
  2. the FIXED, tenant-scoped delete() leaves the other tenant's rows intact.
"""
import uuid
from datetime import date

import pytest
from sqlalchemy import delete, select

from core.db.base import current_tenant_id
from models.reconciliation import Reconciliation
from models.tenant import Tenant

# Read back ignoring the tenant filter so the assertions see ALL tenants' rows.
_ALL_ROWS = {"skip_tenant_filter": True}


def _tenant(tenant_id: uuid.UUID, label: str) -> Tenant:
    # reconciliations.tenant_id is a FK -> tenants.id in the migrated (CI) schema,
    # so the parent tenant row must exist before a reconciliation can be inserted.
    # (The ORM's create_all schema used locally omits this FK, which is why the
    # test passed locally but failed under CI's `alembic upgrade head` schema.)
    return Tenant(id=tenant_id, name=label, clerk_org_id=f"org-{tenant_id}")


def _recon(tenant_id: uuid.UUID, name: str) -> Reconciliation:
    return Reconciliation(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        recon_type="BANK",
        period_end=date(2026, 1, 31),
        created_by=uuid.uuid4(),
        status="in_review",
    )


async def _seed(session, tenant_a: uuid.UUID, tenant_b: uuid.UUID) -> None:
    """Insert the parent tenants (FK target), flush, then a reconciliation each."""
    session.add(_tenant(tenant_a, "Tenant A"))
    session.add(_tenant(tenant_b, "Tenant B"))
    await session.flush()
    session.add(_recon(tenant_a, "A recon"))
    session.add(_recon(tenant_b, "B recon"))
    await session.flush()


@pytest.mark.asyncio
async def test_unscoped_delete_is_cross_tenant(session, tenant_a, tenant_b):
    """The vulnerability: delete() with no tenant predicate wipes BOTH tenants."""
    current_tenant_id.set(tenant_a)
    await _seed(session, tenant_a, tenant_b)

    # The OLD, vulnerable statement — no .where(tenant_id == ...).
    await session.execute(delete(Reconciliation))
    await session.flush()

    remaining = (
        await session.execute(select(Reconciliation), execution_options=_ALL_ROWS)
    ).scalars().all()
    assert remaining == [], (
        "unscoped delete wiped every tenant — this is the bug the fix closes"
    )


@pytest.mark.asyncio
async def test_scoped_delete_preserves_other_tenant(session, tenant_a, tenant_b):
    """The FIX: scoping the delete to the caller's tenant leaves tenant B intact."""
    current_tenant_id.set(tenant_a)
    await _seed(session, tenant_a, tenant_b)

    # The FIXED statement — exactly what clear_synced_data now runs per table.
    await session.execute(
        delete(Reconciliation).where(Reconciliation.tenant_id == tenant_a)
    )
    await session.flush()

    remaining = (
        await session.execute(select(Reconciliation), execution_options=_ALL_ROWS)
    ).scalars().all()
    assert [r.tenant_id for r in remaining] == [tenant_b], (
        "tenant B's reconciliation must survive a tenant-scoped clear"
    )
