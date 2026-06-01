"""
QuickBooks Online OAuth2 integration.

OAuth2 flow:
  1. GET /api/oauth/qbo/connect   → auth required → returns OAuth redirect URL (or redirects)
  2. GET /api/oauth/qbo/callback  → public (QBO browser redirect) → exchanges code → redirects to app

QBO API endpoints (all auth-required):
  GET /api/qbo/connection         → check if connected
  GET /api/qbo/trial-balance      → fetch TB report from QBO

State encoding: tenant_id is base64-encoded in the OAuth state parameter so the callback
can associate the tokens with the right tenant without an auth token.
"""
import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, RequireAdmin, require_role
from core.config import settings
from core.db.base import current_tenant_id as _current_tenant_id
from core.db.session import AsyncSessionLocal, get_db
from models.qbo_connection import QboConnection

# Two routers: oauth (no auth gate) and qbo (requires tenant auth)
oauth_router = APIRouter()
qbo_router   = APIRouter()

_QBO_SCOPES = "com.intuit.quickbooks.accounting"
_AUTH_BASE  = "https://appcenter.intuit.com/connect/oauth2"
_TOKEN_URL  = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
# Intuit OAuth2 token revocation. Revoking the refresh token invalidates the
# entire grant (access + refresh), so Nordavix's access to the company's books
# stops immediately — this is what we call when a workspace is deleted or the
# user disconnects QBO, so no stale token can linger past the off-boarding.
_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke"


# OAuth state is HMAC-signed so the callback can't be tricked into binding
# QBO tokens to an attacker-chosen tenant. A 15-minute TTL bounds replay —
# an OAuth round trip takes seconds. Signed with the server-only Clerk
# secret (never exposed to clients).
_STATE_TTL_SECONDS = 900


def _state_secret() -> bytes:
    return (settings.clerk_secret_key or "nordavix-state-fallback").encode()


def _encode_state(tenant_id: uuid.UUID) -> str:
    """Encode tenant_id into a SIGNED OAuth state: base64(payload).hmac.
    Payload carries the tenant id + issued-at epoch; the HMAC binds them so
    the callback rejects any forged/tampered state."""
    payload = json.dumps({"tid": str(tenant_id), "iat": int(time.time())}, separators=(",", ":"))
    body = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    sig = hmac.new(_state_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{sig}"


def _decode_state(state: str) -> uuid.UUID | None:
    """Verify the HMAC + TTL, then return tenant_id. None on any failure
    (bad signature, tampered payload, expired, malformed)."""
    try:
        body, sig = state.rsplit(".", 1)
        expected = hmac.new(_state_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, expected):
            return None
        padding = "=" * ((4 - len(body) % 4) % 4)
        payload = json.loads(base64.urlsafe_b64decode((body + padding).encode()))
        if int(time.time()) - int(payload.get("iat", 0)) > _STATE_TTL_SECONDS:
            return None
        return uuid.UUID(payload["tid"])
    except Exception:
        return None


# ── OAuth flow ─────────────────────────────────────────────────────────────────

@oauth_router.get("/connect", dependencies=[Depends(require_role("admin"))])
async def qbo_connect(
    tenant_id: CurrentTenantId,
) -> RedirectResponse:
    """
    Redirect browser to QBO's OAuth2 authorization page. Admin-only —
    connecting QBO shares the entire company's books with Nordavix, so
    only the workspace admin should be able to start that flow.
    Encodes tenant_id in state.
    """
    if not settings.qbo_enabled:
        raise HTTPException(
            status_code=503,
            detail="QuickBooks integration is not configured. Set QBO_CLIENT_ID and QBO_CLIENT_SECRET."
        )

    state = _encode_state(tenant_id)
    params = {
        "client_id":     settings.qbo_client_id,
        "response_type": "code",
        "scope":         _QBO_SCOPES,
        "redirect_uri":  settings.qbo_redirect_uri,
        "state":         state,
    }
    url = f"{_AUTH_BASE}?{urlencode(params)}"
    return RedirectResponse(url=url)


@oauth_router.get("/callback")
async def qbo_callback(
    code:     str = Query(...),
    realm_id: str = Query(..., alias="realmId"),
    state:    str = Query(...),
    error:    str | None = Query(default=None),
) -> RedirectResponse:
    """
    QBO redirects here after user authorization (no Clerk auth — public endpoint).
    Decodes tenant_id from state, exchanges code for tokens, stores connection.
    """
    frontend_url = settings.cors_origins_list[0] if settings.cors_origins_list else "http://localhost:5173"

    if error:
        return RedirectResponse(url=f"{frontend_url}/app?qbo=error&reason={error}")

    if not settings.qbo_enabled:
        return RedirectResponse(url=f"{frontend_url}/app?qbo=error&reason=not_configured")

    # Decode tenant_id from state
    tenant_id = _decode_state(state)
    if tenant_id is None:
        return RedirectResponse(url=f"{frontend_url}/app?qbo=error&reason=invalid_state")

    # Exchange code for tokens
    credentials = base64.b64encode(
        f"{settings.qbo_client_id}:{settings.qbo_client_secret}".encode()
    ).decode()

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            _TOKEN_URL,
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type":  "application/x-www-form-urlencoded",
                "Accept":        "application/json",
            },
            data={
                "grant_type":   "authorization_code",
                "code":         code,
                "redirect_uri": settings.qbo_redirect_uri,
            },
        )

    if token_resp.status_code != 200:
        return RedirectResponse(url=f"{frontend_url}/app?qbo=error&reason=token_exchange")

    token_data     = token_resp.json()
    access_token   = token_data["access_token"]
    refresh_token  = token_data["refresh_token"]
    expires_in     = int(token_data.get("expires_in", 3600))
    expires_at     = datetime.now(UTC) + timedelta(seconds=expires_in)

    # Fetch company name
    company_name: str | None = None
    try:
        async with httpx.AsyncClient() as client:
            base = settings.qbo_base_url
            info_resp = await client.get(
                f"{base}/v3/company/{realm_id}/companyinfo/{realm_id}",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept":        "application/json",
                },
            )
        if info_resp.status_code == 200:
            data = info_resp.json()
            # Direct /companyinfo/{realm_id} returns:
            #   { "CompanyInfo": { "CompanyName": "...", ... }, "time": "..." }
            # NOT the QueryResponse shape (which only wraps SELECT queries).
            # Earlier code parsed the wrong shape, silently produced None,
            # and the UI fell back to "(QuickBooks company name unavailable)".
            ci = data.get("CompanyInfo") or {}
            company_name = ci.get("CompanyName") or ci.get("LegalName")
    except Exception:
        pass

    # Set tenant context for DB operations
    _current_tenant_id.set(tenant_id)

    # Upsert QboConnection
    async with AsyncSessionLocal() as session:
        existing_result = await session.execute(
            select(QboConnection).where(QboConnection.tenant_id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )
        existing = existing_result.scalar_one_or_none()

        if existing:
            existing.realm_id         = realm_id
            existing.access_token     = access_token
            existing.refresh_token    = refresh_token
            existing.token_expires_at = expires_at
            if company_name:
                existing.company_name = company_name
        else:
            conn = QboConnection(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                realm_id=realm_id,
                company_name=company_name,
                access_token=access_token,
                refresh_token=refresh_token,
                token_expires_at=expires_at,
            )
            session.add(conn)

        await session.commit()

    return RedirectResponse(url=f"{frontend_url}/app?qbo=connected")


# ── QBO API endpoints (auth required) ─────────────────────────────────────────

@qbo_router.get("/connect-url", dependencies=[Depends(require_role("admin"))])
async def get_qbo_connect_url(
    tenant_id: CurrentTenantId,
) -> dict:
    """
    Return the Intuit OAuth2 authorization URL as JSON. Admin-only —
    connecting QBO shares the entire company's books with Nordavix, so
    only the workspace admin should be able to start that flow.

    The frontend calls this with its auth token, then redirects the browser
    to the returned URL. This avoids the browser navigating directly to
    /connect without a JWT.
    """
    if not settings.qbo_enabled:
        raise HTTPException(
            status_code=503,
            detail="QuickBooks integration is not configured."
        )
    state = _encode_state(tenant_id)
    params = {
        "client_id":     settings.qbo_client_id,
        "response_type": "code",
        "scope":         _QBO_SCOPES,
        "redirect_uri":  settings.qbo_redirect_uri,
        "state":         state,
    }
    url = f"{_AUTH_BASE}?{urlencode(params)}"
    return {"url": url}


@qbo_router.get("/connection")
async def get_qbo_connection(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Check if the current tenant has an active QBO connection."""
    result = await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id)
    )
    conn = result.scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=404, detail="No QuickBooks connection found.")
    return {
        "id":          str(conn.id),
        "realm_id":    conn.realm_id,
        "company":     conn.company_name or "QuickBooks Company",
        "connected_at":conn.connected_at.isoformat(),
    }


@qbo_router.get("/trial-balance")
async def fetch_qbo_trial_balance(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
    start_date: str = Query(..., description="Period start date YYYY-MM-DD"),
    end_date:   str = Query(..., description="Period end date YYYY-MM-DD"),
) -> dict:
    """Fetch a Trial Balance report from QBO for the given date range."""
    result = await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id)
    )
    conn = result.scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=404, detail="No QuickBooks connection. Connect QBO first.")

    access_token = await _get_valid_token(conn, db)

    url = (
        f"{settings.qbo_base_url}/v3/company/{conn.realm_id}/reports/TrialBalance"
        f"?start_date={start_date}&end_date={end_date}&accounting_method=Accrual"
    )

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept":        "application/json",
            },
        )

    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="QBO token expired. Please reconnect.")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"QBO API error: {resp.text[:500]}")

    return {
        "report":    resp.json(),
        "realm_id":  conn.realm_id,
        "company":   conn.company_name,
    }


async def _get_valid_token(conn: QboConnection, db: AsyncSession) -> str:
    """Return a valid access token, refreshing if close to expiry."""
    now = datetime.now(UTC)
    if conn.token_expires_at and conn.token_expires_at > now + timedelta(minutes=5):
        return conn.access_token

    if not settings.qbo_enabled:
        raise HTTPException(status_code=503, detail="QBO not configured.")

    credentials = base64.b64encode(
        f"{settings.qbo_client_id}:{settings.qbo_client_secret}".encode()
    ).decode()

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            _TOKEN_URL,
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type":  "application/x-www-form-urlencoded",
            },
            data={
                "grant_type":    "refresh_token",
                "refresh_token": conn.refresh_token,
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Failed to refresh QBO token. Please reconnect.")

    data = resp.json()
    conn.access_token     = data["access_token"]
    conn.refresh_token    = data.get("refresh_token", conn.refresh_token)
    conn.token_expires_at = now + timedelta(seconds=int(data.get("expires_in", 3600)))
    await db.commit()

    return conn.access_token


async def revoke_qbo_token(conn: QboConnection) -> bool:
    """
    Revoke a tenant's QBO OAuth grant at Intuit so Nordavix loses all access
    to the company's books immediately. Revoking the refresh token kills the
    whole grant (access token included).

    Best-effort: returns True on a clean revoke, False otherwise. Callers
    proceed with local deletion regardless — a failed remote revoke must not
    block off-boarding (the local tokens are deleted and would expire anyway),
    but we log it so it can be retried/audited.
    """
    if not settings.qbo_enabled:
        return False
    credentials = base64.b64encode(
        f"{settings.qbo_client_id}:{settings.qbo_client_secret}".encode()
    ).decode()
    # Prefer the long-lived refresh token; fall back to the access token.
    token = conn.refresh_token or conn.access_token
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                _REVOKE_URL,
                headers={
                    "Authorization": f"Basic {credentials}",
                    "Content-Type":  "application/json",
                    "Accept":        "application/json",
                },
                json={"token": token},
            )
        # Intuit returns 200 on success. 401/400 typically mean the token was
        # already invalid/expired — functionally revoked, so treat as success.
        if resp.status_code in (200, 204):
            return True
        import logging
        logging.getLogger(__name__).warning(
            "QBO token revoke returned %s for realm %s: %s",
            resp.status_code, conn.realm_id, resp.text[:300],
        )
        return resp.status_code in (400, 401)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("QBO token revoke request failed")
        return False


@qbo_router.delete("/connection", dependencies=[Depends(require_role("admin"))])
async def disconnect_qbo(
    tenant_id: CurrentTenantId,
    current_user: RequireAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Admin-only: disconnect QuickBooks. Revokes the OAuth grant at Intuit and
    deletes the local connection (encrypted tokens included). After this,
    Nordavix holds no QBO credentials for the tenant until they reconnect.

    Already-synced data (snapshots, reconciliations, flux) is untouched — this
    severs the live connection only. Idempotent: a 404 means nothing to do.
    """
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=404, detail="No QuickBooks connection to disconnect.")

    realm_id = conn.realm_id
    revoked = await revoke_qbo_token(conn)
    await db.delete(conn)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=current_user.id,
        action="qbo.disconnected",
        entity_type="qbo_connection", entity_id=None,
        metadata={
            "summary":      "Disconnected QuickBooks",
            "realm_id":     realm_id,
            "token_revoked": revoked,
        },
    )
    await db.commit()
    return {"disconnected": True, "token_revoked": revoked}
