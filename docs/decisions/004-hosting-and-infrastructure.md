# ADR 004 — Hosting and infrastructure choices

**Date:** 2026-05-23  
**Status:** Accepted

## Decisions

### Backend: Fly.io (free tier)

Chose Fly.io over Railway (no true free tier) and Render (sleeps after inactivity, problematic for Celery workers). Fly.io's free tier includes 3 shared-cpu-1x VMs with 256MB RAM — enough for the API server and a Celery worker.

**To deploy:**
```bash
fly launch --name nordavix-api --region iad
fly secrets set DATABASE_URL=... REDIS_URL=... ANTHROPIC_API_KEY=...
fly deploy
```

### Database: Supabase (free tier, PostgreSQL 15)

Supabase provides managed Postgres with connection pooling (PgBouncer), row-level security (not used — we enforce tenant isolation at the ORM level instead), and automatic backups. Free tier: 500MB storage, 2 CPU, shared.

The `DATABASE_URL` uses the pooler endpoint (`db.xxx.supabase.co:6543`) with `?pgbouncer=true` appended for PgBouncer compatibility with asyncpg.

### Redis: Upstash (free tier)

10,000 commands/day on free tier. Sufficient for development and early production. Uses TLS (`rediss://` scheme). Scale to paid tier when command count exceeds limit.

### File storage: Cloudflare R2 (free tier)

10GB storage, 1M Class A operations, 10M Class B operations per month — more than enough for v1. Files are stored under `{tenant_id}/{resource_type}/{filename}` paths for tenant isolation.

### Frontend: Cloudflare Pages (free tier)

Unlimited bandwidth, global CDN. Vite build output deployed on push to `main`.

### Auth: Clerk (free tier)

10,000 MAUs on free tier. Clerk Organizations map 1:1 to Nordavix tenants. The `org_id` claim in the JWT is the join key between Clerk and our `tenants` table.

### Account number defaults

Standard GAAP 4-digit ranges are the default FS categorization:
- 1000–1999: Assets (Current)
- 2000–2499: Assets (Long-Term)
- 2500–2999: Assets (Other)
- 3000–3999: Liabilities
- 4000–4999: Equity
- 5000–5999: Revenue
- 6000–6999: Cost of Revenue
- 7000–7999: Operating Expenses
- 8000–8999: Other Expenses
- 9000–9999: Other Income/Expense

Overridable per trial balance upload via `fs_line_mapping` JSONB column.
