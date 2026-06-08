"""
Public email-action endpoints (no auth) — currently the one-click unsubscribe
for the re-engagement drip. Mounted at /api/email and listed in the tenancy
middleware's _PUBLIC_PREFIXES because these links are followed straight from an
email (and POSTed by mail clients for RFC 8058 one-click), with no Clerk JWT.

Security: the token is HMAC-signed (modules/email/tokens.py); it only ever maps
to one person's enrollment and can't be forged or retargeted. An invalid token
returns a friendly page and changes nothing (we never reveal token validity).
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from html import escape

from fastapi import APIRouter, Query, Response
from fastapi.responses import HTMLResponse
from sqlalchemy import select

from core.db.session import AsyncSessionLocal
from models.reengagement_enrollment import ReengagementEnrollment
from modules.email.tokens import read_unsubscribe_token

logger = logging.getLogger(__name__)

router = APIRouter()


def _page(message: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>Nordavix</title></head>"
        '<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'
        "'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\">"
        '<div style="max-width:460px;margin:64px auto;padding:32px;background:#fff;'
        'border:1px solid #ececee;border-radius:16px;text-align:center;">'
        '<p style="font-size:20px;font-weight:700;color:#111827;margin:0;">'
        'nordavix<span style="color:#10b981;">.</span></p>'
        f'<p style="font-size:15px;line-height:1.6;color:#4b5563;margin:14px 0 0;">{escape(message)}</p>'
        "</div></body></html>"
    )


async def _apply_unsubscribe(token: str) -> bool:
    """Mark the token's enrollment unsubscribed. Returns False only when the token
    itself is invalid (so the caller can show a different message)."""
    cuid = read_unsubscribe_token(token)
    if not cuid:
        return False
    try:
        async with AsyncSessionLocal() as session:
            enr = (await session.execute(
                select(ReengagementEnrollment).where(ReengagementEnrollment.clerk_user_id == cuid)
            )).scalar_one_or_none()
            if enr is not None and enr.status != "unsubscribed":
                enr.status = "unsubscribed"
                enr.unsubscribed_at = datetime.now(UTC)
                await session.commit()
    except Exception:
        logger.exception("Unsubscribe write failed")
    return True


@router.get("/unsubscribe", response_class=HTMLResponse)
async def unsubscribe_get(token: str = Query(default="")) -> HTMLResponse:
    ok = await _apply_unsubscribe(token) if token else False
    msg = (
        "You're unsubscribed. You won't receive any more onboarding emails from Nordavix."
        if ok else
        "This unsubscribe link looks invalid. If you keep getting emails, just reply to one "
        "and we'll remove you right away."
    )
    return HTMLResponse(_page(msg))


@router.post("/unsubscribe")
async def unsubscribe_post(token: str = Query(default="")) -> Response:
    """RFC 8058 one-click target — mail clients POST here. Always returns 200."""
    if token:
        await _apply_unsubscribe(token)
    return Response(status_code=200)
