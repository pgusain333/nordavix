# ADR 001 — Multi-tenant ORM enforcement

**Date:** 2026-05-23  
**Status:** Accepted

## Context

Every table that contains client financial data must be isolated by tenant. A bug that leaks one firm's data to another firm is an existential business risk and a SOC 2 blocker.

## Decision

1. All tenant-scoped models inherit from `TenantBase` (not `Base`). `TenantBase` adds a non-nullable indexed `tenant_id` column.

2. A SQLAlchemy `do_orm_execute` session event (`core/db/base.py`) intercepts every SELECT on TenantBase subclasses and appends `WHERE tenant_id = <current>` automatically via `with_loader_criteria`.

3. The active tenant is stored in a `ContextVar[UUID]` (`current_tenant_id`) set by `TenantMiddleware` at the start of each HTTP request and at the top of each Celery task.

4. If a query touches a TenantBase model and `current_tenant_id` is `None`, the session event raises `RuntimeError`. This is a loud, immediate failure rather than a silent data leak.

5. System-level queries (auth bootstrap, migrations, admin scripts) may opt out by passing `execution_options={"skip_tenant_filter": True}`.

## Consequences

- **Good:** Developers cannot accidentally write cross-tenant queries — the ORM fails loudly.
- **Good:** New modules that inherit TenantBase get isolation for free.
- **Trade-off:** INSERT/UPDATE/DELETE are not automatically scoped — service code must include `tenant_id` in writes and WHERE clauses. Tests in `test_tenant_isolation.py` cover this.
- **Trade-off:** The session event fires for every SELECT, adding a small amount of processing. Acceptable at this scale; revisit if profiling shows it as a hotspot.
