"""
Shared retry/backoff for QuickBooks API reads.

QBO enforces a per-realm rate limit (~500 req/min). A large client's sync makes
hundreds of calls (per-customer AR/AP evidence, aging, P&L, GL), so a burst can
draw a 429. Without retry that surfaced as an opaque RuntimeError and failed the
whole sync. This wraps the GET so a 429 — or a transient gateway/server 5xx — is
retried with exponential backoff (honoring Retry-After), giving Intuit's limit
time to refill.

Use this ONLY for idempotent reads (QBO GET reports/queries). Do NOT wrap the
OAuth token-refresh POST: Intuit rotates the refresh token on use, so a blind
retry of that call can invalidate it.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx

logger = logging.getLogger(__name__)

# Worth retrying: 429 (rate limit) + transient gateway/server errors.
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
# Backoff before retries 1, 2, 3 (seconds). ~6s max added latency on a sustained
# limit — bounded so a struggling sync fails fast rather than hanging forever.
_BACKOFF = (0.5, 1.5, 4.0)
# Cap an honored Retry-After so a pathological value can't stall the whole sync.
_RETRY_AFTER_CAP = 10.0


def _parse_retry_after(value: str | None) -> float | None:
    """Retry-After in seconds, capped. The HTTP-date form is ignored (QBO sends
    deltas); a missing/bad value falls back to our own backoff schedule."""
    if not value:
        return None
    try:
        return min(float(value), _RETRY_AFTER_CAP)
    except (TypeError, ValueError):
        return None


async def request_with_retry(
    do_request: Callable[[], Awaitable[httpx.Response]],
    *,
    label: str = "QBO",
) -> httpx.Response:
    """Run do_request() (returns an httpx.Response), retrying on 429 / transient
    5xx with exponential backoff (honoring Retry-After). Returns the final
    response — the caller still does its own status handling. Each call to
    do_request() must issue a FRESH request (so retries actually re-send).
    For idempotent GETs only.
    """
    resp = await do_request()
    for i in range(len(_BACKOFF)):
        if resp.status_code not in _RETRY_STATUSES:
            return resp
        wait = _parse_retry_after(resp.headers.get("Retry-After"))
        if wait is None:
            wait = _BACKOFF[i]
        logger.warning(
            "%s returned %s — retrying in %.1fs (%d/%d)",
            label, resp.status_code, wait, i + 1, len(_BACKOFF),
        )
        await asyncio.sleep(wait)
        resp = await do_request()
    return resp
