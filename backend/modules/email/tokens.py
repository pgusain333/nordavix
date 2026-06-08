"""
Signed, no-auth tokens for email action links (currently: unsubscribe).

Mirrors the HMAC state idiom used for QBO OAuth (``modules/qbo/router.py``): a
base64url JSON payload joined to a truncated HMAC-SHA256 over that payload.

The link is intentionally public — anyone holding it can unsubscribe that one
person, which is the desired one-click CAN-SPAM behavior — but it cannot be
forged or retargeted at someone else without the server secret. There is NO TTL:
an unsubscribe link must keep working indefinitely.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json

from core.config import settings


def _secret() -> bytes:
    """Signing secret. Prefer the internal-task secret (purpose-built for ops /
    lifecycle jobs); fall back to the always-present Clerk secret, then a constant
    so encoding never crashes in dev. Verification uses the same resolution."""
    raw = settings.internal_task_secret or settings.clerk_secret_key or "nordavix-email-fallback"
    return raw.encode()


def make_unsubscribe_token(clerk_user_id: str) -> str:
    """Return a signed token encoding the clerk_user_id: ``base64(payload).hmac``."""
    payload = json.dumps({"cuid": clerk_user_id}, separators=(",", ":"))
    body = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    sig = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{body}.{sig}"


def read_unsubscribe_token(token: str) -> str | None:
    """Verify the HMAC and return the clerk_user_id. None on any failure
    (bad signature, tampered/garbage payload, malformed)."""
    try:
        body, sig = token.rsplit(".", 1)
        expected = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, expected):
            return None
        padding = "=" * ((4 - len(body) % 4) % 4)
        payload = json.loads(base64.urlsafe_b64decode((body + padding).encode()))
        cuid = payload.get("cuid")
        return cuid if isinstance(cuid, str) and cuid else None
    except Exception:
        return None
