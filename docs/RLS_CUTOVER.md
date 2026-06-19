# Tier 2 — Database Row-Level Security cutover runbook

Tier 1 (app-layer tenant isolation) is always on. **Tier 2** adds a second,
database-enforced layer: the request path connects as a non-privileged login so
Postgres itself refuses cross-tenant rows even if app code has a bug. This is
**defense-in-depth** — not required for correctness, but it makes a future
request-handler bug (or a chatbot tool) non-catastrophic.

It ships **dormant**. Nothing changes until you set `APP_DATABASE_URL`. This doc
is the (reversible) cutover.

---

## Why a new login is needed

The current DB login (Supabase `postgres`) has **`BYPASSRLS = true`** — it
ignores every RLS policy. So RLS can only constrain a *different*, non-bypass
login. Migration `059` already attached the `tenant_isolation` policies to every
tenant table. You create the constrained login (`nordavix_app`) and grant it
access as **step 1 of the cutover below** — that part isn't in the migration on
purpose (creating roles needs `CREATEROLE`, which a deploy-time migration
shouldn't depend on). The policies are inert until the app connects as that login.

```
postgres      (BYPASSRLS)   → migrations · auth/bootstrap · jobs · purge · public routes   [bypasses RLS]
nordavix_app  (NOBYPASSRLS) → FastAPI request handlers (get_db)                             [RLS-enforced]
```

How the app routes traffic (already in code, `core/db/session.py`):
- `get_db` (authenticated request handlers) → **app engine** → `APP_DATABASE_URL` if set.
- `get_system_db` + `AsyncSessionLocal` + `get_async_session_context` → **system engine** → `DATABASE_URL` (always `postgres`).

Every transaction sets `app.current_tenant` (the GUC the policies read) from the
request's tenant — harmless on the bypass login, enforced on `nordavix_app`.

---

## Cutover (2 steps, you run these — they involve a password)

> Do this in a low-traffic window. It's instantly reversible (see Rollback).

**1. Create the constrained login + grant it access** — Supabase → SQL Editor
(runs as `postgres`, which can do all of this). Pick a strong password:

```sql
-- The request-path login: can log in, but NEVER bypasses RLS.
CREATE ROLE nordavix_app LOGIN PASSWORD 'GENERATE-A-STRONG-ONE' NOBYPASSRLS;

-- Let it use + read/write every table and sequence (current + future).
GRANT USAGE ON SCHEMA public TO nordavix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nordavix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nordavix_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nordavix_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nordavix_app;
```

> RLS still scopes every row to the tenant GUC — the broad GRANT just lets the
> role *reach* the tables; the policies decide which rows it sees.

**2. Point the request path at it** — set the Fly secret (use the SAME host/db
as your existing `DATABASE_URL`, only the user:password and the `+asyncpg`
driver differ):

```
APP_DATABASE_URL=postgresql+asyncpg://nordavix_app:THAT-PASSWORD@<host>:<port>/<db>
```

```bash
fly secrets set APP_DATABASE_URL='postgresql+asyncpg://nordavix_app:...@...'
```

The app restarts and the request path is now RLS-enforced.

> **Connections:** this adds a second pool (system + app). If you're on a direct
> Postgres connection with a tight limit, switch both URLs to the Supabase
> **transaction pooler** first, or lower `pool_size` in `core/db/session.py`.

---

## Verify immediately after cutover

The failure mode is **fail-closed** (a missed path returns empty/`403`/`404`, it
never leaks), so testing surfaces any gap safely. Walk these:

- [ ] **Login / first load** — dashboard renders (proves middleware bootstrap, which uses the bypass login, still works).
- [ ] **Normal CRUD** — open a reconciliation, a flux analysis, schedules; edit something. (Constrained path with context.)
- [ ] **QBO connect** — run the OAuth connect flow end-to-end (callback uses the bypass login).
- [ ] **PBC magic link** — open a client upload link logged-out and upload a file (`pbc-public`, uses `get_system_db`).
- [ ] **Intercompany** — open consolidation / eliminations for a multi-company user. ⚠️ **Known cross-tenant feature** — if it returns empty, its handlers need `get_system_db` (they read multiple tenants by design). Route them and redeploy.
- [ ] **Company switcher** — switch active org; data follows.
- [ ] **Cross-tenant check (the actual win)** — as user in Tenant A, confirm you cannot see Tenant B's data (you already can't via the app filter; this is the DB now enforcing it too).
- [ ] **Background** — trigger a sync / agentic scan; confirm it completes (jobs use the bypass login).
- [ ] **Purge** (optional, staging) — the daily purge uses the bypass login.

If anything reads empty that shouldn't: it's a path that runs without a tenant
GUC on the constrained engine. Switch that route/handler from `get_db` to
`get_system_db` (or set the tenant context), commit, redeploy. No data is at
risk while you do.

---

## Rollback (instant)

```bash
fly secrets unset APP_DATABASE_URL
```

The app restarts and the request path reverts to `postgres` (bypass) — exactly
the pre-cutover behavior. The role and policies remain (harmless). A full revert
of the schema objects is `alembic downgrade 058`.

---

## Adding new tenant tables later

Any new `TenantBase` table needs its own `tenant_isolation` policy in the
migration that creates it:

```sql
ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.<table>
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
```

The CI test `test_every_tenant_table_has_rls_policy` fails the build if you
forget.
