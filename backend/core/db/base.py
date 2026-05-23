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
