"""
Per-tenant rate limiting — a Redis fixed-window counter.

Fixed window (not sliding/token-bucket) on purpose: it's one INCR + one EXPIRE,
cheap against Upstash, and exact enough for abuse protection. The tradeoff is a
burst can straddle a window boundary (up to ~2× the limit across two adjacent
windows); that's fine for a backstop whose job is stopping runaway loops and
scrapers, not precise quota metering.

Fail-open everywhere: any Redis error (or a disabled limiter) returns "allowed"
so a limiter outage can never take the app down.
"""
import logging
import time
from dataclasses import dataclass

from core.cache.redis import get_redis
from core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class RateLimitResult:
    allowed: bool
    limit: int
    remaining: int
    retry_after: int  # seconds until the current window resets


_ALLOW_DISABLED = RateLimitResult(allowed=True, limit=0, remaining=0, retry_after=0)


async def check_rate_limit(*, key: str, limit: int, window_seconds: int = 60) -> RateLimitResult:
    """
    Increment the counter for `key` in the current window and report whether the
    caller is within `limit`. `key` should already be scoped (e.g. "gen:<tid>"
    or "ai:<tid>"). Returns allowed=True on any failure (fail-open).
    """
    if not settings.rate_limit_enabled or limit <= 0:
        return _ALLOW_DISABLED

    redis = get_redis()
    if redis is None:
        return RateLimitResult(allowed=True, limit=limit, remaining=limit, retry_after=0)

    now = int(time.time())
    window_index = now // window_seconds
    redis_key = f"rl:{key}:{window_index}"
    try:
        count = await redis.incr(redis_key)
        if count == 1:
            # First hit in this window — set the TTL so the bucket self-expires.
            await redis.expire(redis_key, window_seconds)
        if count > limit:
            retry_after = window_seconds - (now % window_seconds)
            return RateLimitResult(allowed=False, limit=limit, remaining=0, retry_after=max(1, retry_after))
        return RateLimitResult(allowed=True, limit=limit, remaining=max(0, limit - count), retry_after=0)
    except Exception:
        # Redis down / timeout / transient — never block the request on it.
        logger.warning("Rate-limit check failed for %s — allowing (fail-open).", key, exc_info=True)
        return RateLimitResult(allowed=True, limit=limit, remaining=limit, retry_after=0)
