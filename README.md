# Nordavix

AI-powered month-end close automation for accountants and auditors.

## Modules

| Module | Status | Description |
|---|---|---|
| Flux Analysis | v1 — active | AI variance commentary from trial balance upload |
| Reconciliations | Planned | — |
| Workpapers | Planned | — |

## Local development

### Prerequisites

- Python 3.11+
- Node 20+
- Docker Desktop (for Postgres + Redis)

### 1. Start infrastructure

```bash
docker compose up -d
```

### 2. Backend

```bash
cd backend
pip install -e ".[dev]"
cp ../.env.example .env          # fill in Clerk, R2, Anthropic keys
alembic upgrade head             # runs migrations
uvicorn main:app --reload        # API on http://localhost:8000
```

In a separate terminal (Celery worker):
```bash
cd backend
celery -A celery_app worker --loglevel=info
```

### 3. Frontend

```bash
cd frontend
npm install
cp ../.env.example .env.local    # copy the VITE_ lines into frontend/.env.local
npm run dev                      # UI on http://localhost:5173
```

### 4. Run tests

```bash
cd backend
pytest
```

## Architecture

See [`/docs/decisions/`](docs/decisions/) for architectural decision records.

Key principles:
- **Multi-tenant from day one** — every query is scoped to `tenant_id` at the ORM level
- **Privacy-first** — no client data in logs, errors, or analytics; AI calls strip entity metadata
- **Async AI** — Celery workers handle narrative generation; frontend polls for completion
- **Idempotent** — re-running flux on unchanged data hits the cache, never the API

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11, FastAPI, SQLAlchemy 2.0, Pydantic v2 |
| AI | Anthropic SDK (claude-sonnet-4-6) |
| Task queue | Celery + Redis (Upstash) |
| Database | PostgreSQL 16 (Supabase) |
| Auth | Clerk |
| Storage | Cloudflare R2 |
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui |
| Hosting | Fly.io (backend), Cloudflare Pages (frontend) |
