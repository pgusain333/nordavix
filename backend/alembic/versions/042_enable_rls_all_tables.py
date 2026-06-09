"""Enable Row Level Security on all public tables (close the PostgREST door).

Revision ID: 042
Revises: 041
Create Date: 2026-06-09 13:00:00.000000

Supabase auto-exposes the `public` schema through PostgREST — a REST API at
https://<project>.supabase.co/rest/v1/ reachable from the internet with the
project's public `anon` key. Nordavix never uses that API (the backend holds a
direct Postgres connection and authenticates with Clerk), but the door exists by
default, and with RLS off the `anon`/`authenticated` roles could read tenant
data straight off the database — bypassing the app's tenant isolation entirely.

This migration shuts that door:

  1. ENABLE ROW LEVEL SECURITY on every table in `public`. With **no policies**
     attached, RLS is default-deny: PostgREST (anon/authenticated) sees zero
     rows. The FastAPI backend is unaffected — it connects as the role that
     OWNS these tables (it created them via these very migrations), and table
     owners bypass RLS unless FORCE ROW LEVEL SECURITY is set (we don't set it).

  2. REVOKE the PostgREST role grants as defense-in-depth and stop future tables
     from being auto-granted. Guarded by role existence so it's a harmless no-op
     on a vanilla Postgres (local dev / CI) where `anon`/`authenticated` don't
     exist.

Tenant isolation *through the API* still comes from the app layer (TenantBase +
the session tenant filter). This is purely about the *other* door — the
database-level REST API the app doesn't use.

NOTE FOR FUTURE MIGRATIONS: RLS is per-table; new tables are NOT covered
automatically. Any later migration that creates a public table must also run
    op.execute("ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY")
(or re-run the blanket block below). Keep the Supabase Security Advisor at zero.
"""
from collections.abc import Sequence

from alembic import op

revision: str = "042"
down_revision: str | None = "041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Enable RLS on every current table in `public` (default-deny; the owner role the
# backend connects as still bypasses it, so the app is unaffected).
_ENABLE_RLS_ALL = """
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
  END LOOP;
END $$;
"""

_DISABLE_RLS_ALL = """
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY;', r.tablename);
  END LOOP;
END $$;
"""

# Supabase-only hardening: drop the PostgREST role grants and stop new tables
# inheriting them. Guarded so it's a no-op where the roles don't exist.
_REVOKE_POSTGREST_GRANTS = """
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END $$;
"""


def upgrade() -> None:
    op.execute(_ENABLE_RLS_ALL)
    op.execute(_REVOKE_POSTGREST_GRANTS)


def downgrade() -> None:
    # Reverse the RLS enablement. We intentionally do NOT re-grant
    # anon/authenticated — that would reopen the exact hole this migration
    # closed. Restore those grants by hand only if you ever truly need the
    # Supabase REST API.
    op.execute(_DISABLE_RLS_ALL)
