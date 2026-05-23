import asyncio
import os
import uuid
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from core.db.base import Base, current_tenant_id

# Tests run against a dedicated test database — never the dev or prod DB.
# Run Docker Compose before running tests: docker compose up -d postgres
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://nordavix:nordavix_dev@localhost:5432/nordavix_test",
)


@pytest.fixture(scope="session")
def event_loop() -> asyncio.AbstractEventLoop:
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def test_engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        # Import models to register them with Base.metadata before create_all
        import models  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
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
