"""Retention sweep for NDVX Copilot conversations.

Copilot chat is a convenience layer, NOT a system of record — the real records
(reconciliations, proposed entries, financials, the audit log, workpaper
evidence) live in their own tables and are untouched here. So we hard-delete a
chat thread (and its messages) once it has been INACTIVE — no new turn — for
`assistant_retention_days` (default 90). Cross-tenant maintenance job: runs on
the system engine with the tenant filter skipped, like the tenant purge.
"""
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from core.config import settings
from core.db.session import get_async_session_context
from models.assistant_conversation import AssistantMessage, AssistantThread

logger = logging.getLogger(__name__)

_SKIP = {"skip_tenant_filter": True}


async def purge_expired_threads(retention_days: int | None = None) -> dict:
    """Hard-delete Copilot threads (+ their messages) inactive longer than
    `retention_days` (defaults to settings.assistant_retention_days). Idempotent —
    safe to run on a daily schedule. Returns counts. A value <= 0 disables it."""
    days = settings.assistant_retention_days if retention_days is None else retention_days
    if not days or days <= 0:
        return {"threads": 0, "messages": 0, "retention_days": days, "disabled": True}

    cutoff = datetime.now(UTC) - timedelta(days=days)

    async with get_async_session_context() as db:
        ids = (await db.execute(
            select(AssistantThread.id).where(AssistantThread.updated_at < cutoff),
            execution_options=_SKIP,
        )).scalars().all()
        if not ids:
            return {"threads": 0, "messages": 0, "retention_days": days}
        msg_res = await db.execute(
            delete(AssistantMessage).where(AssistantMessage.thread_id.in_(ids)),
            execution_options=_SKIP,
        )
        thr_res = await db.execute(
            delete(AssistantThread).where(AssistantThread.id.in_(ids)),
            execution_options=_SKIP,
        )
        await db.commit()

    out = {
        "threads": thr_res.rowcount or 0,
        "messages": msg_res.rowcount or 0,
        "retention_days": days,
    }
    logger.info("Assistant retention sweep: %s", out)
    return out
