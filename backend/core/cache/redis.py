"""
Shared async Redis client.

Used for distributed per-tenant rate limiting (the app may run several Fly
machines, so an in-process counter wouldn't be consistent). Reuses the same
REDIS_URL Celery already uses — Upstash is rediss:// (TLS), local dev is
redis://; redis.asyncio.from_url handles both.

Everything here is best-effort and fail-open: a Redis hiccup must never take
the app down. get_redis() returns None if the client can't be constructed, and
callers treat None as "limiter unavailable → allow".
"""
import logging

from redis.asyncio import Redis

from core.config import settings

logger = logging.getLogger(__name__)

_client: Redis | None = None
_init_failed = False


def get_redis() -> Redis | None:
    """Return a lazily-constructed shared async Redis client, or None if it
    can't be built. The client itself connects lazily on first command, so
    construction here doesn't do network I/O — short socket timeouts bound any
    hang at command time so a dead Redis degrades to fail-open quickly."""
    global _client, _init_failed
    if _client is not None:
        return _client
    if _init_failed:
        return None
    try:
        _client = Redis.from_url(
            settings.redis_url,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
            retry_on_timeout=False,
            health_check_interval=30,
        )
        return _client
    except Exception:
        logger.exception("Could not initialize Redis client — rate limiting will fail-open.")
        _init_failed = True
        return None
