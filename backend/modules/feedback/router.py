"""
Feedback intake.

  POST /api/feedback   — submit user feedback from the in-app dialog

Categories: bug | feature | improvement | praise | other.
Lightweight — accepts a category + message + optional client context
(page path, user-agent). Stores one row per submission. No triage
state machine yet — the row's `status` defaults to 'open' for future
workflow.

When RESEND_API_KEY is configured, also fires off an email to
settings.feedback_to_email (default hello@nordavix.com) so the team
gets a notification without polling the DB. The email send happens
AFTER the DB commit and is wrapped in try/except — a failed email
never poisons a successful feedback submission.
"""
import logging
import uuid
from datetime import datetime

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.config import settings
from core.db.session import get_db
from models.feedback import Feedback

logger = logging.getLogger(__name__)
router = APIRouter()


_VALID_CATEGORIES = {"bug", "feature", "improvement", "praise", "other"}


# ── Email helper ──────────────────────────────────────────────────────

# Pre-computed pills for the email category so the inbox preview reads
# clearly without HTML escaping concerns.
_CATEGORY_EMOJI = {
    "bug":         "🐛",
    "feature":     "💡",
    "improvement": "✨",
    "praise":      "💚",
    "other":       "💬",
}


async def _send_feedback_email(
    *, category: str, message: str, user_email: str | None,
    user_name: str | None, page_path: str | None, tenant_id: uuid.UUID,
    feedback_id: uuid.UUID,
) -> None:
    """Fire a Resend email to the configured feedback inbox. No-ops
    silently if email isn't configured. Never raises — caller should
    not block on this (use BackgroundTasks)."""
    if not settings.email_enabled:
        return
    try:
        emoji = _CATEGORY_EMOJI.get(category, "💬")
        subject = f"{emoji} Feedback ({category}): {message[:60]}{'…' if len(message) > 60 else ''}"
        # Plain-text body — easier to read on mobile inboxes than HTML,
        # and avoids any escaping bugs with user-typed content.
        body_text = (
            f"Category: {category}\n"
            f"From:     {user_name or '—'} <{user_email or '—'}>\n"
            f"Page:     {page_path or '—'}\n"
            f"Tenant:   {tenant_id}\n"
            f"ID:       {feedback_id}\n"
            f"\n"
            f"───────────────────────────────────────\n"
            f"{message}\n"
            f"───────────────────────────────────────\n"
            f"\n"
            f"Reply directly to {user_email or 'the team'} to start a conversation."
        )
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {settings.resend_api_key}",
                    "Content-Type":  "application/json",
                },
                json={
                    "from":     settings.resend_from_email,
                    "to":       [settings.feedback_to_email],
                    "subject":  subject,
                    "text":     body_text,
                    # Reply-To = user's email so the team can reply
                    # directly from their inbox without leaving the thread.
                    **({"reply_to": user_email} if user_email else {}),
                },
            )
            if r.status_code >= 300:
                logger.warning(
                    "Resend rejected feedback email: status=%d body=%s",
                    r.status_code, r.text[:300],
                )
    except Exception:
        # Email is a side-effect; never block the user on it.
        logger.exception("Feedback email send failed (non-fatal)")


class FeedbackIn(BaseModel):
    category:   str = Field(..., description="bug | feature | improvement | praise | other")
    message:    str = Field(..., min_length=1, max_length=4000)
    page_path:  str | None = Field(default=None, max_length=255)
    user_agent: str | None = Field(default=None, max_length=500)


class FeedbackOut(BaseModel):
    id:         str
    category:   str
    message:    str
    created_at: str


@router.post("", response_model=FeedbackOut, status_code=201)
async def submit_feedback(
    body: FeedbackIn,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> FeedbackOut:
    """Create one feedback row + fire an email notification."""
    category = body.category.strip().lower()
    if category not in _VALID_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"category must be one of: {', '.join(sorted(_VALID_CATEGORIES))}",
        )
    msg = body.message.strip()
    if not msg:
        raise HTTPException(status_code=400, detail="message is required.")

    row = Feedback(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        user_id=user.id,
        category=category,
        message=msg,
        page_path=(body.page_path or "")[:255] or None,
        user_agent=(body.user_agent or "")[:500] or None,
        status="open",
    )
    db.add(row)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="feedback.submitted",
        entity_type="feedback", entity_id=row.id,
        metadata={
            "summary": f"Feedback ({category}): {msg[:120]}{'…' if len(msg) > 120 else ''}",
            "category": category,
        },
    )
    await db.commit()
    logger.info(
        "Feedback submitted: tenant=%s user=%s category=%s len=%d",
        tenant_id, user.id, category, len(msg),
    )

    # Background-fire the email so the user's HTTP response isn't
    # blocked on Resend's API latency. Even if email is disabled or
    # fails, the feedback is already committed.
    user_email = getattr(user, "email", None)
    user_name  = getattr(user, "display_name", None)
    background_tasks.add_task(
        _send_feedback_email,
        category=category, message=msg,
        user_email=user_email, user_name=user_name,
        page_path=row.page_path, tenant_id=tenant_id, feedback_id=row.id,
    )

    now = row.created_at if row.created_at else datetime.utcnow()
    return FeedbackOut(
        id=str(row.id),
        category=row.category,
        message=row.message,
        created_at=now.isoformat(),
    )
