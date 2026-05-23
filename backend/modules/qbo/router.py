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
import json
import uuid
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse, JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.config import settings
from core.db.session import get_db, AsyncSessionLocal
from core.db.base import current_tenant_id as _current_tenant_id
from models.qbo_connection import QboConnection

# Two routers: oauth (no auth gate) and qbo (requires tenant auth)
oauth_router = APIRouter()
qbo_router   = APIRouter()

_QBO_SCOPES = "com.intuit.quickbooks.accounting"
_AUTH_BASE  = "https://appcenter.intuit.com/connect/oauth2"
_TOKEN_URL  = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"


def _encode_state(tenant_id: uuid.UUID) -> str:
    """Encode tenant_id into OAuth state (base64 JSON). Not cryptographically signed for MVP."""
    payload = json.dumps({"tid": str(tenant_id)})
    return base64.urlsafe_b64encode(payload.encode()).decode()


def _decode_state(state: str) -> uuid.UUID | None:
    """Decode state back to tenant_id. Returns None if malformed."""
    try:
        payload = json.loads(base64.urlsafe_b64decode(state.encode()))
        return uuid.UUID(payload["tid"])
    except Exception:
        return None


# ── OAuth flow ─────────────────────────────────────────────────────────────────

@oauth_router.get("/connect")
async def qbo_connect(
    tenant_id: CurrentTenantId,
) -> RedirectResponse:
    """Redirect browser to QBO's OAuth2 authorization page. Encodes tenant_id in state."""
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
        return RedirectResponse(url=f"{frontend_url}/app/flux?qbo=error&reason={error}")

    if not settings.qbo_enabled:
        return RedirectResponse(url=f"{frontend_url}/app/flux?qbo=error&reason=not_configured")

    # Decode tenant_id from state
    tenant_id = _decode_state(state)
    if tenant_id is None:
        return RedirectResponse(url=f"{frontend_url}/app/flux?qbo=error&reason=invalid_state")

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
        return RedirectResponse(url=f"{frontend_url}/app/flux?qbo=error&reason=token_exchange")

    token_data     = token_resp.json()
    access_token   = token_data["access_token"]
    refresh_token  = token_data["refresh_token"]
    expires_in     = int(token_data.get("expires_in", 3600))
    expires_at     = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

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
            company_name = (
                data.get("QueryResponse", {})
                .get("CompanyInfo", [{}])[0]
                .get("CompanyName")
            )
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

    return RedirectResponse(url=f"{frontend_url}/app/flux?qbo=connected")


# ── QBO API endpoints (auth required) ─────────────────────────────────────────

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
    now = datetime.now(timezone.utc)
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
