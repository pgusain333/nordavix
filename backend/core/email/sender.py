"""
Resend email sender — the single chokepoint for outgoing transactional email.

Both helpers are best-effort: they no-op silently when email isn't configured
(`settings.email_enabled` is False) and never raise — email is a side effect and
must never break the request that triggered it. Callers fire these from FastAPI
`BackgroundTasks` so the user's response isn't blocked on Resend's latency.
"""
from __future__ import annotations

import logging

import httpx

from core.config import settings

logger = logging.getLogger(__name__)

_RESEND_URL       = "https://api.resend.com/emails"
_RESEND_BATCH_URL = "https://api.resend.com/emails/batch"
_BATCH_MAX        = 100  # Resend's per-call ceiling.


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.resend_api_key}",
        "Content-Type":  "application/json",
    }


async def send_email(
    *,
    to: str | list[str],
    subject: str,
    html: str | None = None,
    text: str | None = None,
    reply_to: str | None = None,
    from_email: str | None = None,
) -> bool:
    """Send one email. Returns True on success. No-op (False) if email is
    disabled. Never raises."""
    if not settings.email_enabled:
        return False
    recipients = [to] if isinstance(to, str) else list(to)
    if not recipients:
        return False
    payload: dict = {
        "from":    from_email or settings.resend_from_email,
        "to":      recipients,
        "subject": subject,
    }
    if html is not None:
        payload["html"] = html
    if text is not None:
        payload["text"] = text
    if reply_to:
        payload["reply_to"] = reply_to
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(_RESEND_URL, headers=_headers(), json=payload)
            if r.status_code >= 300:
                logger.warning("Resend rejected email: status=%d body=%s", r.status_code, r.text[:300])
                return False
            return True
    except Exception:
        logger.exception("Email send failed (non-fatal)")
        return False


async def send_batch(messages: list[dict]) -> int:
    """Send many distinct emails in as few API calls as possible (Resend's
    batch endpoint, ≤100 per call). Each message dict is a fully-formed Resend
    payload (`from`, `to`, `subject`, `html`/`text`). Returns the number of
    messages handed to Resend across successful batches. No-op if disabled;
    never raises."""
    if not settings.email_enabled or not messages:
        return 0
    sent = 0
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            for start in range(0, len(messages), _BATCH_MAX):
                chunk = messages[start:start + _BATCH_MAX]
                r = await client.post(_RESEND_BATCH_URL, headers=_headers(), json=chunk)
                if r.status_code >= 300:
                    logger.warning(
                        "Resend rejected batch (%d msgs): status=%d body=%s",
                        len(chunk), r.status_code, r.text[:300],
                    )
                    continue
                sent += len(chunk)
    except Exception:
        logger.exception("Batch email send failed (non-fatal)")
    return sent
