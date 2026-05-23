"""
Critical: tenant isolation must be airtight.

These tests verify that:
1. Queries without tenant context raise RuntimeError (no silent cross-tenant leakage)
2. Tenant A cannot read Tenant B's data
3. Variance math is correct for standard cases
"""
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

from core.db.base import current_tenant_id
from models.trial_balance import TrialBalance
from modules.flux.service import classify_account, compute_variance, detect_anomalies


# ── Tenant isolation ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_query_without_tenant_context_raises(session):
    """Any SELECT on a TenantBase model without context must fail loudly."""
    current_tenant_id.set(None)
    with pytest.raises(RuntimeError, match="no active tenant context"):
        await session.execute(select(TrialBalance))


@pytest.mark.asyncio
async def test_tenant_a_cannot_see_tenant_b_data(session, tenant_a, tenant_b):
    """Tenant A's records must be invisible when querying as Tenant B."""
    import datetime

    # Insert a record directly for Tenant A (bypass the filter for setup)
    tb = TrialBalance(
        id=uuid.uuid4(),
        tenant_id=tenant_a,
        name="Tenant A TB",
        period_current=datetime.date(2024, 12, 31),
        period_prior=datetime.date(2023, 12, 31),
        materiality_threshold=Decimal("1000.00"),
        created_by=uuid.uuid4(),
        status="pending",
    )
    session.add(tb)
    await session.flush()

    # Query as Tenant B — must return zero rows
    current_tenant_id.set(tenant_b)
    result = await session.execute(select(TrialBalance))
    rows = result.scalars().all()
    assert len(rows) == 0, "Tenant B must not see Tenant A's trial balances"


@pytest.mark.asyncio
async def test_tenant_sees_own_data(session, tenant_a):
    """Tenant A can see its own records when the context is set correctly."""
    import datetime

    current_tenant_id.set(tenant_a)
    tb = TrialBalance(
        id=uuid.uuid4(),
        tenant_id=tenant_a,
        name="My TB",
        period_current=datetime.date(2024, 12, 31),
        period_prior=datetime.date(2023, 12, 31),
        materiality_threshold=Decimal("1000.00"),
        created_by=uuid.uuid4(),
        status="pending",
    )
    session.add(tb)
    await session.flush()

    result = await session.execute(select(TrialBalance))
    rows = result.scalars().all()
    assert any(r.name == "My TB" for r in rows)


# ── Variance math ─────────────────────────────────────────────────────────────

def test_compute_variance_standard():
    dollar, pct = compute_variance(Decimal("120000"), Decimal("100000"))
    assert dollar == Decimal("20000")
    assert pct == Decimal("20.0000")


def test_compute_variance_zero_prior():
    dollar, pct = compute_variance(Decimal("50000"), Decimal("0"))
    assert dollar == Decimal("50000")
    assert pct is None  # no division by zero


def test_compute_variance_decrease():
    dollar, pct = compute_variance(Decimal("80000"), Decimal("100000"))
    assert dollar == Decimal("-20000")
    assert pct == Decimal("-20.0000")


def test_anomaly_sign_flip():
    flags = detect_anomalies(
        Decimal("-5000"), Decimal("5000"), Decimal("-10000"), Decimal("-200.0000")
    )
    assert "sign_flip" in flags


def test_anomaly_new_account():
    flags = detect_anomalies(Decimal("10000"), Decimal("0"), Decimal("10000"), None)
    assert "new_account" in flags


def test_anomaly_large_pct():
    flags = detect_anomalies(
        Decimal("75000"), Decimal("30000"), Decimal("45000"), Decimal("150.0000")
    )
    assert "large_pct_change" in flags


# ── Account classification ────────────────────────────────────────────────────

def test_classify_standard_gaap():
    category, line = classify_account("1200", {})
    assert category == "Assets"
    assert line == "Current Assets"


def test_classify_revenue():
    category, line = classify_account("5100", {})
    assert category == "Revenue"


def test_classify_override():
    overrides = {"9999": "Equity|Retained Earnings"}
    category, line = classify_account("9999", overrides)
    assert category == "Equity"
    assert line == "Retained Earnings"


def test_classify_unknown():
    category, line = classify_account("XXXX", {})
    assert category is None
