"""
AI usage recording — per-tenant token + cost tracking, written to AIUsage.

The recording problem: every Anthropic call goes through the one sync choke
point core.ai.client.generate_narrative(), but that function has no DB session
and no tenant_id, and it's called from a mix of sync helpers (recons) and async
tasks (flux). Threading a session + tenant through every leaf call site would be
invasive and easy to get wrong.

Instead we use a request-scoped ContextVar buffer:
  * begin_capture() installs a fresh list on the current context.
  * generate_narrative() calls record_call() which APPENDS to that list.
  * after the work, flush_usage() drains the list into AIUsage rows.

Why append-only works across the sync/async boundary: when FastAPI runs a sync
endpoint in a threadpool it copies the context, but the copied ContextVar still
points to the SAME list object — so .append() from a sync helper is visible to
the async caller afterward. (Reassigning the var would NOT propagate; we only
ever mutate.) This is the same mechanism that lets current_tenant_id work inside
the sync recon helpers.

Wiring:
  * TenantMiddleware calls begin_capture() before the handler and flush_usage()
    after — covers all inline AI (recons agentic, run-AI, exec report, deep
    agentic).
  * The flux narrative BACKGROUND task runs after the response (outside the
    request context), so it calls begin_capture()/flush_usage() itself.
"""
import logging
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from decimal import Decimal

from core.db.base import current_tenant_id
from core.db.session import AsyncSessionLocal
from models.ai_usage import AIUsage

logger = logging.getLogger(__name__)


@dataclass
class _UsageRecord:
    model: str
    input_tokens: int
    output_tokens: int
    cost: Decimal
    operation: str | None


# None = no active capture (calls are silently not recorded). A list = capturing.
_usage_buffer: ContextVar[list[_UsageRecord] | None] = ContextVar("ai_usage_buffer", default=None)


def begin_capture() -> None:
    """Start a fresh usage capture on the current context."""
    _usage_buffer.set([])


def reset_capture() -> None:
    """Clear the capture (used after flush so nothing leaks forward)."""
    _usage_buffer.set(None)


def record_call(
    *,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost: float | Decimal,
    operation: str | None = None,
) -> None:
    """Append one Anthropic call's usage to the active buffer. No-op when no
    capture is active. Never raises — usage tracking must not break AI calls."""
    try:
        buf = _usage_buffer.get()
        if buf is None:
            return
        buf.append(_UsageRecord(
            model=model,
            input_tokens=int(input_tokens or 0),
            output_tokens=int(output_tokens or 0),
            cost=Decimal(str(cost or 0)),
            operation=(operation or None),
        ))
    except Exception:
        logger.debug("record_call failed (ignored)", exc_info=True)


# Anthropic pricing per million tokens (mirror of core.ai.client's constants —
# keep in sync). Used to estimate cost for call sites that hit the Anthropic
# client directly instead of going through generate_narrative().
_COST_PER_MILLION_INPUT = 3.00
_COST_PER_MILLION_OUTPUT = 15.00


def record_response(response: object, *, operation: str | None = None, model: str | None = None) -> None:
    """
    Record usage from a raw Anthropic Messages response. For the several call
    sites that construct anthropic.Anthropic() and call messages.create()
    directly rather than going through generate_narrative(). No-op unless a
    capture is active; never raises.
    """
    try:
        from core.config import settings
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        it = int(getattr(usage, "input_tokens", 0) or 0)
        ot = int(getattr(usage, "output_tokens", 0) or 0)
        cost = it / 1_000_000 * _COST_PER_MILLION_INPUT + ot / 1_000_000 * _COST_PER_MILLION_OUTPUT
        record_call(
            model=model or settings.anthropic_model,
            input_tokens=it,
            output_tokens=ot,
            cost=cost,
            operation=operation,
        )
    except Exception:
        logger.debug("record_response failed (ignored)", exc_info=True)


async def flush_usage(tenant_id: uuid.UUID | None = None) -> int:
    """
    Drain the buffer into AIUsage rows in one transaction. Best-effort: a write
    failure is logged but never propagated (a usage-tracking error must not turn
    a successful AI response into a 500). Returns the number of rows written.
    """
    buf = _usage_buffer.get()
    if not buf:
        return 0
    records = list(buf)
    buf.clear()  # mutate in place so the cleared state is visible everywhere

    tid = tenant_id or current_tenant_id.get()
    if tid is None:
        logger.warning("AI usage flush skipped: no tenant_id in context (%d records dropped).", len(records))
        return 0

    try:
        async with AsyncSessionLocal() as session:
            for r in records:
                session.add(AIUsage(
                    id=uuid.uuid4(),
                    tenant_id=tid,
                    model=r.model,
                    input_tokens=r.input_tokens,
                    output_tokens=r.output_tokens,
                    cost_usd_estimate=r.cost,
                    operation=r.operation,
                ))
            await session.commit()
        return len(records)
    except Exception:
        logger.exception("Failed to flush %d AI usage record(s) for tenant %s", len(records), tid)
        return 0
