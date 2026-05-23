# ADR 003 — Async AI pipeline with Celery

**Date:** 2026-05-23  
**Status:** Accepted

## Context

Generating AI narratives for a full trial balance (potentially hundreds of material accounts) could take minutes. Running this synchronously in a FastAPI request would time out and make the UI unresponsive.

## Decision

AI narrative generation runs in Celery workers, not in the request thread.

**Flow:**
1. Controller clicks "Run Flux" → FastAPI enqueues Celery tasks (one per material account) → returns task IDs immediately (HTTP 202)
2. Celery workers process tasks concurrently, each calling the Anthropic API
3. Frontend polls `GET /api/flux/trial-balances/{id}` which returns current TB status and per-variance status
4. As narratives complete, the UI updates in real time via React Query polling (5-second interval while status is "generating")

**Idempotency:** Before calling the API, each task checks the `narratives.cache_key` column (SHA-256 of account_number + balances + model). If a matching narrative exists, it's returned without an API call. This means re-running flux on an unchanged TB is free.

**Redis:** Upstash Redis (free tier) serves as both the Celery broker and result backend. Local dev uses a Redis Docker container.

## Consequences

- Adds operational complexity (Celery worker process alongside the API server)
- Fly.io free tier runs both processes in the same container; production should use separate worker machines
- Task failures are visible in the Celery result backend; a failed task sets variance status to "error" so the UI can offer a "Retry" button
