"""Client assistant API — grounded, tenant-scoped Q&A (Tier 3 Phase 0).

POST /api/assistant/ask runs Claude with read-only, tenant-scoped tools and
returns a grounded answer plus the tools it consulted. Guarded by enforce_ai_limits
(AI rate limit + monthly spend cap) and the tenant middleware (so the request's
get_db session is scoped to the caller's client).
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.guard import enforce_ai_limits
from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from modules.assistant.schemas import AskRequest, AskResponse
from modules.assistant.service import answer_question

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/ask", response_model=AskResponse, dependencies=[Depends(enforce_ai_limits)])
async def ask(
    body: AskRequest,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> AskResponse:
    """Answer a question about the current client, grounded in their real data."""
    try:
        result = await answer_question(
            db=db,
            tenant_id=tenant_id,
            question=body.question.strip(),
            period_end=body.period_end,
            history=[m.model_dump() for m in (body.history or [])],
        )
    except Exception:
        logger.exception("assistant ask failed for tenant %s", tenant_id)
        raise HTTPException(
            status_code=502,
            detail="The assistant is temporarily unavailable. Please try again in a moment.",
        ) from None
    return AskResponse(**result)
