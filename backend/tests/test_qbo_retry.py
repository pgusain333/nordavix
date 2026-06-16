"""
Invariant: QBO read retry/backoff contract (`request_with_retry`).

This is what keeps a large client's sync alive through Intuit's rate limit: a
429 (or transient 5xx) is retried up to 3 times, success returns immediately,
and after the retries are exhausted the last (still-failing) response is handed
back so the caller surfaces its own error. A regression here (not retrying 429,
or looping forever) would either fail big syncs again or hang them — so it gates
deploy. Backoff is patched to 0 so the test is instant; the test function is
sync (drives its own loop via asyncio.run), so it needs no pytest-asyncio.

Runs standalone too:
    python tests/test_qbo_retry.py
"""
import asyncio

import httpx

from core import qbo_http
from core.qbo_http import request_with_retry


def _seq(*statuses):
    """An async do_request() that yields the given status codes in order."""
    it = iter(httpx.Response(s) for s in statuses)

    async def do_request():
        return next(it)

    return do_request


async def _scenarios():
    orig = qbo_http._BACKOFF
    qbo_http._BACKOFF = (0.0, 0.0, 0.0)  # no real waiting in the test
    try:
        # Retries through 429s, then succeeds.
        assert (await request_with_retry(_seq(429, 429, 200))).status_code == 200
        # First-try success: returns immediately.
        assert (await request_with_retry(_seq(200))).status_code == 200
        # Transient 5xx is retried too.
        assert (await request_with_retry(_seq(503, 200))).status_code == 200
        # A non-retryable client error returns immediately (no wasted retries).
        assert (await request_with_retry(_seq(400))).status_code == 400
        # Exhausts retries (1 initial + 3 = 4 calls), returns the last failure.
        assert (await request_with_retry(_seq(429, 429, 429, 429))).status_code == 429
    finally:
        qbo_http._BACKOFF = orig


def test_retry_contract():
    asyncio.run(_scenarios())


if __name__ == "__main__":
    test_retry_contract()
    print("QBO_RETRY_OK")
