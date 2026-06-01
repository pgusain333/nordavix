"""
AI endpoint guard — a single FastAPI dependency that protects every
AI-triggering endpoint with two checks:

  1. AI rate limit  — stricter than the general API limit (per-tenant, per-min),
     so a tight loop of "Run AI" clicks can't hammer Anthropic.
  2. Monthly spend cap — blocks once the tenant's estimated Anthropic cost for
     the calendar month reaches the configured cap.

Both fail-open on their own backends being unavailable (Redis for the rate
limit, Postgres for the cap), so infrastructure hiccups degrade to "allow"
rather than blocking legitimate close work. The cap can be set to warn-only
(ai_cap_enforce=false) to observe real usage before enforcing.

Usage:
    @router.post("/run-ai", dependencies=[Depends(enforce_ai_limits)])
"""
import logging

from fastapi import HTTPException

from core.ai.budget import get_budget_status
from core.auth.dependencies import CurrentTenantId
from core.config import settings
from core.ratelimit.limiter import check_rate_limit

logger = logging.getLogger(__name__)


async def enforce_ai_limits(tenant_id: CurrentTenantId) -> None:
    """Raise 429 if the tenant is over the AI rate limit or the monthly spend
    cap. Returns None (allows) otherwise."""
    # 1. AI request-rate limit (fail-open inside check_rate_limit).
    rl = await check_rate_limit(
        key=f"ai:{tenant_id}",
        limit=settings.rate_limit_ai_per_min,
        window_seconds=60,
    )
    if not rl.allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many AI requests in a short window. Please wait a moment and try again.",
            headers={"Retry-After": str(rl.retry_after)},
        )

    # 2. Monthly AI spend cap.
    if settings.ai_cap_enforce and (settings.ai_monthly_cost_cap_usd or 0) > 0:
        status = await get_budget_status(tenant_id)
        if status.exceeded:
            reset_date = status.resets_at.date().isoformat()
            raise HTTPException(
                status_code=429,
                detail=(
                    f"This workspace has reached its monthly AI limit. "
                    f"AI features will be available again on {reset_date}. "
                    f"Contact support if you need a higher limit."
                ),
                headers={"X-AI-Limit-Reset": status.resets_at.isoformat()},
            )
