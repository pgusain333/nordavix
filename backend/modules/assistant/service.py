"""Client assistant — grounded, tenant-scoped tool-calling Q&A (Tier 3 Phase 0).

Runs Claude in a tool-use loop with the read-only tools in tools.py. The whole
loop executes under a HARD read-only DB guard (current_request_readonly), so even
if a reused service function tried to write, it would raise rather than mutate —
the assistant can only ever READ this client's data. Usage is recorded per turn
via the same per-tenant AIUsage capture the rest of the app uses.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, date, datetime
from typing import Any

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.usage import record_call
from core.config import settings
from core.db.base import current_request_readonly
from models.assistant_conversation import AssistantMessage, AssistantThread
from modules.assistant.tools import TOOL_DEFS, dispatch_tool, latest_synced_period

logger = logging.getLogger(__name__)

_aclient = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

# Same rates as core/ai/client.py — for the per-tenant cost estimate only.
_COST_PER_INPUT = 3.00 / 1_000_000
_COST_PER_OUTPUT = 15.00 / 1_000_000

_MAX_TURNS = 6          # tool round-trips before we stop (loop backstop)
_MAX_TOKENS = 1024
_MAX_HISTORY = 8        # prior turns carried for context

_SYSTEM = (
    "You are Nordavix's month-end close assistant for ONE accounting client — the "
    "workspace you are called in. Answer ONLY from the data your tools return; never "
    "invent or estimate numbers, balances, or statuses. If a tool returns no data "
    "(e.g. the period hasn't been synced), say so plainly and suggest the next step "
    "(e.g. \"run Sync for that month\"). When you state a figure, attribute it "
    "(account name/number and period). Money is USD; show variances with their sign "
    "and call out anything that doesn't tie out. Be concise and practical for a CPA. "
    "If the user hasn't named a month and a tool needs one, ask which period "
    "(YYYY-MM-DD). You can only READ this client's data — you cannot post entries or "
    "change anything; if asked to, explain how they'd do it in the app."
)


def _block_to_dict(block: Any) -> dict:
    if block.type == "text":
        return {"type": "text", "text": block.text}
    if block.type == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    return {"type": block.type}


def _record(resp: Any) -> None:
    try:
        u = resp.usage
        cost = u.input_tokens * _COST_PER_INPUT + u.output_tokens * _COST_PER_OUTPUT
        record_call(
            model=settings.anthropic_model,
            input_tokens=u.input_tokens,
            output_tokens=u.output_tokens,
            cost=cost,
            operation="assistant",
        )
    except Exception:  # pragma: no cover — usage tracking must never break a turn
        pass


async def answer_question(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    question: str,
    period_end: date | None = None,
    history: list[dict] | None = None,
) -> dict:
    """Run the grounded tool-use loop and return {answer, sources}."""
    messages: list[dict] = []
    for h in (history or [])[-_MAX_HISTORY:]:
        role, content = h.get("role"), h.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": question})

    sources: list[dict] = []
    # Hard read-only for the whole loop: the assistant must never mutate data.
    ro_token = current_request_readonly.set(True)
    try:
        # Default the context period to the latest synced month so the assistant
        # works out of the box; the model can still target another month per tool.
        if period_end is None:
            period_end = await latest_synced_period(db)

        for _turn in range(_MAX_TURNS):
            resp = await _aclient.messages.create(
                model=settings.anthropic_model,
                max_tokens=_MAX_TOKENS,
                system=_SYSTEM,
                tools=TOOL_DEFS,
                messages=messages,
            )
            _record(resp)

            if resp.stop_reason == "tool_use":
                messages.append({"role": "assistant", "content": [_block_to_dict(b) for b in resp.content]})
                results: list[dict] = []
                for block in resp.content:
                    if block.type != "tool_use":
                        continue
                    try:
                        out = await dispatch_tool(block.name, block.input, db, tenant_id, period_end)
                    except Exception as exc:  # one tool failing shouldn't kill the answer
                        logger.exception("assistant tool %s failed", block.name)
                        try:
                            await db.rollback()  # un-poison the session for the next tool
                        except Exception:
                            pass
                        out = {"error": f"tool failed: {exc}"}
                    sources.append({"tool": block.name, "input": block.input})
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(out, default=str),
                    })
                messages.append({"role": "user", "content": results})
                continue

            # Final assistant turn (no more tools).
            text = "".join(getattr(b, "text", "") for b in resp.content if b.type == "text").strip()
            return {"answer": text or "I couldn't find an answer to that.", "sources": sources}

        return {
            "answer": "I wasn't able to finish that — try narrowing the question or naming a specific account or month.",
            "sources": sources,
        }
    finally:
        current_request_readonly.reset(ro_token)


def _title_from(question: str) -> str:
    t = " ".join((question or "").split())
    return (t[:80] + "…") if len(t) > 80 else (t or "New conversation")


async def persist_turn(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID | None,
    thread_id: uuid.UUID | None,
    question: str,
    answer: str,
    sources: list[dict] | None,
) -> uuid.UUID:
    """Save one Q&A turn into a thread (creating it if needed) and return the
    thread id. The caller commits. MUST run outside answer_question's read-only
    window (the loop sets current_request_readonly, which would block these
    writes). Tenant-scoped: thread/message rows carry tenant_id = the caller's."""
    thread = None
    if thread_id is not None:
        thread = (await db.execute(
            select(AssistantThread).where(AssistantThread.id == thread_id)
        )).scalar_one_or_none()
    if thread is None:
        thread = AssistantThread(
            id=uuid.uuid4(), tenant_id=tenant_id, created_by=user_id,
            title=_title_from(question),
        )
        db.add(thread)
        await db.flush()
    else:
        thread.updated_at = datetime.now(UTC)

    db.add(AssistantMessage(
        id=uuid.uuid4(), tenant_id=tenant_id, thread_id=thread.id,
        role="user", content=question,
    ))
    db.add(AssistantMessage(
        id=uuid.uuid4(), tenant_id=tenant_id, thread_id=thread.id,
        role="assistant", content=answer, sources=sources or None,
    ))
    return thread.id
