"""Read-only, tenant-scoped tools for the client assistant (Tier 3 Phase 0).

Every tool runs against the request's get_db session, so it is constrained to the
caller's tenant by the app-layer filter (Tier 1 — fail-closed) and, once cut over,
Postgres RLS (Tier 2). The assistant therefore CANNOT read another client's data,
and prompt-injection in client text can't escape: there is simply no tool that
reaches another tenant. All tools are read-only — the service also runs the whole
loop under a hard read-only DB guard.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.gl_balance_snapshot import GlBalanceSnapshot
from modules.close_workflow.service import linked_status
from modules.memory.service import account_memory_context
from modules.recons.overview import read_overview_from_snapshots

# Anthropic tool schemas — Phase 0 is read-only Q&A only (no write/post tools).
TOOL_DEFS: list[dict[str, Any]] = [
    {
        "name": "get_reconciliations_overview",
        "description": (
            "Reconciliation status for the period: every balance-sheet account "
            "with its GL balance, subledger balance, variance, and review status "
            "(pending/prepared/approved), plus totals and the trial-balance "
            "tie-out check. Use for 'what is unreconciled', account balances, "
            "variances, and whether the books tie out."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_end": {
                    "type": "string",
                    "description": "Period end date YYYY-MM-DD. Omit to use the active period.",
                }
            },
        },
    },
    {
        "name": "get_account_balance",
        "description": (
            "Look up the GL balance of one or more accounts for the period by "
            "account number or name (partial match). Use for 'what is the balance "
            "of <account>'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Account number or name fragment, e.g. '1200' or 'accounts receivable'.",
                },
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_close_status",
        "description": (
            "What is blocking the month-end close for the period: status "
            "(pending/in_progress/done) of each stage — QBO sync, reconciliations, "
            "flux analysis, schedules, and final close. Use for 'what is left to "
            "close' or 'can we close'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}
            },
        },
    },
    {
        "name": "get_account_guidance",
        "description": (
            "What the firm has TAUGHT Nordavix about an account — recurring "
            "expectations, conventions, recurring reconciling items (the client's "
            "'memory'). Use when asked what we know or expect for an account, or to "
            "explain whether this period lands as expected."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "account_number": {"type": "string", "description": "The account number, e.g. '6010'."},
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
            "required": ["account_number"],
        },
    },
]

# The stages get_close_status reports, in close order.
_CLOSE_STAGES = ("sync", "recon", "flux", "schedule", "close")


async def latest_synced_period(db: AsyncSession) -> date | None:
    """The most recent period that has a GL snapshot — the assistant's default
    context period when the caller doesn't specify one. Tenant-scoped via the
    session, like every other read here. Returns None if nothing is synced yet."""
    return (
        await db.execute(select(func.max(GlBalanceSnapshot.period_end)))
    ).scalar_one_or_none()


def _parse_period(value: Any, default_period: date | None) -> date | None:
    if isinstance(value, str) and value.strip():
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            pass
    return default_period


def _slim_overview(ov: dict) -> dict:
    """Trim the heavy recon-overview payload to the fields the model needs (drop
    evidence files, reviewer ids, AI commentary blobs)."""
    accounts = [
        {
            "account_number": a.get("account_number"),
            "account_name": a.get("account_name"),
            "group": a.get("group_label"),
            "gl_balance": a.get("gl_balance"),
            "subledger_balance": a.get("subledger_balance"),
            "variance": a.get("variance"),
            "review_status": a.get("review_status"),
        }
        for a in ov.get("accounts", [])
    ]
    return {
        "period_end": ov.get("period_end"),
        "synced": ov.get("synced", False),
        "accounts": accounts,
        "totals": ov.get("totals"),
        "tb_check": ov.get("tb_check"),
    }


async def dispatch_tool(
    name: str,
    tool_input: dict | None,
    db: AsyncSession,
    tenant_id: uuid.UUID,  # noqa: ARG001 — scoping is enforced by the session, not this arg
    default_period: date | None,
) -> dict:
    """Execute one tool call and return a JSON-serializable result.

    The session is already tenant-scoped (get_db + middleware context), which is
    what actually enforces isolation — tenant_id is accepted only for clarity.
    """
    ti = tool_input or {}
    pe = _parse_period(ti.get("period_end"), default_period)
    if pe is None:
        return {"error": "No period specified and no active period is set. Ask the user which month (YYYY-MM-DD)."}

    if name == "get_reconciliations_overview":
        return _slim_overview(await read_overview_from_snapshots(db, pe))

    if name == "get_account_balance":
        q = (ti.get("query") or "").strip()
        if not q:
            return {"error": "query is required."}
        like = f"%{q}%"
        rows = (await db.execute(
            select(GlBalanceSnapshot).where(
                GlBalanceSnapshot.period_end == pe,
                (GlBalanceSnapshot.account_number.ilike(like))
                | (GlBalanceSnapshot.account_name.ilike(like))
                | (GlBalanceSnapshot.qbo_account_id == q),
            )
        )).scalars().all()
        return {
            "period_end": pe.isoformat(),
            "matches": [
                {
                    "account_number": r.account_number,
                    "account_name": r.account_name,
                    "account_type": r.account_type,
                    "balance": str(r.balance),
                }
                for r in rows[:25]
            ],
        }

    if name == "get_close_status":
        stages = {}
        for module in _CLOSE_STAGES:
            status, done_at = await linked_status(db, module, pe)
            stages[module] = {
                "status": status,
                "completed_at": done_at.isoformat() if done_at else None,
            }
        return {"period_end": pe.isoformat(), "stages": stages}

    if name == "get_account_guidance":
        acct = (ti.get("account_number") or "").strip()
        if not acct:
            return {"error": "account_number is required."}
        notes = await account_memory_context(db, account_number=acct, period_end=pe)
        return {
            "account_number": acct,
            "period_end": pe.isoformat(),
            "guidance": [
                {"kind": n.get("kind"), "text": n.get("text"), "match": n.get("match")}
                for n in notes
            ],
        }

    return {"error": f"Unknown tool: {name}"}
