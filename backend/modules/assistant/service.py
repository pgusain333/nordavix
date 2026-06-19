"""Client assistant — grounded, tenant-scoped tool-calling Q&A (Tier 3).

Runs Claude in a tool-use loop with the read-only tools in tools.py. The whole
loop executes under a HARD read-only DB guard (current_request_readonly), so even
if a reused service function tried to write, it would raise rather than mutate —
the assistant can only ever READ this client's data. Usage is recorded per turn
via the same per-tenant AIUsage capture the rest of the app uses.

Performance (why this is fast + cheap):
  - Streaming: answer_question_stream yields tokens as they arrive, so the UI
    shows the answer in ~1-2s instead of after the whole loop.
  - Prompt caching: the (large) static system prompt and the tool schemas are
    marked cache_control=ephemeral, so across the turns of one question AND
    across questions (5-min TTL) they're read from cache, not re-billed.
  - Model: settings.assistant_model (Haiku by default) — a high-volume,
    latency-sensitive surface doesn't need the flux/recon narrative model.
  - Period injection: the active period is handed to the model up front, so
    simple questions resolve in ONE turn (often zero tool calls) and it never
    wastes a round-trip asking "which month?".
"""
from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
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

# Approx Haiku 4.5 rates (USD per token) — for the per-tenant cost estimate only.
# Cache reads are ~0.1x input; cache writes ~1.25x input.
_IN = 0.80 / 1_000_000
_OUT = 4.00 / 1_000_000
_CACHE_READ = 0.08 / 1_000_000
_CACHE_WRITE = 1.00 / 1_000_000

_MAX_TURNS = 6          # tool round-trips before we force a final answer
_MAX_TOKENS = 1024
_MAX_HISTORY = 8        # prior turns carried for context

# Chatty, first-person progress narration shown live while the copilot works
# (e.g. "Let me check reconciliations…", "Now let me look at flux…"). Read tools
# get a noun; action tools get their own verb phrase. The connective varies by
# position so a multi-tool answer reads naturally instead of repeating itself.
_STEP_NOUN: dict[str, str] = {
    "get_reconciliations_overview": "reconciliations",
    "get_account_balance": "the account balance",
    "get_close_status": "close status",
    "get_adjustments_queue": "the adjustments",
    "get_financial_insights": "your financial health",
    "get_flux_variances": "flux",
    "get_schedules": "the schedules",
    "get_risk_findings": "the risk radar",
    "get_close_tasks": "the close checklist",
    "get_financial_statements": "the financial statements",
    "get_intercompany": "intercompany",
    "get_team": "the team",
    "get_account_guidance": "what you taught us about this account",
    "recall": "past records",
}
_STEP_VERB: dict[str, str] = {
    "draft_journal_entry": "Drafting the entry",
    "suggest_action": "Setting up the prepare step",
    "make_chart": "Putting together a chart",
    "suggest_link": "Finding the right screen",
}
_STEP_CONNECTORS = ("Now let me look at", "Now checking", "Then", "And")


def _step_phrase(tool: str, idx: int) -> str:
    """A chatty progress line for the tool that just started. `idx` is how many
    steps have already been shown, so the opener varies ("Let me check …" first,
    then "Now let me look at …", "Then …") instead of repeating."""
    if tool in _STEP_VERB:
        return _STEP_VERB[tool] + "…"
    noun = _STEP_NOUN.get(tool, "the data")
    if idx == 0:
        return f"Let me check {noun}…"
    return f"{_STEP_CONNECTORS[idx % len(_STEP_CONNECTORS)]} {noun}…"

# Static system prompt — identical every turn and across questions, so it is the
# cached prefix (cache_control below). Dynamic context (the active period) is a
# separate, tiny, uncached block appended after it.
_SYSTEM_STATIC = (
    "You are NDVX Copilot, Nordavix's month-end-close assistant for ONE accounting "
    "client — the workspace you are called in. You answer from this client's REAL, "
    "synced data via your tools.\n\n"
    "GROUNDING (non-negotiable):\n"
    "- Answer ONLY from what your tools return. Never invent or estimate a number, "
    "balance, or status.\n"
    "- When you state a figure, attribute it (account name/number + period).\n"
    "- If a tool returns no data (e.g. the month isn't synced), say so plainly and "
    "suggest the next step (e.g. \"run Sync for that month\").\n"
    "- Money is USD. Show variances with their sign and flag anything that doesn't "
    "tie out.\n\n"
    "TOOL ROUTING — pick the smallest set of tools that answers the question, then "
    "answer. You CAN call several tools (even in one turn) for a broad question:\n"
    "- account balance → get_account_balance\n"
    "- reconciliations: what's unreconciled, GL-vs-subledger variance, does it tie "
    "out → get_reconciliations_overview\n"
    "- flux: what moved vs the prior period, biggest changes → get_flux_variances\n"
    "- schedules: prepaids / accruals / depreciation / leases / loans this month → "
    "get_schedules\n"
    "- what's in the Adjustments queue / proposed entries / what's left to approve → "
    "get_adjustments_queue\n"
    "- risk / likely errors / misclassifications / anything to review → "
    "get_risk_findings\n"
    "- what's left to do / my tasks / close checklist / are we on track → "
    "get_close_tasks\n"
    "- specific statement figures (net income, total assets, revenue) → "
    "get_financial_statements\n"
    "- financial health / business outlook / cash / runway / margins / growth → "
    "get_financial_insights\n"
    "- intercompany / related-party accounts → get_intercompany\n"
    "- who's on the team / reviewers / who can approve / who is <name> → get_team\n"
    "- what's blocking / can we close → get_close_status\n"
    "- what we know or expect for an account → get_account_guidance\n"
    "- how we explained or handled X before → recall\n"
    "- book / record / reclassify / accrue → draft_journal_entry (creates a DRAFT "
    "for a human to approve + post; you NEVER post to QuickBooks and NEVER approve)\n"
    "- prepare / run / start the reconciliations or flux for the period → "
    "suggest_action (offers a one-click PREPARE button; it only prepares — a human "
    "still approves, nothing posts to QuickBooks). For reconciliations, pass "
    "`account` to prepare just one, or omit it for all; tell the user they can pick "
    "a specific account or do all.\n"
    "- point the user to a screen → suggest_link\n"
    "Use the active period below unless the user names another month; don't ask "
    "which month when an active period is set.\n\n"
    "BE A PROACTIVE CLOSE COPILOT:\n"
    "- ALWAYS give an answer. If a tool returns no data, say what's missing and the "
    "next step — never reply that you couldn't finish.\n"
    "- For broad questions (\"how's the close going\", \"what should I do\"), gather "
    "from the relevant tools (close tasks + reconciliations + flux + risk + "
    "adjustments) and synthesize ONE clear picture.\n"
    "- Lead with the direct answer, then when it helps add a short, prioritized plan "
    "or next steps (a few numbered items) and practical suggestions for doing it "
    "efficiently, and offer the relevant screen with suggest_link.\n"
    "- When listing a queue / checklist / findings, show a few inline and link to "
    "the full screen — don't just send the user away.\n"
    "- ALWAYS answer in words. When you offer an action button (suggest_action), a "
    "chart (make_chart), or a link (suggest_link), still write a one-sentence answer "
    "— the button/chart is never a substitute for answering.\n"
    "- Visualize genuinely chartable numbers with make_chart (a breakdown → pie, a "
    "comparison across items → bar, a trend over periods → line), in addition to the "
    "text — never invent numbers, only chart what your tools returned.\n"
    "- If the user asks you to CREATE / EXPORT / DOWNLOAD a PDF or an Excel / "
    "spreadsheet, never refuse: gather the data and lay it out as a clean Markdown "
    "table (real columns/rows — that table becomes the downloadable file), then add "
    "one line telling them to use the Download button below. If some data is missing, "
    "export what you have and note the gap.\n\n"
    "STYLE:\n"
    "- Do NOT narrate your actions (no \"let me check…\"). Either call a tool with no "
    "accompanying text, or write the final answer.\n"
    "- Lead with the direct answer in one sentence, then short bullet or numbered "
    "lists.\n"
    "- Use a compact Markdown table ONLY for genuinely tabular data (2-3 columns, "
    "e.g. a status breakdown).\n"
    "- Be concise and practical for a CPA. No walls of text, no raw data dumps. Bold "
    "key terms sparingly.\n"
    "- If you're unsure which account a draft entry should hit, ask before drafting."
)


def _system_blocks(period_end: date | None) -> list[dict]:
    """System as cache-friendly blocks: a big cached static block + a tiny dynamic
    one carrying the active period (kept out of the cached prefix so it can change
    day-to-day without busting the cache)."""
    pe = period_end.isoformat() if period_end else "none synced yet"
    return [
        {"type": "text", "text": _SYSTEM_STATIC, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": f"Active period for this workspace: {pe}. Use it unless the user names another month."},
    ]


def _cached_tools() -> list[dict]:
    """Tool schemas with a cache breakpoint on the last one, so the whole tool
    block is served from cache after the first call."""
    tools = [dict(t) for t in TOOL_DEFS]
    tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
    return tools


def _block_to_dict(block: Any) -> dict:
    if block.type == "text":
        return {"type": "text", "text": block.text}
    if block.type == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    return {"type": block.type}


def _record(resp: Any) -> None:
    try:
        u = resp.usage
        cache_read = getattr(u, "cache_read_input_tokens", 0) or 0
        cache_write = getattr(u, "cache_creation_input_tokens", 0) or 0
        cost = (
            u.input_tokens * _IN
            + u.output_tokens * _OUT
            + cache_read * _CACHE_READ
            + cache_write * _CACHE_WRITE
        )
        record_call(
            model=settings.assistant_model,
            input_tokens=u.input_tokens + cache_read + cache_write,
            output_tokens=u.output_tokens,
            cost=cost,
            operation="assistant",
        )
    except Exception:  # pragma: no cover — usage tracking must never break a turn
        pass


def _history_messages(history: list[dict] | None) -> list[dict]:
    out: list[dict] = []
    for h in (history or [])[-_MAX_HISTORY:]:
        role, content = h.get("role"), h.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content})
    return out


async def answer_question_stream(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    question: str,
    period_end: date | None = None,
    history: list[dict] | None = None,
) -> AsyncIterator[dict]:
    """Run the grounded tool-use loop, STREAMING events as they happen.

    Yields dict events:
      {"type": "step",   "label": str}                      a tool started (status line)
      {"type": "delta",  "text": str}                       a chunk of the answer
      {"type": "reset"}                                     clear partial text (a tool turn
                                                            had preamble; the real answer follows)
      {"type": "result", "answer", "sources", "drafts", "links"}   terminal payload

    The entire loop runs under the hard read-only guard. The caller persists the
    turn AFTER fully consuming this generator (the guard is reset in `finally`,
    which runs as the generator is exhausted, before the caller's writes).
    """
    messages: list[dict] = _history_messages(history)
    messages.append({"role": "user", "content": question})

    sources: list[dict] = []
    drafts: list[dict] = []
    links: list[dict] = []
    actions: list[dict] = []
    charts: list[dict] = []
    final_answer: str | None = None

    ro_token = current_request_readonly.set(True)
    try:
        if period_end is None:
            period_end = await latest_synced_period(db)
        system = _system_blocks(period_end)
        tools = _cached_tools()
        step_no = 0  # how many progress lines shown so far — drives the wording

        for _turn in range(_MAX_TURNS):
            turn_text: list[str] = []
            async with _aclient.messages.stream(
                model=settings.assistant_model,
                max_tokens=_MAX_TOKENS,
                system=system,
                tools=tools,
                messages=messages,
            ) as stream:
                async for event in stream:
                    et = getattr(event, "type", "")
                    if et == "content_block_start" and getattr(event.content_block, "type", None) == "tool_use":
                        yield {"type": "step", "label": _step_phrase(event.content_block.name, step_no)}
                        step_no += 1
                    elif et == "content_block_delta" and getattr(event.delta, "type", None) == "text_delta":
                        # Buffer text; do NOT stream it yet. If this turn ends up
                        # calling a tool, that text was just preamble and is dropped
                        # (no flicker) — only the final turn's text is ever shown.
                        turn_text.append(event.delta.text)
                final = await stream.get_final_message()
            _record(final)

            if final.stop_reason == "tool_use":
                messages.append({"role": "assistant", "content": [_block_to_dict(b) for b in final.content]})
                results: list[dict] = []
                for block in final.content:
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
                    if isinstance(out, dict) and out.get("ok"):
                        if block.name == "draft_journal_entry" and out.get("draft"):
                            drafts.append(out["draft"])
                        elif block.name == "suggest_link" and out.get("link"):
                            links.append(out["link"])
                        elif block.name == "suggest_action" and out.get("action"):
                            actions.append(out["action"])
                        elif block.name == "make_chart" and out.get("chart"):
                            charts.append(out["chart"])
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(out, default=str),
                    })
                messages.append({"role": "user", "content": results})
                # Any text this turn was just preamble — it was never streamed, so
                # there's nothing to undo. The next turn produces the real answer.
                continue

            # Final turn (no more tools): the buffered text IS the answer — reveal
            # it now, in one clean piece after the progress lines (no mid-stream switch).
            final_answer = "".join(turn_text).strip()
            if final_answer:
                yield {"type": "delta", "text": final_answer}
            break

        # If the loop ran out of turns still calling tools, force a closing answer
        # with NO tools so the model MUST synthesize from everything it gathered —
        # never punt with "I couldn't finish".
        if final_answer is None:
            try:
                turn_text = []
                async with _aclient.messages.stream(
                    model=settings.assistant_model,
                    max_tokens=_MAX_TOKENS,
                    system=system,
                    messages=messages,
                ) as stream:
                    async for event in stream:
                        if (
                            getattr(event, "type", "") == "content_block_delta"
                            and getattr(event.delta, "type", None) == "text_delta"
                        ):
                            turn_text.append(event.delta.text)
                            yield {"type": "delta", "text": event.delta.text}
                    final = await stream.get_final_message()
                _record(final)
                final_answer = "".join(turn_text).strip()
            except Exception:  # pragma: no cover — last-resort synthesis must not crash the turn
                logger.exception("assistant forced-synthesis failed")

        if not final_answer:
            if actions:
                final_answer = (
                    "Here's a one-click action for that — it only prepares (you approve "
                    "after). Check the details below and click Run when you're ready."
                )
            elif links:
                final_answer = "Here you go — use the button below to jump to the right screen."
            else:
                final_answer = (
                    "Here's what I found so far — point me at a specific account, month, "
                    "or module and I'll go deeper."
                )
        answer = final_answer
        yield {
            "type": "result",
            "answer": answer,
            "sources": sources,
            "drafts": drafts,
            "links": links,
            "actions": actions,
            "charts": charts,
        }
    finally:
        current_request_readonly.reset(ro_token)


async def answer_question(
    *,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    question: str,
    period_end: date | None = None,
    history: list[dict] | None = None,
) -> dict:
    """Non-streaming convenience wrapper (drains the stream into one dict). Kept for
    the JSON /ask endpoint and any caller that wants the whole answer at once."""
    answer = ""
    sources: list[dict] = []
    drafts: list[dict] = []
    links: list[dict] = []
    actions: list[dict] = []
    charts: list[dict] = []
    async for ev in answer_question_stream(
        db=db, tenant_id=tenant_id, question=question, period_end=period_end, history=history,
    ):
        if ev.get("type") == "result":
            answer = ev["answer"]
            sources = ev["sources"]
            drafts = ev["drafts"]
            links = ev["links"]
            actions = ev.get("actions", [])
            charts = ev.get("charts", [])
    return {
        "answer": answer or "I couldn't find an answer to that.",
        "sources": sources,
        "drafts": drafts,
        "links": links,
        "actions": actions,
        "charts": charts,
    }


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
