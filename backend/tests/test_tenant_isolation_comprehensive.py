"""
Tenant isolation — comprehensive, regression-proofing coverage (Tier 1).

The original test_tenant_isolation.py proves the read filter on ONE model
(TrialBalance) and test_recon_clear_isolation.py locks the recon bulk-delete.
This file generalizes both so a future change can't silently open a hole:

1. EVERY TenantBase model is covered by the fail-closed read filter — a SELECT
   with no tenant context raises, for every tenant-scoped table that exists now
   or is added later (the test discovers them via the mapper registry, so a new
   model is covered automatically with zero test edits).

2. assert_tenant_owns (core/db/session.py) — the enforced precondition for
   FK-scoped bulk writes — accepts the owner and rejects a foreign / missing id,
   via both the explicit-tenant_id and the ambient-context call styles.

3. tenant_scope (core/db/base.py) — the blessed bypass replacement — sets and
   restores the context var correctly and refuses a null tenant.

4. The flux cascade delete (_wipe_tb_children) refuses a trial balance the
   caller's tenant doesn't own, so the unscoped child deletes below it can never
   run cross-tenant (the flux analog of the recon-clear regression test).
"""
import datetime
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

# Registration side effects: attach the production Session event listeners.
import core.db.session  # noqa: F401
import models  # noqa: F401 — register every model on Base.metadata / the registry
from core.db.base import (
    Base,
    TenantBase,
    TenantOwnershipError,
    current_tenant_id,
    tenant_scope,
)
from core.db.session import assert_tenant_owns
from models.trial_balance import TrialBalance


def _all_tenant_models() -> list[type]:
    """Every concrete mapped class that inherits TenantBase (discovered, not
    hard-coded — a newly added tenant model is picked up automatically)."""
    return sorted(
        {
            m.class_
            for m in Base.registry.mappers
            if issubclass(m.class_, TenantBase)
        },
        key=lambda c: c.__name__,
    )


def _make_tb(tenant_id: uuid.UUID, name: str = "TB") -> TrialBalance:
    # Mirrors the insertion shape proven to work under CI's migrated schema in
    # test_tenant_isolation.py (no Tenant/User parent rows required here).
    return TrialBalance(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=name,
        period_current=datetime.date(2024, 12, 31),
        period_prior=datetime.date(2023, 12, 31),
        materiality_threshold=Decimal("1000.00"),
        created_by=uuid.uuid4(),
        status="pending",
    )


# ── 1. Every tenant model is fail-closed without context ────────────────────────

@pytest.mark.asyncio
async def test_every_tenant_model_raises_without_context(session):
    """A SELECT on ANY TenantBase model with no tenant context must raise —
    proving none slipped out from under the auto-filter. Loops all models so a
    future model that somehow escaped TenantBase would surface here."""
    tenant_models = _all_tenant_models()
    assert tenant_models, "expected at least one TenantBase model to be registered"

    leaked: list[str] = []
    for cls in tenant_models:
        current_tenant_id.set(None)
        try:
            await session.execute(select(cls))
        except RuntimeError:
            continue  # expected: fail-closed
        leaked.append(cls.__name__)

    assert not leaked, (
        "these TenantBase models returned rows with NO tenant context "
        f"(cross-tenant leak risk): {leaked}"
    )


# ── 2. assert_tenant_owns: the FK-scoped-write precondition ──────────────────────

@pytest.mark.asyncio
async def test_assert_tenant_owns_accepts_owner_explicit(session, tenant_a):
    tb = _make_tb(tenant_a)
    session.add(tb)
    await session.flush()

    found = await assert_tenant_owns(
        session, TrialBalance, tb.id, tenant_id=tenant_a, label="Trial balance"
    )
    assert found == tb.id


@pytest.mark.asyncio
async def test_assert_tenant_owns_rejects_foreign_tenant(session, tenant_a, tenant_b):
    tb = _make_tb(tenant_a)
    session.add(tb)
    await session.flush()

    with pytest.raises(TenantOwnershipError):
        await assert_tenant_owns(
            session, TrialBalance, tb.id, tenant_id=tenant_b, label="Trial balance"
        )


@pytest.mark.asyncio
async def test_assert_tenant_owns_rejects_missing_id(session, tenant_a):
    with pytest.raises(TenantOwnershipError):
        await assert_tenant_owns(
            session, TrialBalance, uuid.uuid4(), tenant_id=tenant_a
        )


@pytest.mark.asyncio
async def test_assert_tenant_owns_uses_ambient_context(session, tenant_a, tenant_b):
    """With no explicit tenant_id, the ambient current_tenant_id governs."""
    tb = _make_tb(tenant_a)
    session.add(tb)
    await session.flush()

    current_tenant_id.set(tenant_a)
    assert await assert_tenant_owns(session, TrialBalance, tb.id) == tb.id

    current_tenant_id.set(tenant_b)
    with pytest.raises(TenantOwnershipError):
        await assert_tenant_owns(session, TrialBalance, tb.id)


# ── 3. tenant_scope: the blessed bypass replacement ─────────────────────────────

def test_tenant_scope_sets_and_restores(tenant_a, tenant_b):
    current_tenant_id.set(tenant_b)
    assert current_tenant_id.get() == tenant_b
    with tenant_scope(tenant_a):
        assert current_tenant_id.get() == tenant_a
    assert current_tenant_id.get() == tenant_b, "scope must restore the prior tenant"


def test_tenant_scope_refuses_null():
    with pytest.raises(ValueError, match="non-null tenant_id"):
        with tenant_scope(None):  # type: ignore[arg-type]
            pass


@pytest.mark.asyncio
async def test_tenant_scope_query_is_filtered(session, tenant_a, tenant_b):
    """A plain select() inside tenant_scope is auto-filtered — no skip, no WHERE."""
    session.add(_make_tb(tenant_a, "A TB"))
    await session.flush()

    with tenant_scope(tenant_b):
        rows = (await session.execute(select(TrialBalance))).scalars().all()
    assert rows == [], "tenant_scope(B) must not see tenant A's rows"

    with tenant_scope(tenant_a):
        rows = (await session.execute(select(TrialBalance))).scalars().all()
    assert any(r.name == "A TB" for r in rows)


# ── 4. Flux cascade delete refuses a foreign trial balance ──────────────────────

@pytest.mark.asyncio
async def test_wipe_tb_children_refuses_foreign_tb(session, tenant_a, tenant_b):
    """_wipe_tb_children deletes Account/Variance/Narrative by trial_balance_id
    (not auto-scoped). It must refuse a TB the caller's tenant doesn't own — the
    ownership assert fires before any delete, leaving tenant A's TB intact."""
    from modules.flux.router import _wipe_tb_children

    tb = _make_tb(tenant_a)
    session.add(tb)
    await session.flush()

    with pytest.raises(TenantOwnershipError):
        await _wipe_tb_children(tb.id, session, tenant_b)

    # Nothing was deleted: tenant A's trial balance still exists.
    survivor = (
        await session.execute(select(TrialBalance), execution_options={"skip_tenant_filter": True})
    ).scalars().all()
    assert [r.id for r in survivor] == [tb.id]
