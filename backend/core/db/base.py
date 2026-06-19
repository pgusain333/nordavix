import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from sqlalchemy import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# The active tenant for the current request or Celery task.
# Set by TenantMiddleware (HTTP requests) or at the top of every Celery task.
# Defined here rather than in core/tenancy/ to avoid circular imports with session.py.
current_tenant_id: ContextVar[uuid.UUID | None] = ContextVar(
    "current_tenant_id", default=None
)

# When True, the current request may only READ — any attempt to flush or
# execute a write (INSERT/UPDATE/DELETE) raises DemoReadOnlyError. Set by the
# tenant middleware for the read-only "sample company" demo, so even a GET
# endpoint that would normally write (e.g. an opportunistic email backfill)
# can never mutate the shared demo tenant. Default False = normal read/write.
current_request_readonly: ContextVar[bool] = ContextVar(
    "current_request_readonly", default=False
)


class DemoReadOnlyError(Exception):
    """A read-only (demo) request attempted a database write. Mapped to HTTP
    403 by an exception handler in main.py. Makes 'the sample company is
    read-only' a hard DB-layer invariant, not a per-HTTP-method whitelist."""


class TenantOwnershipError(Exception):
    """A tenant-ownership assertion failed: code tried to act on a row by id
    (typically an unscoped bulk DELETE/UPDATE keyed on a foreign key) that the
    CURRENT tenant does not own — or that does not exist. Raised by
    core.db.session.assert_tenant_owns and mapped to HTTP 404 in main.py.

    This turns write-path tenant safety from a convention ("every caller must
    SELECT-to-validate before deleting by id") into an enforced precondition:
    the bulk write simply cannot run against another tenant's parent row."""

    def __init__(self, label: str, entity_id: object) -> None:
        self.label = label
        self.entity_id = entity_id
        super().__init__(
            f"{label} {entity_id} is not owned by the current tenant "
            "(or does not exist) — refusing the operation."
        )


@contextmanager
def tenant_scope(tenant_id: uuid.UUID) -> Iterator[None]:
    """Blessed way to run tenant-scoped queries OUTSIDE an HTTP request — or to
    pin a query to a specific tenant regardless of the ambient context.

    Sets `current_tenant_id` for the duration so the *enforced* SELECT
    auto-filter (core/db/session._apply_tenant_filter) applies. Inside the
    block you write plain `select(Model)` — NO `skip_tenant_filter`, NO
    hand-written `WHERE tenant_id == …`. That is the whole point: it reuses the
    tested, fail-closed read path instead of the bypass path, so a forgotten
    filter cannot leak.

    Prefer this over `execution_options={"skip_tenant_filter": True}` +
    `.where(Model.tenant_id == tid)` in new code (background jobs, scripts,
    cross-context service helpers).

        with tenant_scope(tenant_id):
            conn = (await db.execute(select(QboConnection))).scalar_one_or_none()

    Refuses a falsy tenant_id so it can never silently widen scope to "all
    tenants" (the auto-filter would otherwise raise on None, but we fail even
    earlier and with a clearer message)."""
    if not tenant_id:
        raise ValueError("tenant_scope requires a non-null tenant_id.")
    token = current_tenant_id.set(tenant_id)
    try:
        yield
    finally:
        current_tenant_id.reset(token)


class Base(DeclarativeBase):
    """Root declarative base. Inherit for cross-tenant models (Tenant, system config)."""
    pass


class TenantBase(Base):
    """
    Base for every tenant-scoped model.

    Adds a non-nullable indexed `tenant_id` column. The `_apply_tenant_filter`
    session listener in core/db/session.py automatically appends
    WHERE tenant_id = <current> to every SELECT on TenantBase subclasses.
    Service code never filters manually — but it must ensure current_tenant_id
    is set before any query runs.

    INSERT/UPDATE/DELETE are NOT automatically scoped; service code must include
    the tenant_id in writes and WHERE clauses. Tests in test_tenant_isolation.py
    verify this for all critical mutation paths.

    For system-level queries that intentionally span tenants (migrations, admin
    tooling, auth bootstrap), pass:
        execution_options={"skip_tenant_filter": True}
    """
    __abstract__ = True

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
