import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, nullcontext

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, with_loader_criteria

from core.config import settings
from core.db.base import (
    DemoReadOnlyError,
    TenantBase,
    TenantOwnershipError,
    current_request_readonly,
    current_tenant_id,
    tenant_scope,
)

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
    from sqlalchemy.orm import ORMExecuteState  # avoid import cycle at module level

    state: ORMExecuteState = execute_state  # type: ignore[assignment]

    # Read-only (demo) requests may not write. Block ORM-emitted DML here; the
    # before_flush guard below covers unit-of-work (session.add/dirty/delete)
    # writes. Together they make the demo tenant truly immutable per request.
    if current_request_readonly.get() and (
        state.is_insert or state.is_update or state.is_delete
    ):
        raise DemoReadOnlyError("Sample company is read-only.")

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


@event.listens_for(Session, "before_flush")
def _block_readonly_flush(
    session: Session, flush_context: object, instances: object,  # noqa: ARG001
) -> None:
    """Hard read-only guarantee for demo requests.

    If anything tries to flush new/changed/deleted rows while the request is
    flagged read-only, refuse. This makes "the sample company is read-only" a
    true DB-layer invariant rather than a per-HTTP-method whitelist — even a GET
    handler that opportunistically writes (e.g. an email backfill, the /me
    welcome stamp) can never mutate the shared demo tenant. Mapped to 403.
    """
    if not current_request_readonly.get():
        return
    if session.new or session.dirty or session.deleted:
        raise DemoReadOnlyError("Sample company is read-only.")


async def assert_tenant_owns(
    db: AsyncSession,
    model: type,
    entity_id: object,
    *,
    tenant_id: uuid.UUID | None = None,
    label: str | None = None,
) -> object:
    """Enforce tenant ownership of a row BEFORE an unscoped bulk write.

    The session SELECT filter is fail-closed, but a bulk DELETE/UPDATE keyed on
    a foreign key (e.g. `delete(Account).where(trial_balance_id == :tb)`) is NOT
    auto-scoped — its safety depends entirely on the caller having validated the
    parent row's tenant ownership first. That made write-path isolation a
    convention ("every caller must SELECT-to-validate before deleting by id")
    rather than an enforced invariant.

    This helper makes the check an explicit, reusable precondition: it runs a
    tenant-scoped SELECT for the row's primary key and raises
    TenantOwnershipError (→ HTTP 404) if the CURRENT tenant does not own it, or
    it does not exist. Call it immediately before the bulk write so the write
    below can never reach another tenant's rows.

    Pass `tenant_id` to pin the check to a specific tenant (background/service
    code that holds the id explicitly); omit it to use the ambient request
    context. `model` must expose an `id` primary key (the convention across
    every tenant-scoped model in this app)."""
    pk = model.id  # type: ignore[attr-defined]
    scope = tenant_scope(tenant_id) if tenant_id is not None else nullcontext()
    with scope:
        found = (
            await db.execute(select(pk).where(pk == entity_id))
        ).scalar_one_or_none()
    if found is None:
        raise TenantOwnershipError(label or model.__name__, entity_id)
    return found


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
