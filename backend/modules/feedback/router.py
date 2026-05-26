"""
Feedback intake.

  POST /api/feedback   — submit user feedback from the in-app dialog

Categories: bug | feature | improvement | praise | other.
Lightweight — accepts a category + message + optional client context
(page path, user-agent). Stores one row per submission. No triage
state machine yet — the row's `status` defaults to 'open' for future
workflow.
"""
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.feedback import Feedback

logger = logging.getLogger(__name__)
router = APIRouter()


_VALID_CATEGORIES = {"bug", "feature", "improvement", "praise", "other"}


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
    db: AsyncSession = Depends(get_db),
) -> FeedbackOut:
    """Create one feedback row from a user submission."""
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
    now = row.created_at if row.created_at else datetime.utcnow()
    return FeedbackOut(
        id=str(row.id),
        category=row.category,
        message=row.message,
        created_at=now.isoformat(),
    )
