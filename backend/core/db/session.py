import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, nullcontext

from sqlalchemy import event, select, text
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

# ── Engines (Tier 2 RLS: two logins) ────────────────────────────────────────
# SYSTEM engine — the main login (Supabase `postgres`, which has BYPASSRLS). Used
# for auth/bootstrap, background jobs, the purge, and public/no-tenant-context
# routes. It BYPASSES Row-Level Security — correct for cross-tenant/system work.
# Supabase free tier allows ~10 pooled connections; stay well under that limit.
system_engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=5,
)
engine = system_engine  # backwards-compatible alias for existing imports

# APP engine — the REQUEST PATH. When APP_DATABASE_URL points at a NON-BYPASSRLS
# role (nordavix_app, created by migration 059), request handlers (get_db) become
# CONSTRAINED by RLS to the tenant in the app.current_tenant GUC. Until then it's
# the SAME engine object as system_engine — so dormant = today's behavior, one
# connection pool, RLS policies present but ignored by the BYPASSRLS login.
# See docs/RLS_CUTOVER.md for the (reversible) cutover.
_app_url = settings.app_database_url.strip()
if _app_url and _app_url != settings.database_url:
    app_engine = create_async_engine(
        _app_url,
        echo=settings.debug,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
    )
else:
    app_engine = system_engine

# System sessions (BYPASS): bootstrap, background jobs, purge, public routes.
AsyncSessionLocal = async_sessionmaker(
    system_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)
# Request-path sessions (RLS-CONSTRAINED once APP_DATABASE_URL is set).
TenantSessionLocal = async_sessionmaker(
    app_engine,
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


@event.listens_for(Session, "after_begin")
def _set_tenant_guc(
    session: Session, transaction: object, connection: object,  # noqa: ARG001
) -> None:
    """Announce the active tenant to Postgres at the start of every transaction.

    Sets `app.current_tenant` (transaction-local, via set_config(..., is_local=
    True)) to the current_tenant_id ContextVar. This is the value Tier 2
    Row-Level Security policies compare tenant_id against. SET LOCAL semantics
    mean it is scoped to THIS transaction and auto-cleared at commit/rollback,
    so it can never leak across pooled-connection reuse.

    No tenant context (system / bootstrap / cross-tenant work) → the GUC is left
    unset; those transactions either run as a bypassing role or are handled
    explicitly when RLS is enabled. Harmless until policies exist (the GUC is
    simply unused). Gated by settings.db_set_tenant_guc as a host-flippable kill
    switch.

    Uses Core execute on the transaction's connection (not the ORM Session), so
    it bypasses the do_orm_execute tenant filter and the demo read-only guard —
    set_config is a read-only function call, safe even in read-only requests.
    """
    if not settings.db_set_tenant_guc:
        return
    tid = current_tenant_id.get()
    if tid is None:
        return
    connection.execute(
        text("SELECT set_config('app.current_tenant', :tid, true)"),
        {"tid": str(tid)},
    )


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency for the REQUEST PATH — yields a session on the app
    engine. Once APP_DATABASE_URL points at the non-BYPASSRLS role, these
    sessions are constrained by Row-Level Security to the request's tenant (the
    app.current_tenant GUC, set by the after_begin hook). Handlers reached
    through the tenant middleware always have a tenant context; PUBLIC /
    no-tenant-context routes must use get_system_db instead."""
    async with TenantSessionLocal() as session:
        yield session


async def get_system_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency for PUBLIC / pre-tenant-context routes (e.g. the
    pbc-public magic-link endpoints) that legitimately operate WITHOUT a tenant
    GUC. Yields a session on the system (BYPASSRLS) engine, scoped by the
    route's own token/authorization logic rather than RLS. Never use this for
    normal authenticated handlers — those use get_db."""
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
