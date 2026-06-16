import os
import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from core.db.base import Base, current_tenant_id

# Tests run against a dedicated test database — never the dev or prod DB.
# Run Docker Compose before running tests: docker compose up -d postgres
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://nordavix:nordavix_dev@localhost:5432/nordavix_test",
)


# NOTE: no custom `event_loop` fixture. pytest-asyncio >= 0.23 with
# `asyncio_mode = "auto"` manages the loop itself; a hand-rolled session-scoped
# event_loop is deprecated and was the source of the intermittent
# "ScopeMismatch / Future attached to a different loop" flake in the async
# (tenant-isolation) suite. Keeping every async fixture function-scoped means
# they all share that auto-managed per-test loop — no scope mismatch.
@pytest_asyncio.fixture
async def test_engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        # Import models to register them with Base.metadata before create_all
        import models  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    # Tear down with DROP SCHEMA ... CASCADE rather than Base.metadata.drop_all:
    # CI runs `alembic upgrade head` first, which builds FK constraints that are
    # NOT declared on the ORM models, so metadata-ordered drop_all can't drop a
    # parent table whose children it doesn't know about ("cannot drop table
    # variances because other objects depend on it"). CASCADE drops the whole
    # dependency graph regardless of where each constraint came from.
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await engine.dispose()


@pytest_asyncio.fixture
async def session(test_engine) -> AsyncGenerator[AsyncSession, None]:
    """
    Yields a session that rolls back all changes after each test.
    Keeps tests isolated without truncating tables between runs.
    """
    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    async with factory() as s:
        async with s.begin():
            yield s
            await s.rollback()


@pytest.fixture
def tenant_a() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def tenant_b() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture(autouse=True)
def reset_tenant_context():
    """Reset the tenant ContextVar after every test to prevent leakage between tests."""
    token = current_tenant_id.set(None)
    yield
    current_tenant_id.reset(token)


# ── Deploy-gating "invariant" suites ───────────────────────────────────────────
# These pure, deterministic accounting-correctness tests BLOCK the deploy in CI
# (`pytest -m invariant`). They're tagged here by filename — rather than a
# per-file `pytestmark` — so the test modules stay import-light and still run
# standalone (`python tests/<file>.py`) in envs without pytest installed (this
# repo's runtime venv is one). Keep this set in sync when adding a gating suite.
_INVARIANT_FILES = {
    "test_expectation.py",        # expectation tolerance / NaN+∞ safety
    "test_proposed_entries.py",   # JE balance (Σ debit == Σ credit)
    "test_cash_flow_tieout.py",   # CFS ↔ BS cash tie-out
    "test_gl_accuracy_engine.py", # misclassification detector (no false positives)
    "test_memory_context.py",     # memory note matcher (no cross-account bleed)
    "test_recon_tieout.py",       # recon tie-out gate (RECON_TOLERANCE + is_reconciled)
    "test_schedule_rollforward.py", # loan/lease inception-month interest accrual
    "test_tb_integrity.py",       # trial-balance ingest tie-out (tb_imbalance)
    "test_sign_conventions.py",   # statement sign convention (_signed_for_display)
    "test_qbo_retry.py",          # QBO 429 / 5xx retry-backoff contract
    "test_qbo_token_refresh.py",  # per-realm serialized token refresh (no race)
}


def pytest_collection_modifyitems(config, items):
    for item in items:
        if item.path.name in _INVARIANT_FILES:
            item.add_marker(pytest.mark.invariant)
