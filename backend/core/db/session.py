from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, with_loader_criteria

from core.config import settings
from core.db.base import TenantBase, current_tenant_id

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    # Supabase free tier allows ~10 pooled connections; stay well under that limit.
    pool_size=5,
    max_overflow=5,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


@event.listens_for(Session, "do_orm_execute")
def _apply_tenant_filter(execute_state: object) -> None:
    """
    Session-level event that enforces tenant isolation on all ORM SELECTs.

    `do_orm_execute` is a Session event (not a mapper event), so it must be
    registered on the Session class, not on Base. It fires for every ORM
    execution — we guard with is_select and all_mappers checks to apply the
    WHERE clause only when relevant.

    Fires for both sync and async sessions because AsyncSession wraps a
    sync Session internally.
    """
    from sqlalchemy.orm.context import ORMExecuteState  # avoid import cycle at module level

    state: ORMExecuteState = execute_state  # type: ignore[assignment]

    if (
        not state.is_select
        or state.is_column_load
        or state.is_relationship_load
        or state.execution_options.get("skip_tenant_filter", False)
    ):
        return

    # Only enforce if this query touches a TenantBase-mapped table
    involves_tenant_model = any(
        issubclass(mapper.class_, TenantBase) for mapper in state.all_mappers
    )
    if not involves_tenant_model:
        return

    tenant_id = current_tenant_id.get()
    if tenant_id is None:
        raise RuntimeError(
            "SELECT on a TenantBase model with no active tenant context. "
            "The tenant middleware must run before any query, or pass "
            "execution_options={'skip_tenant_filter': True} for admin queries."
        )

    state.statement = state.statement.options(
        with_loader_criteria(
            TenantBase,
            lambda cls: cls.tenant_id == tenant_id,  # noqa: B023
            include_aliases=True,
        )
    )


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session for a single request."""
    async with AsyncSessionLocal() as session:
        yield session


@asynccontextmanager
async def get_async_session_context() -> AsyncGenerator[AsyncSession, None]:
    """
    Context manager for use outside of FastAPI (Celery tasks, scripts).

    Usage:
        async with get_async_session_context() as session:
            ...
    """
    async with AsyncSessionLocal() as session:
        yield session
