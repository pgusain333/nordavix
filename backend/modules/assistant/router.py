"""Client assistant API — grounded, tenant-scoped Q&A + conversation memory.

POST /api/assistant/ask runs Claude with read-only, tenant-scoped tools and
returns a grounded answer plus the tools it consulted, persisting the turn into a
conversation thread (Phase 1). GET /threads + /threads/{id} power the history
panel. Guarded by enforce_ai_limits and the tenant middleware (so the request's
get_db session is scoped to the caller's client).
"""
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.guard import enforce_ai_limits
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.base import current_request_readonly
from core.db.session import get_db
from models.assistant_conversation import AssistantMessage, AssistantThread
from modules.assistant.schemas import (
    AskRequest,
    AskResponse,
    ThreadMessage,
    ThreadSummary,
)
from modules.assistant.service import answer_question, persist_turn

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/ask", response_model=AskResponse, dependencies=[Depends(enforce_ai_limits)])
async def ask(
    body: AskRequest,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> AskResponse:
    """Answer a question about the current client, grounded in their real data,
    and persist the turn into a conversation thread."""
    question = body.question.strip()
    try:
        result = await answer_question(
            db=db,
            tenant_id=tenant_id,
            question=question,
            period_end=body.period_end,
            history=[m.model_dump() for m in (body.history or [])],
        )
    except Exception:
        logger.exception("assistant ask failed for tenant %s", tenant_id)
        raise HTTPException(
            status_code=502,
            detail="The assistant is temporarily unavailable. Please try again in a moment.",
        ) from None

    # Persist the turn (best-effort). Skipped for read-only requests
    # (demo / suspended members) where writes are blocked by design.
    thread_id = body.thread_id
    if not current_request_readonly.get():
        try:
            thread_id = await persist_turn(
                db=db,
                tenant_id=tenant_id,
                user_id=user.id,
                thread_id=body.thread_id,
                question=question,
                answer=result["answer"],
                sources=result.get("sources"),
            )
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("assistant persist failed for tenant %s", tenant_id)
            thread_id = body.thread_id

    return AskResponse(answer=result["answer"], sources=result["sources"], thread_id=thread_id)


@router.get("/threads", response_model=list[ThreadSummary])
async def list_threads(
    tenant_id: CurrentTenantId,  # noqa: ARG001 — scoping is via the session filter
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> list[ThreadSummary]:
    """The current user's recent conversations for this client, newest first."""
    rows = (await db.execute(
        select(AssistantThread)
        .where(AssistantThread.created_by == user.id)
        .order_by(AssistantThread.updated_at.desc())
        .limit(40)
    )).scalars().all()
    return [ThreadSummary(id=t.id, title=t.title, updated_at=t.updated_at) for t in rows]


@router.get("/threads/{thread_id}", response_model=list[ThreadMessage])
async def get_thread(
    thread_id: uuid.UUID,
    tenant_id: CurrentTenantId,  # noqa: ARG001 — scoping is via the session filter
    user: CurrentUser,  # noqa: ARG001 — auth required; thread is tenant-scoped
    db: AsyncSession = Depends(get_db),
) -> list[ThreadMessage]:
    """Full message history for one conversation (tenant-scoped)."""
    thread = (await db.execute(
        select(AssistantThread).where(AssistantThread.id == thread_id)
    )).scalar_one_or_none()
    if thread is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    msgs = (await db.execute(
        select(AssistantMessage)
        .where(AssistantMessage.thread_id == thread_id)
        .order_by(AssistantMessage.created_at.asc())
    )).scalars().all()
    return [
        ThreadMessage(role=m.role, content=m.content, sources=m.sources, created_at=m.created_at)
        for m in msgs
    ]
