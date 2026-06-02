import uuid
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
