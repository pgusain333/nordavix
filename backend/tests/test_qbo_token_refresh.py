"""
Invariant: QBO token refresh is serialized per realm (`refresh_access_token`).

Intuit rotates the refresh token on every refresh call, so concurrent refreshes
for one realm corrupt it and can lock a workspace out of QBO. This proves the
serialization holds: N concurrent callers (the real trigger — the 4-way evidence
pulls, or Autopilot alongside a manual sync) drive at most ONE actual refresh
POST, and everyone else reuses the freshly-minted token. Sync test (drives its
own loop via asyncio.run), so it's safe in the blocking invariant tier.

Standalone:
    python tests/test_qbo_token_refresh.py
"""
import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx

from core import qbo_auth
from core.qbo_auth import refresh_access_token

_posts = {"n": 0}  # counts actual refresh POSTs


class _FakeClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        _posts["n"] += 1
        await asyncio.sleep(0)  # yield so other coroutines pile up on the lock
        return httpx.Response(
            200, json={"access_token": "A1", "refresh_token": "R1", "expires_in": 3600},
        )


class _FakeDB:
    async def refresh(self, obj, attrs=None):
        pass

    async def commit(self):
        pass


async def _scenario():
    qbo_auth._locks.clear()
    _posts["n"] = 0
    orig = qbo_auth.httpx.AsyncClient
    qbo_auth.httpx.AsyncClient = _FakeClient
    try:
        # Shared conn + expired token = the concurrent-evidence-pull case.
        conn = SimpleNamespace(
            realm_id="realm-1", access_token="A0", refresh_token="R0",
            token_expires_at=datetime.now(UTC) - timedelta(minutes=1),
        )
        db = _FakeDB()

        # 8 callers all see a stale token at once.
        tokens = await asyncio.gather(*(refresh_access_token(conn, db) for _ in range(8)))
        assert _posts["n"] == 1, _posts["n"]              # refreshed exactly ONCE
        assert all(t == "A1" for t in tokens), tokens      # everyone got the new token
        assert conn.refresh_token == "R1"                  # rotation applied once, not 8x

        # A later call while the token is fresh does not refresh again.
        again = await refresh_access_token(conn, db)
        assert again == "A1"
        assert _posts["n"] == 1, _posts["n"]
    finally:
        qbo_auth.httpx.AsyncClient = orig


def test_refresh_is_serialized_per_realm():
    asyncio.run(_scenario())


if __name__ == "__main__":
    test_refresh_is_serialized_per_realm()
    print("QBO_TOKEN_REFRESH_OK")
