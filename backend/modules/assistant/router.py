"""Client assistant API — grounded, tenant-scoped Q&A + conversation memory.

POST /api/assistant/ask runs Claude with read-only, tenant-scoped tools and
returns a grounded answer plus the tools it consulted, persisting the turn into a
conversation thread (Phase 1). GET /threads + /threads/{id} power the history
panel. Guarded by enforce_ai_limits and the tenant middleware (so the request's
get_db session is scoped to the caller's client).
"""
import json
import logging
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.guard import enforce_ai_limits
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.base import current_request_readonly
from core.db.session import get_db
from models.assistant_conversation import AssistantMessage, AssistantThread
from models.proposed_entry import ProposedEntry
from models.tenant import Tenant
from modules.assistant.export import build_answer_pdf, build_answer_xlsx
from modules.assistant.schemas import (
    AskRequest,
    AskResponse,
    AssistantExportRequest,
    ThreadMessage,
    ThreadSummary,
)
from modules.assistant.service import answer_question, answer_question_stream, persist_turn


def _sse(obj: dict) -> str:
    """Serialize one event as a Server-Sent-Events frame."""
    return f"data: {json.dumps(obj, default=str)}\n\n"


def _persist_draft(db: AsyncSession, tenant_id: uuid.UUID, user_id, thread_id, d: dict) -> None:
    """Persist one assistant-drafted JE into the Adjustments queue (open, for review)."""
    db.add(ProposedEntry(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        source="assistant",
        source_ref=str(thread_id) if thread_id else "assistant",
        period_end=date.fromisoformat(d["period_end"]),
        description=d.get("description") or "Assistant-drafted entry",
        lines=d.get("lines") or [],
        memo=d.get("memo"),
        rationale=d.get("rationale"),
        confidence=d.get("confidence") or "medium",
        status="open",
        created_by=user_id,
    ))

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
            user_role=user.role,
            user_powers=getattr(user, "delegated_powers", None),
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
            # Persist any assistant-drafted JEs into the Adjustments queue
            # (source="assistant", status="open") for human review + posting.
            for d in result.get("drafts", []):
                try:
                    _persist_draft(db, tenant_id, user.id, thread_id, d)
                except Exception:
                    logger.exception("assistant: skipped a malformed draft")
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("assistant persist failed for tenant %s", tenant_id)
            thread_id = body.thread_id

    return AskResponse(
        answer=result["answer"],
        sources=result["sources"],
        thread_id=thread_id,
        drafts=result.get("drafts", []),
        links=result.get("links", []),
        actions=result.get("actions", []),
        charts=result.get("charts", []),
    )


@router.post("/ask/stream", dependencies=[Depends(enforce_ai_limits)])
async def ask_stream(
    body: AskRequest,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Same as /ask, but streams the answer token-by-token over SSE so the UI shows
    it as it's generated. Events: step (a tool ran), delta (answer chunk), reset
    (clear partial), result (sources/drafts/links), done (thread_id), error."""
    question = body.question.strip()
    history = [m.model_dump() for m in (body.history or [])]

    async def event_stream():
        answer, sources, drafts = "", [], []
        try:
            async for ev in answer_question_stream(
                db=db,
                tenant_id=tenant_id,
                question=question,
                period_end=body.period_end,
                history=history,
                user_role=user.role,
                user_powers=getattr(user, "delegated_powers", None),
            ):
                if ev.get("type") == "result":
                    answer = ev.get("answer", "")
                    sources = ev.get("sources", [])
                    drafts = ev.get("drafts", [])
                yield _sse(ev)
        except Exception:
            logger.exception("assistant stream failed for tenant %s", tenant_id)
            yield _sse({"type": "error", "message": "The assistant is temporarily unavailable. Please try again in a moment."})
            return

        # Persist the turn AFTER the loop — the read-only guard is reset once the
        # generator above is exhausted, so these writes are allowed. Best-effort;
        # skipped for read-only requests (demo / suspended members).
        thread_id = body.thread_id
        if not current_request_readonly.get():
            try:
                thread_id = await persist_turn(
                    db=db, tenant_id=tenant_id, user_id=user.id,
                    thread_id=body.thread_id, question=question,
                    answer=answer, sources=sources,
                )
                for d in drafts:
                    try:
                        _persist_draft(db, tenant_id, user.id, thread_id, d)
                    except Exception:
                        logger.exception("assistant: skipped a malformed draft")
                await db.commit()
            except Exception:
                await db.rollback()
                logger.exception("assistant stream persist failed for tenant %s", tenant_id)
                thread_id = body.thread_id
        yield _sse({"type": "done", "thread_id": str(thread_id) if thread_id else None})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/export")
async def export_answer(
    body: AssistantExportRequest,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Export one Copilot answer (its text + any charts) as a branded PDF or Excel
    file. Pure formatting of content the client already has — no AI spend. The only
    DB read is the workspace name (for branding); Tenant isn't tenant-scoped, so we
    filter by the caller's own id."""
    company = "Nordavix"
    try:
        tenant = (await db.execute(
            select(Tenant).where(Tenant.id == tenant_id)
        )).scalar_one_or_none()
        if tenant and tenant.name:
            company = tenant.name
    except Exception:
        logger.exception("assistant export: workspace name lookup failed")

    try:
        if body.format == "pdf":
            data = build_answer_pdf(
                question=body.question, answer=body.answer,
                charts=body.charts, company=company,
            )
            media, ext = "application/pdf", "pdf"
        else:
            data = build_answer_xlsx(
                question=body.question, answer=body.answer, charts=body.charts,
            )
            media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ext = "xlsx"
    except Exception:
        logger.exception("assistant export failed for tenant %s", tenant_id)
        raise HTTPException(
            status_code=500,
            detail="Couldn't generate the export. Please try again.",
        ) from None

    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="ndvx-copilot-answer.{ext}"'},
    )


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


@router.delete("/threads/{thread_id}", status_code=204)
async def delete_thread(
    thread_id: uuid.UUID,
    tenant_id: CurrentTenantId,  # noqa: ARG001 — scoping is via the session filter
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Delete one of the current user's conversations (the thread + its messages).
    Tenant-scoped via the session filter; we additionally require the caller to be
    the thread's owner so users can't delete each other's chats. No DB-level FK, so
    the messages are removed explicitly."""
    if current_request_readonly.get():
        raise HTTPException(status_code=403, detail="This is a read-only session.")
    thread = (await db.execute(
        select(AssistantThread).where(AssistantThread.id == thread_id)
    )).scalar_one_or_none()
    if thread is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    if thread.created_by and user.id and thread.created_by != user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own conversations.")
    await db.execute(delete(AssistantMessage).where(AssistantMessage.thread_id == thread_id))
    await db.execute(delete(AssistantThread).where(AssistantThread.id == thread_id))
    await db.commit()
    return Response(status_code=204)
