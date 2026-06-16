"""
Serialized QBO OAuth access-token refresh.

Intuit ROTATES the refresh token on every refresh call, so two concurrent
refreshes for the same realm are a footgun: the second fires with an
already-rotated refresh token, and the racing commits can leave the stored
refresh token out of sync with Intuit — locking the workspace out of QBO until
it reconnects. The real triggers are the 4-way concurrent AR/AP evidence pulls
(asyncio.gather) and Autopilot running alongside a manual sync.

`refresh_access_token()` serializes refresh per realm with an in-process
asyncio.Lock + a double-check (in-memory first, then a best-effort DB reload),
so N concurrent callers refresh at most ONCE and everyone else reuses the fresh
token. Both `modules.recons.service._refresh_token_if_needed` and
`modules.qbo.router._get_valid_token` delegate here.

Limitation: the lock is per-process. Two Fly machines refreshing the same realm
at the very same instant is still possible (rare — one workspace syncing on two
instances at once); a DB row lock (SELECT ... FOR UPDATE) would be needed to
cover that, at the cost of more session coupling. The lock fixes the documented
in-process race, which is the one that actually happens.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)

_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
_EXPIRY_BUFFER = timedelta(minutes=5)

# One lock per realm_id. `_registry_guard` protects creation of the per-realm
# locks so two coroutines can't make two different locks for the same realm
# (which would defeat the serialization).
_locks: dict[str, asyncio.Lock] = {}
_registry_guard = asyncio.Lock()


async def _lock_for(realm_id: str) -> asyncio.Lock:
    async with _registry_guard:
        lock = _locks.get(realm_id)
        if lock is None:
            lock = asyncio.Lock()
            _locks[realm_id] = lock
        return lock


def token_is_fresh(conn: QboConnection) -> bool:
    """True when the access token is still valid for at least the 5-min buffer."""
    return bool(
        conn.token_expires_at
        and conn.token_expires_at > datetime.now(UTC) + _EXPIRY_BUFFER
    )


async def refresh_access_token(conn: QboConnection, db: AsyncSession) -> str:
    """Return a valid access token for `conn`, refreshing if within 5 minutes of
    expiry. Serialized per realm so concurrent callers refresh at most once.
    Raises RuntimeError if the refresh call itself fails."""
    if token_is_fresh(conn):
        return conn.access_token

    lock = await _lock_for(conn.realm_id)
    async with lock:
        # Double-check — another coroutine may have refreshed while we waited.
        # In-memory first: covers callers that share the same conn object (the
        # concurrent evidence pulls), where the winner already updated it.
        if token_is_fresh(conn):
            return conn.access_token
        # Then a best-effort DB reload: covers callers in a DIFFERENT session
        # (e.g. Autopilot alongside a manual sync). Best-effort because conn may
        # have been loaded with the tenant filter skipped; if the reload can't
        # run we fall through to refresh — still serialized by the lock, so the
        # worst case is one extra (sequential, non-racing) refresh, never the
        # simultaneous double-refresh that corrupts the token.
        try:
            await db.refresh(conn, ["access_token", "refresh_token", "token_expires_at"])
            if token_is_fresh(conn):
                return conn.access_token
        except Exception:
            logger.debug("token double-check reload skipped", exc_info=True)

        now = datetime.now(UTC)
        credentials = base64.b64encode(
            f"{settings.qbo_client_id}:{settings.qbo_client_secret}".encode()
        ).decode()
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                _TOKEN_URL,
                headers={
                    "Authorization": f"Basic {credentials}",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                data={"grant_type": "refresh_token", "refresh_token": conn.refresh_token},
            )
        if resp.status_code != 200:
            raise RuntimeError(f"QBO token refresh failed ({resp.status_code}): {resp.text[:300]}")
        data = resp.json()
        conn.access_token = data["access_token"]
        conn.refresh_token = data.get("refresh_token", conn.refresh_token)
        conn.token_expires_at = now + timedelta(seconds=int(data.get("expires_in", 3600)))
        await db.commit()
        return conn.access_token
