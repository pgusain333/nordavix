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

from models.account import Account
from models.account_review_status import AccountReviewStatus
from models.gl_balance_snapshot import GlBalanceSnapshot
from models.insights_snapshot import InsightsSnapshot
from models.narrative import Narrative
from models.proposed_entry import ProposedEntry
from models.trial_balance import TrialBalance
from models.variance import Variance
from modules.adjustments.service import parse_ai_entries, period_accounts
from modules.assistant.people import name_map, workspace_members
from modules.close_workflow.service import build_checklist, linked_status
from modules.memory.service import account_memory_context
from modules.recons.overview import read_overview_from_snapshots

# Screens the assistant can deep-link the user to (target -> path, default label).
_LINK_TARGETS: dict[str, tuple[str, str]] = {
    "dashboard": ("/app", "Dashboard"),
    "reconciliations": ("/app/reconciliations", "Reconciliations"),
    "flux": ("/app/flux", "Flux Analysis"),
    "schedules": ("/app/schedules", "Schedules"),
    "adjustments": ("/app/adjustments", "Adjustments"),
    "close": ("/app/close", "Close Workflow"),
    "risk": ("/app/gl-accuracy", "Risk Radar"),
    "insights": ("/app/insights", "Insights"),
    "financials": ("/app/financials", "Financial Statements"),
}

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
    {
        "name": "get_related",
        "description": (
            "The full story behind ONE account this period, assembled in a single "
            "call: its balance and type, its reconciliation status and GL-vs-"
            "subledger variance, the schedule that backs it, the risk findings "
            "raised on it, and its knowledge-graph connections (entries that explain "
            "or affect it), grouped by relationship. THE tool for 'what's the story "
            "behind <account>', 'what's connected to <account>', 'why is <account> "
            "flagged', 'what relates to this reconciliation'. After calling it, "
            "NARRATE the story in words — never just send the user to a screen."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {
                    "type": "string",
                    "description": "Account number or name fragment, e.g. '1400' or 'prepaid'.",
                },
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
            "required": ["account"],
        },
    },
    {
        "name": "recall",
        "description": (
            "Search this client's PAST records — prior flux narratives (variance "
            "explanations) and reconciliation notes — by topic/keywords, ACROSS all "
            "periods. Use to remember how something was explained or handled before "
            "(e.g. 'why does rent spike in March', 'how did we treat the insurance "
            "prepaid'). Returns matching snippets with their account and period."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Topic or keywords to recall, e.g. 'rent variance' or 'insurance prepaid'.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_adjustments_queue",
        "description": (
            "List the adjusting journal entries already in the Adjustments queue "
            "for the period — proposed by reconciliations, flux, the bank match, or "
            "the assistant — with each one's status (open/accepted/posted/dismissed), "
            "source, dollar amount, and confidence. Use for 'what's in adjustments', "
            "'what entries are pending', 'how many adjustments', 'what's left to "
            "approve'. Returns status counts plus the entries themselves (newest "
            "first); show a few and point to the Adjustments screen for the full list."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "description": "Optional filter: open | accepted | posted | dismissed.",
                },
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
        },
    },
    {
        "name": "get_financial_insights",
        "description": (
            "The client's financial health and business outlook for the period: a "
            "management summary (headline, health rating, 0-100 score, strengths, "
            "watch items, priorities) plus key metrics — cash balance, runway, "
            "operating burn, current/quick ratio, gross & net margin, revenue — and "
            "the top recommendations. Use for 'how are we doing', 'business outlook', "
            "'are we healthy', 'what's our runway/cash', 'profitability', 'is the "
            "business growing'. Reads the saved Insights snapshot (no live pull); if "
            "none exists yet, say so and suggest opening Insights and clicking Sync."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
        },
    },
    {
        "name": "get_flux_variances",
        "description": (
            "Flux analysis for the period — the account balances that moved vs the "
            "prior period, with the dollar and % change, which are material, their "
            "review status, and whether an explanation has been written. Use for "
            "'what moved this month', 'biggest variances', 'flux', 'what changed vs "
            "last month', 'is the flux done'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
                "material_only": {"type": "boolean", "description": "Only material variances (default true)."},
            },
        },
    },
    {
        "name": "get_schedules",
        "description": (
            "Amortization & roll-forward schedules for the period — prepaids, "
            "accruals, fixed assets (depreciation), leases, and loans: how many are "
            "committed and the total expense and ending balance hitting this month "
            "per type. Use for 'what's amortizing', 'prepaid/depreciation/accrual "
            "this month', 'schedules', 'recurring entries'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_risk_findings",
        "description": (
            "Risk Radar / GL-accuracy findings for the period — likely "
            "misclassifications, duplicates, round-dollar entries, missing recurring "
            "items, large entries with no memo, etc., each with severity and a "
            "suggested fix. Use for 'any errors', 'what looks wrong', 'coding "
            "mistakes', 'risks', 'anything to review', 'second set of eyes'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_close_tasks",
        "description": (
            "The month-end close checklist for the period — every step (sync, "
            "reconciliations, flux, schedules, adjustments, and manual tasks) with "
            "its status, assignee, due date, and progress. Use for 'what's left to "
            "do', 'my tasks', 'close checklist', 'what should I do next', 'are we on "
            "track', and to build a step-by-step plan to finish the close."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_financial_statements",
        "description": (
            "The internal financial statements for the period, built from synced GL "
            "data — Income Statement (revenue, gross profit, operating & net income) "
            "and Balance Sheet (assets, liabilities, equity) line items. Use for "
            "specific statement figures: 'what's net income', 'total assets', "
            "'revenue this period', 'show the P&L / balance sheet'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_intercompany",
        "description": (
            "Intercompany setup for this workspace — the accounts marked "
            "intercompany and the configured counterparty pairs, with this entity's "
            "balance on each for the period. Use for 'intercompany', 'related-party "
            "balances', 'IC accounts', 'who are we paired with'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_team",
        "description": (
            "Who is on this workspace's team — every member with their name, role "
            "(admin / reviewer / preparer), email, and whether they're active. Use "
            "for 'who's on our team', 'who are the reviewers', 'who can approve', or "
            "'who is <name>'. These names also identify task assignees and "
            "preparers/approvers elsewhere in the close."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "draft_journal_entry",
        "description": (
            "Draft a balanced adjusting journal entry from the user's request "
            "(e.g. 'book the $1,200 annual insurance to prepaid'). Creates a DRAFT "
            "only — it goes to the Adjustments queue for a human to review, approve, "
            "and post to QuickBooks. You NEVER post and NEVER approve. Provide 2+ "
            "lines that balance (total debits == total credits), referencing real "
            "accounts by account_number (preferred) and/or account_name. If you're "
            "unsure of the correct account, ask the user before drafting."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "What the entry records, e.g. 'Reclassify annual insurance premium to prepaid'.",
                },
                "lines": {
                    "type": "array",
                    "description": "Two or more JE lines whose debits and credits balance.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "account_number": {"type": "string"},
                            "account_name": {"type": "string"},
                            "debit": {"type": "string", "description": "e.g. '1200.00'; omit/'0' on a credit line."},
                            "credit": {"type": "string", "description": "e.g. '1200.00'; omit/'0' on a debit line."},
                        },
                    },
                },
                "memo": {"type": "string"},
                "rationale": {"type": "string", "description": "Short why."},
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
            "required": ["description", "lines"],
        },
    },
    {
        "name": "suggest_link",
        "description": (
            "Offer the user a button to jump to a relevant screen. Use when pointing "
            "them where to act — e.g. after drafting an entry link to 'adjustments', "
            "or to review a reconciliation link to 'reconciliations'. Valid targets: "
            "dashboard, reconciliations, flux, schedules, adjustments, close, risk, "
            "insights, financials."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "One of the valid targets."},
                "label": {"type": "string", "description": "Optional button label; defaults to the section name."},
            },
            "required": ["target"],
        },
    },
    {
        "name": "suggest_action",
        "description": (
            "Offer a one-click button to PREPARE work (propose-only): run the AI "
            "preparer on the period's reconciliations or flux. Use when the user "
            "asks to prepare / run / start the reconciliations or flux (e.g. "
            "\"prepare April's reconciliations\", \"run the flux for March\"). This "
            "OFFERS a confirm button the user clicks to run it — it only PREPARES "
            "(drafts commentary + proposed entries); a human still approves and "
            "nothing posts to QuickBooks. Do NOT claim you already ran it; you're "
            "offering the button."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "description": "prepare_reconciliations | prepare_flux"},
                "account": {"type": "string", "description": "Reconciliations only — a specific account (number or name) to prepare just that one; omit to prepare ALL accounts."},
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
            "required": ["kind"],
        },
    },
    {
        "name": "make_chart",
        "description": (
            "Render a chart UNDER your answer when a set of numbers is genuinely "
            "visual — a breakdown (pie), a comparison across items (bar), or a trend "
            "over periods (line). Pass numbers you already got from other tools; "
            "never invent data. Use sparingly, and ALWAYS alongside a text answer."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "description": "bar | pie | line"},
                "title": {"type": "string"},
                "unit": {"type": "string", "description": "Optional, e.g. '$' or '%'."},
                "data": {
                    "type": "array",
                    "description": "Points to plot.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "value": {"type": "number"},
                        },
                        "required": ["label", "value"],
                    },
                },
            },
            "required": ["type", "data"],
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

    # Workspace-level (period-independent) — handle before the period guard.
    if name == "get_team":
        members = await workspace_members(db, tenant_id)
        return {"members": members, "count": len(members)}

    if name == "make_chart":
        ctype = (ti.get("type") or "").strip().lower()
        if ctype not in ("bar", "pie", "line"):
            return {"ok": False, "error": "type must be bar | pie | line."}
        points: list[dict] = []
        for d in (ti.get("data") or []):
            if not isinstance(d, dict):
                continue
            try:
                points.append({"label": str(d.get("label") or ""), "value": float(d.get("value"))})
            except (TypeError, ValueError):
                continue
        if not points:
            return {"ok": False, "error": "data must be a non-empty list of {label, value}."}
        return {"ok": True, "chart": {
            "type": ctype,
            "title": (ti.get("title") or "").strip(),
            "unit": (ti.get("unit") or "").strip(),
            "data": points[:24],
        }}

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

    if name == "get_related":
        q = (ti.get("account") or "").strip()
        if not q:
            return {"error": "account is required."}
        like = f"%{q}%"
        row = (await db.execute(
            select(GlBalanceSnapshot).where(
                GlBalanceSnapshot.period_end == pe,
                (GlBalanceSnapshot.account_number.ilike(like))
                | (GlBalanceSnapshot.account_name.ilike(like))
                | (GlBalanceSnapshot.qbo_account_id == q),
            ).limit(1)
        )).scalars().first()
        if row is None:
            return {"ok": False, "period_end": pe.isoformat(),
                    "note": f"No account matching '{q}' for {pe.isoformat()}."}

        qid = row.qbo_account_id
        acct_label = f"{row.account_number or ''} {row.account_name or ''}".strip()

        # Traverse the knowledge graph: the account's own edges (findings on it,
        # JEs affecting it) PLUS its reconciliation's edges (the schedule that
        # supports it, JEs explaining it). Read-only; resolved to real names.
        from core.graph import RELATIONS, Node, neighbors
        from core.graph.resolve import resolve_nodes

        seeds = [Node("account", qid), Node("reconciliation", f"{qid}:{pe.isoformat()}")]
        seen: set[tuple[str, str, str]] = set()
        nbrs = []
        for sn in seeds:
            for nb in await neighbors(db, sn):
                k = (nb.node.type, nb.node.id, nb.relation)
                if k in seen:
                    continue
                seen.add(k)
                nbrs.append(nb)
        views = await resolve_nodes(db, [nb.node for nb in nbrs])
        grouped: dict[str, list[dict]] = {}
        for nb in nbrs:
            v = views.get((nb.node.type, nb.node.id))
            if v is None:
                continue
            grouped.setdefault(nb.relation, []).append(
                {"type": v.type, "name": v.label, "status": v.status}
            )
        connections = [
            {"relationship": RELATIONS[r].label if r in RELATIONS else r.replace("_", " "), "items": items}
            for r, items in grouped.items()
        ]

        # Graph edges are a bonus index; the STORY must be substantive even when
        # the graph is sparse (e.g. not yet backfilled). Pull the account's real
        # context straight from the source tables too. Each read is guarded so one
        # failure can't blank the whole answer.
        reconciliation = None
        try:
            ov = await read_overview_from_snapshots(db, pe)
            for a in ov.get("accounts", []):
                if (a.get("qbo_account_id") == qid
                        or (row.account_number and a.get("account_number") == row.account_number)
                        or (a.get("account_name") and a.get("account_name") == row.account_name)):
                    reconciliation = {
                        "review_status": a.get("review_status"),
                        "gl_balance": a.get("gl_balance"),
                        "subledger_balance": a.get("subledger_balance"),
                        "variance": a.get("variance"),
                    }
                    break
        except Exception:
            pass

        schedules: list[dict] = []
        try:
            from models.schedule import ScheduleSnapshot
            srows = (await db.execute(
                select(ScheduleSnapshot).where(
                    ScheduleSnapshot.period_end == pe,
                    ScheduleSnapshot.qbo_account_id == qid,
                    ScheduleSnapshot.status == "committed",
                )
            )).scalars().all()
            schedules = [
                {"type": s.schedule_type, "items": s.item_count, "ending_balance": str(s.ending_balance)}
                for s in srows
            ]
        except Exception:
            pass

        findings: list[dict] = []
        try:
            from modules.gl_accuracy.service import list_findings
            data = await list_findings(db, pe)
            for it in (data.get("items") or []):
                if it.get("posted_account_id") == qid or it.get("suggested_account_id") == qid:
                    findings.append({"title": it.get("title"), "severity": it.get("severity"),
                                     "status": it.get("status"), "kind": it.get("kind")})
            findings = findings[:8]
        except Exception:
            pass

        total = (sum(len(c["items"]) for c in connections) + len(schedules) + len(findings)
                 + (1 if reconciliation else 0))
        return {
            "account": acct_label,
            "account_id": qid,
            "period_end": pe.isoformat(),
            "context": {
                "balance": str(row.balance),
                "account_type": row.account_type,
                "reconciliation": reconciliation,
                "schedules": schedules,
                "risk_findings": findings,
            },
            "connections": connections,
            "total": total,
            "note": (None if total else
                     "No reconciliation, schedule, findings, or recorded connections for this "
                     "account this period — it may be inactive or not yet synced."),
        }

    if name == "recall":
        q = (ti.get("query") or "").strip()
        if not q:
            return {"error": "query is required."}
        tsq = func.plainto_tsquery("english", q)
        results: list[dict] = []

        # 1) Past flux narratives (variance explanations) — joined to account + period.
        ndoc = func.to_tsvector("english", Narrative.content)
        nrows = (await db.execute(
            select(
                Narrative.content,
                Account.account_number,
                Account.account_name,
                TrialBalance.period_current,
                Narrative.generated_at,
            )
            .join(Variance, Variance.id == Narrative.variance_id)
            .join(Account, Account.id == Variance.account_id)
            .join(TrialBalance, TrialBalance.id == Account.trial_balance_id)
            .where(ndoc.op("@@")(tsq))
            .order_by(func.ts_rank(ndoc, tsq).desc())
            .limit(6)
        )).all()
        for r in nrows:
            results.append({
                "source": "flux narrative",
                "account": f"{r.account_number or ''} {r.account_name or ''}".strip(),
                "period": r.period_current.isoformat() if r.period_current else None,
                "text": r.content,
                "when": r.generated_at.isoformat() if r.generated_at else None,
            })

        # 2) Past reconciliation notes (human notes per account/period).
        adoc = func.to_tsvector("english", func.coalesce(AccountReviewStatus.notes, ""))
        arows = (await db.execute(
            select(
                AccountReviewStatus.qbo_account_id,
                AccountReviewStatus.period_end,
                AccountReviewStatus.notes,
                AccountReviewStatus.updated_at,
            )
            .where(AccountReviewStatus.notes.is_not(None))
            .where(adoc.op("@@")(tsq))
            .order_by(func.ts_rank(adoc, tsq).desc())
            .limit(6)
        )).all()
        for r in arows:
            results.append({
                "source": "recon note",
                "account": r.qbo_account_id,
                "period": r.period_end.isoformat() if r.period_end else None,
                "text": r.notes,
                "when": r.updated_at.isoformat() if r.updated_at else None,
            })

        return {"query": q, "results": results}

    if name == "get_adjustments_queue":
        from decimal import Decimal
        stmt = select(ProposedEntry).where(ProposedEntry.period_end == pe)
        st = (ti.get("status") or "").strip().lower()
        if st in {"open", "accepted", "posted", "dismissed"}:
            stmt = stmt.where(ProposedEntry.status == st)
        rows = (await db.execute(
            stmt.order_by(ProposedEntry.created_at.desc())
        )).scalars().all()
        counts = {"open": 0, "accepted": 0, "posted": 0, "dismissed": 0}
        for r in rows:
            counts[r.status] = counts.get(r.status, 0) + 1

        def _amount(lines: list[dict] | None) -> str:
            tot = Decimal("0")
            for ln in (lines or []):
                try:
                    tot += Decimal(str(ln.get("debit") or "0"))
                except Exception:
                    pass
            return f"{tot:.2f}"

        items = [
            {
                "description": r.description,
                "source": r.source,
                "status": r.status,
                "amount": _amount(r.lines),
                "confidence": r.confidence,
                "memo": r.memo,
                "line_count": len(r.lines or []),
            }
            for r in rows[:12]
        ]
        return {
            "period_end": pe.isoformat(),
            "counts": counts,
            "total": len(rows),
            "shown": len(items),
            "items": items,
        }

    if name == "get_financial_insights":
        snap = (await db.execute(
            select(InsightsSnapshot).where(
                InsightsSnapshot.period_end == pe,
                InsightsSnapshot.period_start.is_(None),
            )
        )).scalar_one_or_none()
        if snap is None:
            return {
                "ok": False,
                "period_end": pe.isoformat(),
                "note": (
                    "No saved insights for this period yet. Open the Insights screen "
                    "and click Sync, then ask again."
                ),
            }
        p = snap.payload or {}
        ms = p.get("management_summary") or {}
        liq = p.get("liquidity") or {}
        prof = p.get("profitability") or {}
        recs = p.get("recommendations") or []
        return {
            "ok": True,
            "period_end": pe.isoformat(),
            "computed_at": snap.computed_at.isoformat() if snap.computed_at else None,
            "management_summary": {
                "headline": ms.get("headline"),
                "health": ms.get("health"),
                "score": ms.get("score"),
                "strengths": ms.get("strengths"),
                "watch_items": ms.get("watch_items"),
                "priorities": ms.get("priorities"),
            },
            "liquidity": {
                "cash_balance": liq.get("cash_balance"),
                "operating_burn": liq.get("operating_burn"),
                "runway_months": liq.get("runway_months"),
                "operating_cash_flow": liq.get("operating_cash_flow"),
                "current_ratio": liq.get("current_ratio"),
                "quick_ratio": liq.get("quick_ratio"),
                "working_capital": liq.get("working_capital"),
            },
            "profitability": {
                "revenue": prof.get("revenue"),
                "gross_margin_pct": prof.get("gross_margin_pct"),
                "net_margin_pct": prof.get("net_margin_pct"),
                "revenue_change_str": prof.get("revenue_change_str"),
            },
            "recommendations": [
                {"priority": r.get("priority"), "title": r.get("title")}
                for r in recs[:5]
            ],
        }

    if name == "get_flux_variances":
        material_only = ti.get("material_only")
        material_only = True if material_only is None else bool(material_only)
        tb = (await db.execute(
            select(TrialBalance).where(TrialBalance.period_current == pe)
        )).scalar_one_or_none()
        if tb is None:
            return {
                "ok": False, "period_end": pe.isoformat(),
                "note": "No flux analysis for this period yet. Run Flux Analysis for that month.",
            }
        rows = (await db.execute(
            select(Variance, Account)
            .join(Account, Account.id == Variance.account_id)
            .where(Account.trial_balance_id == tb.id)
        )).all()
        items = []
        for var, acct in rows:
            if material_only and not getattr(var, "is_material", False):
                continue
            items.append({
                "account_number": acct.account_number,
                "account_name": acct.account_name,
                "prior_balance": str(acct.prior_balance) if acct.prior_balance is not None else None,
                "current_balance": str(acct.current_balance) if acct.current_balance is not None else None,
                "dollar_variance": str(var.dollar_variance) if var.dollar_variance is not None else None,
                "pct_variance": str(var.pct_variance) if var.pct_variance is not None else None,
                "material": bool(getattr(var, "is_material", False)),
                "status": var.status,
                "explained": var.ai_commentary is not None,
            })

        def _absamt(it: dict) -> float:
            try:
                return abs(float(it["dollar_variance"] or 0))
            except Exception:
                return 0.0

        items.sort(key=_absamt, reverse=True)
        return {
            "period_end": pe.isoformat(),
            "material_only": material_only,
            "total": len(items),
            "items": items[:15],
        }

    if name == "get_schedules":
        from decimal import Decimal

        from models.schedule import ScheduleSnapshot
        rows = (await db.execute(
            select(ScheduleSnapshot).where(
                ScheduleSnapshot.period_end == pe,
                ScheduleSnapshot.status == "committed",
            )
        )).scalars().all()
        by_type: dict[str, dict] = {}
        for r in rows:
            t = by_type.setdefault(
                r.schedule_type,
                {"snapshots": 0, "items": 0, "period_expense": Decimal("0"), "ending_balance": Decimal("0")},
            )
            t["snapshots"] += 1
            t["items"] += (r.item_count or 0)
            for fld in ("period_expense", "ending_balance"):
                try:
                    t[fld] += Decimal(str(getattr(r, fld) or 0))
                except Exception:
                    pass
        types = [
            {
                "type": k,
                "committed_snapshots": v["snapshots"],
                "items": v["items"],
                "period_expense": f"{v['period_expense']:.2f}",
                "ending_balance": f"{v['ending_balance']:.2f}",
            }
            for k, v in sorted(by_type.items())
        ]
        return {
            "period_end": pe.isoformat(),
            "types": types,
            "note": None if types else "No committed schedules for this period yet.",
        }

    if name == "get_risk_findings":
        from modules.gl_accuracy.service import list_findings
        data = await list_findings(db, pe)
        items = [
            {
                "title": it.get("title"),
                "kind": it.get("kind"),
                "severity": it.get("severity"),
                "action_kind": it.get("action_kind"),
                "amount": it.get("amount"),
                "vendor": it.get("vendor"),
                "posted_account_name": it.get("posted_account_name"),
                "suggested_account_name": it.get("suggested_account_name"),
                "status": it.get("status"),
            }
            for it in (data.get("items") or [])[:10]
        ]
        return {
            "period_end": pe.isoformat(),
            "open_count": data.get("open_count"),
            "high": data.get("high"),
            "medium": data.get("medium"),
            "fixable_dollars": data.get("dollars"),
            "items": items,
        }

    if name == "get_close_tasks":
        steps = await build_checklist(db, tenant_id, pe, None)
        names = await name_map(db, tenant_id)
        items = [
            {
                "title": s.get("title"),
                "category": s.get("category"),
                "status": s.get("status"),
                "assignee": names.get(str(s.get("assignee_id"))) if s.get("assignee_id") else None,
                "due_date": s.get("due_date"),
                "completed_pct": s.get("completed_pct"),
                "linked_module": s.get("linked_module"),
            }
            for s in steps
        ]
        counts: dict[str, int] = {}
        for s in items:
            counts[s["status"]] = counts.get(s["status"], 0) + 1
        return {
            "period_end": pe.isoformat(),
            "counts": counts,
            "total": len(items),
            "steps": items,
        }

    if name == "get_financial_statements":
        from modules.financials.internal import build_balance_sheet, build_income_statement
        has_snap = (await db.execute(
            select(GlBalanceSnapshot).where(GlBalanceSnapshot.period_end == pe).limit(1)
        )).scalars().first()
        if has_snap is None:
            return {
                "ok": False, "period_end": pe.isoformat(),
                "note": "No synced GL for this period yet. Run Sync for that month.",
            }

        def _slim(rows: list[dict]) -> list[dict]:
            out = []
            for r in rows:
                cur = r.get("current")
                if cur is None and r.get("kind") != "section_header":
                    continue
                out.append({
                    "label": r.get("label"),
                    "amount": str(cur) if cur is not None else None,
                    "kind": r.get("kind"),
                })
            return out

        is_rows, _ = await build_income_statement(db, tenant_id, pe, None)
        bs_rows, _ = await build_balance_sheet(db, tenant_id, pe, None)
        return {
            "period_end": pe.isoformat(),
            "income_statement": _slim(is_rows),
            "balance_sheet": _slim(bs_rows),
        }

    if name == "get_intercompany":
        from models.intercompany_account import IntercompanyAccount
        from models.intercompany_pair import IntercompanyPair
        pairs = (await db.execute(select(IntercompanyPair))).scalars().all()
        marks = (await db.execute(select(IntercompanyAccount))).scalars().all()
        if not pairs and not marks:
            return {
                "ok": True, "period_end": pe.isoformat(), "pairs": [], "accounts": [],
                "note": "No intercompany accounts or pairs are configured for this workspace.",
            }
        acct_ids = {p.my_qbo_account_id for p in pairs} | {m.qbo_account_id for m in marks}
        bal_by_acct: dict[str, str] = {}
        if acct_ids:
            brows = (await db.execute(
                select(GlBalanceSnapshot).where(
                    GlBalanceSnapshot.period_end == pe,
                    GlBalanceSnapshot.qbo_account_id.in_(acct_ids),
                )
            )).scalars().all()
            for b in brows:
                bal_by_acct[b.qbo_account_id] = str(b.balance)
        return {
            "period_end": pe.isoformat(),
            "pairs": [
                {
                    "my_account": p.my_qbo_account_id,
                    "counterparty": p.counterparty_label,
                    "my_balance": bal_by_acct.get(p.my_qbo_account_id),
                }
                for p in pairs
            ],
            "accounts": [
                {
                    "qbo_account_id": m.qbo_account_id,
                    "kind": m.kind,
                    "counterparty": m.counterparty,
                    "balance": bal_by_acct.get(m.qbo_account_id),
                }
                for m in marks
            ],
        }

    if name == "draft_journal_entry":
        # Validate + map onto real accounts + enforce Σdebit == Σcredit using the
        # SAME helpers the Adjustments AI producers use. Read-only here; the
        # router persists the returned draft as a ProposedEntry after the loop.
        accounts = await period_accounts(db, tenant_id, pe)
        entry = {
            "description": ti.get("description"),
            "lines": ti.get("lines") or [],
            "memo": ti.get("memo"),
            "rationale": ti.get("rationale"),
            "confidence": ti.get("confidence"),
        }
        parsed = parse_ai_entries([entry], accounts)
        if not parsed:
            return {
                "ok": False,
                "error": (
                    "I couldn't turn that into a balanced entry. Make sure total "
                    "debits equal total credits and the accounts exist for this "
                    "period (run Sync if the month isn't synced yet)."
                ),
            }
        return {
            "ok": True,
            "draft": {**parsed[0], "period_end": pe.isoformat()},
            "note": (
                "Drafted for review — it's now in the Adjustments queue for a "
                "person to approve and post. Nothing was posted to QuickBooks."
            ),
        }

    if name == "suggest_link":
        target = (ti.get("target") or "").strip().lower()
        if target not in _LINK_TARGETS:
            return {"ok": False, "error": f"Unknown target. Valid: {', '.join(_LINK_TARGETS)}."}
        path, default_label = _LINK_TARGETS[target]
        return {"ok": True, "link": {"path": path, "label": ti.get("label") or default_label}}

    if name == "suggest_action":
        kind = (ti.get("kind") or "").strip().lower()
        if kind not in ("prepare_reconciliations", "prepare_flux"):
            return {"ok": False, "error": "Unknown action. Valid: prepare_reconciliations, prepare_flux."}
        action: dict = {"kind": kind, "period_end": pe.isoformat()}
        if kind == "prepare_reconciliations":
            acct_q = (ti.get("account") or "").strip()
            if acct_q:
                like = f"%{acct_q}%"
                row = (await db.execute(
                    select(GlBalanceSnapshot).where(
                        GlBalanceSnapshot.period_end == pe,
                        (GlBalanceSnapshot.account_number.ilike(like))
                        | (GlBalanceSnapshot.account_name.ilike(like))
                        | (GlBalanceSnapshot.qbo_account_id == acct_q),
                    ).limit(1)
                )).scalars().first()
                if row is None:
                    return {"ok": False, "error": (
                        f"No account matching '{acct_q}' for {pe.isoformat()}. Use the "
                        "account number or exact name, or omit it to prepare all accounts."
                    )}
                action["qbo_account_id"] = row.qbo_account_id
                action["account_name"] = row.account_name
                action["label"] = f"Prepare recon · {row.account_name or row.account_number} · {pe.isoformat()}"
            else:
                action["label"] = f"Prepare all reconciliations · {pe.isoformat()}"
        else:
            # Flux is per-trial-balance; resolve the period's TB so the click can
            # run agentic directly. None → the UI routes the user to create it first.
            tb_id = (await db.execute(
                select(TrialBalance.id).where(TrialBalance.period_current == pe).limit(1)
            )).scalar_one_or_none()
            action["tb_id"] = str(tb_id) if tb_id else None
            action["label"] = (
                f"Prepare flux · {pe.isoformat()}" if tb_id
                else f"Start flux analysis · {pe.isoformat()}"
            )
        return {"ok": True, "action": action}

    return {"error": f"Unknown tool: {name}"}
