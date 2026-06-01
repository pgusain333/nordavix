"""
Internal / scheduled-task endpoints.

These are NOT called by users — they're triggered by a scheduler (a Fly
scheduled machine, cron, or an external uptime-style pinger). The tenancy
middleware lets `/api/internal/*` through without a Clerk JWT (it has no tenant
context), so every endpoint here is instead gated by a shared secret in the
`X-Internal-Secret` header, compared in constant time.

If `INTERNAL_TASK_SECRET` is unset the endpoints are DISABLED (503) — a missing
secret can never leave them publicly callable.
"""
import hmac
import logging

from fastapi import APIRouter, Header, HTTPException

from core.config import settings
from modules.workspace.purge import purge_expired_tenants

logger = logging.getLogger(__name__)

router = APIRouter()


def _require_internal_secret(provided: str | None) -> None:
    """Constant-time check of the X-Internal-Secret header. 503 if the feature
    isn't configured; 401 if the secret is missing/wrong."""
    expected = (settings.internal_task_secret or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Internal tasks are disabled (INTERNAL_TASK_SECRET not set).",
        )
    if not provided or not hmac.compare_digest(provided.strip(), expected):
        raise HTTPException(status_code=401, detail="Invalid internal task secret.")


@router.post("/purge-expired-tenants")
async def run_purge_expired_tenants(
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Hard-delete every soft-deleted tenant whose 30-day grace window has elapsed.
    Idempotent — safe to call on a daily schedule. Returns a per-tenant summary.
    """
    _require_internal_secret(x_internal_secret)
    summaries = await purge_expired_tenants()
    purged = sum(1 for s in summaries if s.get("ok"))
    failed = sum(1 for s in summaries if not s.get("ok"))
    logger.info("Purge endpoint ran: %d purged, %d failed.", purged, failed)
    return {"purged": purged, "failed": failed, "results": summaries}
