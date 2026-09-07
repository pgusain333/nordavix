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
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
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
from modules.assistant.trend import (
    MONTHS_DEFAULT,
    bridge_to_target,
    direction,
    forecast,
    month_ends_back,
    rank_levers,
    total_change_pct,
)
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
        "name": "get_audit_trail",
        "description": (
            "Who did what, and when — the tamper-evident audit log. Every "
            "approval, sync, adjustment, close, and configuration change, newest "
            "first, with the person's name and timestamp. Optionally scoped to one "
            "object. Use for 'who approved this', 'who changed X', 'when was this "
            "signed off', 'what happened to this account', 'show me the history', "
            "'who closed the books', 'audit trail', 'segregation of duties'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "entity_type": {"type": "string", "description": "Optional: narrow to one object type, e.g. 'account_review_status', 'period', 'trial_balance'."},
                "entity_id": {"type": "string", "description": "Optional: narrow to one object's id. Use with entity_type."},
                "limit": {"type": "integer", "description": "How many events (default 25, max 100)."},
            },
        },
    },
    {
        "name": "get_close_review",
        "description": (
            "The AI reviewing-partner pass over the period — completeness, "
            "reconciliation hygiene and anomaly exceptions, each graded high / "
            "review / info, plus what passed and whether a human has signed it off. "
            "Use for 'is this close ready to sign', 'reviewing partner', 'what "
            "would a reviewer flag', 'exceptions', 'is anything missing before we "
            "close', 'quality check'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_workpapers",
        "description": (
            "The workpaper binder for the period — which sections have supporting "
            "documents attached and which are still empty, with file names and "
            "sizes. Use for 'is the binder complete', 'what evidence do we have', "
            "'what's missing for the auditor', 'supporting documents', "
            "'attachments', 'audit readiness'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_advisory",
        "description": (
            "Client-facing advisory: tracked recommendations for the period with "
            "their priority and whether the client has acted, plus KPI targets the "
            "firm set and how the business is grading against them. Use for 'what "
            "did we advise', 'recommendations', 'is the client acting on our "
            "advice', 'KPI targets', 'how are they tracking', 'advisory points for "
            "the meeting'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_evidence_requests",
        "description": (
            "Client evidence (PBC) requests — bank statements and other documents "
            "asked of the client via magic link, with who it went to, whether they "
            "uploaded, and whether the link has expired. Use for 'what are we "
            "waiting on from the client', 'outstanding requests', 'did they send "
            "the bank statement', 'PBC', 'chase list'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_automation_status",
        "description": (
            "Whether the automation is actually running: the QuickBooks connection "
            "and when it last synced, Close Autopilot's configuration and recent "
            "runs, and continuous close — whether the daily watch is on, the hour "
            "it checks, and when it last looked at the current month. Use for 'is "
            "QuickBooks connected', 'when did it last sync', 'is autopilot on', "
            "'is anything monitoring the books', 'when did it last check', "
            "'continuous close status', 'why hasn't it run'."
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
            "insights, financials. For 'reconciliations' you MAY pass `account` "
            "(number or name) to deep-link straight INTO that one account's "
            "reconciliation — prefer this whenever the answer is about a specific "
            "account, so the user lands on it, not the list."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "One of the valid targets."},
                "label": {"type": "string", "description": "Optional button label; defaults to the section name."},
                "account": {"type": "string", "description": "Reconciliations only — an account number or name; opens that account's reconciliation directly (e.g. '2500')."},
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
        "name": "get_trend",
        "description": (
            "How a figure has MOVED over the last N months — revenue, gross "
            "profit, opex, net income, cash, assets, or any single account — "
            "with the direction (rising / falling / flat / volatile), the "
            "month-by-month values, the total change, and the best and worst "
            "months. THE tool for any question about time: 'is revenue growing', "
            "'is the burn getting worse', 'how has margin moved', 'show me the "
            "last 6 months', 'what's the trend'. Reads saved month-end snapshots "
            "only — no QuickBooks call, so it is fast. Call this BEFORE giving "
            "any opinion on performance: one month is a data point, not a story."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "metric": {
                    "type": "string",
                    "description": (
                        "revenue | cogs | gross_profit | opex | operating_income | "
                        "net_income | cash | assets | liabilities — or omit and pass "
                        "`account` for one specific account."
                    ),
                },
                "account": {
                    "type": "string",
                    "description": "Account number or name to trend instead of a statement metric.",
                },
                "months": {"type": "integer", "description": "How many months back (default 6, max 24)."},
                "period_end": {"type": "string", "description": "Latest month YYYY-MM-DD; omit for active period."},
            },
        },
    },
    {
        "name": "get_forecast",
        "description": (
            "Project a metric FORWARD from its own history — revenue, net "
            "income, opex, or cash — with a high/low band and an honest "
            "confidence rating. Use for 'what will revenue be', 'where does "
            "cash land', 'how long is our runway', 'will we be profitable by "
            "Q4', 'forecast'. It refuses to forecast on fewer than 3 months and "
            "widens the band on a volatile series rather than pretending to a "
            "precision the data doesn't have — REPORT the band and the "
            "confidence, never just the midpoint."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "metric": {
                    "type": "string",
                    "description": "revenue | net_income | opex | gross_profit | cash (default revenue).",
                },
                "months_ahead": {"type": "integer", "description": "How far forward (default 3, max 12)."},
                "months_history": {"type": "integer", "description": "History to learn from (default 6, max 24)."},
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
        },
    },
    {
        "name": "plan_to_target",
        "description": (
            "Work out what has to happen for the client to HIT A NUMBER — the "
            "gap, the required monthly run-rate, how that compares to what "
            "they're doing now AND to their best month on record, and which "
            "expense lines are big enough to carry the difference. Use for 'how "
            "do we get to $2M revenue', 'can we hit $500k profit this year', "
            "'what do we need to do to break even', 'how do we reach our "
            "target'. Always report the verdict (on track / stretch / never "
            "been done) — the arithmetic is easy, the reality check is the "
            "value. Then turn the levers into specific, ranked actions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "metric": {
                    "type": "string",
                    "description": "revenue | net_income | gross_profit | operating_income (default net_income).",
                },
                "target": {"type": "number", "description": "The number to hit, in dollars."},
                "target_kind": {
                    "type": "string",
                    "description": (
                        "'total' = a cumulative goal by a date (e.g. $500k of profit for the "
                        "year); 'monthly' = a run-rate to reach (e.g. $200k revenue a month). "
                        "Default 'total'."
                    ),
                },
                "by_period_end": {
                    "type": "string",
                    "description": "Deadline YYYY-MM-DD. Omit for the client's fiscal year end.",
                },
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
            },
            "required": ["target"],
        },
    },
    {
        "name": "get_transactions",
        "description": (
            "The individual TRANSACTIONS behind an account this period — date, "
            "type, amount, vendor/customer and memo — plus any bank-statement "
            "lines and the forensic flags raised on them (duplicate payments, "
            "round-dollar entries, weekend payments, unrecorded withdrawals). "
            "Use when the answer needs detail below the balance: 'why did rent "
            "jump', 'what made up that variance', 'show me the transactions', "
            "'what did we pay <vendor>', 'is there anything unusual in the bank "
            "account'. Transaction detail exists only where someone has already "
            "pulled it (Find reasons on a flux variance, or a bank statement "
            "upload) — if it comes back empty, say where it would come from."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {"type": "string", "description": "Account number or name."},
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
                "min_amount": {"type": "number", "description": "Only transactions at or above this absolute amount."},
            },
            "required": ["account"],
        },
    },
    {
        "name": "get_tie_out",
        "description": (
            "Whether the period's numbers hold together — does the balance sheet "
            "balance (Assets = Liabilities + Equity + net income), does the "
            "trial balance tie, are any account types falling outside the "
            "statements, and which accounts have a GL-vs-subledger variance "
            "that hasn't been cleared. Use for 'does it tie', 'is anything out "
            "of balance', 'why is the balance sheet off', 'is this period "
            "clean'. This checks NORDAVIX's own books against themselves; "
            "comparing them line-by-line against live QuickBooks is the 'Check "
            "against QuickBooks' button on Financial Statements — point the user "
            "there if that's what they want."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "get_repeat_issues",
        "description": (
            "Problems that keep COMING BACK — the same vendor miscoded to the "
            "same account across several months. A one-off is a mistake; the "
            "same mistake three months running is a broken process, and the fix "
            "is a rule, not another journal entry. Use for 'what keeps going "
            "wrong', 'recurring errors', 'why does this keep happening', 'what "
            "should we fix permanently', 'process issues'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."}},
        },
    },
    {
        "name": "search_everything",
        "description": (
            "Find anything in this workspace by name or keyword across accounts, "
            "risk findings, review exceptions, tasks, adjustments, schedules and "
            "periods at once. Use when the user names something you can't place "
            "— a vendor, an account, a task, 'that thing about the truck loan' — "
            "or when you need to locate which module holds a topic before "
            "answering. Cheap; prefer it over guessing."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "What to look for."}},
            "required": ["query"],
        },
    },
    {
        "name": "get_discussion",
        "description": (
            "What the TEAM has said — comment threads left on reconciliations, "
            "variances and other items, with who wrote each and when. Use for "
            "'what did the team say about this', 'has anyone looked at this', "
            "'what questions are open', 'did anyone answer my note', 'what's "
            "being discussed'. Optionally scoped to one account."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "account": {"type": "string", "description": "Optional — narrow to one account's threads."},
                "period_end": {"type": "string", "description": "YYYY-MM-DD; omit for active period."},
                "limit": {"type": "integer", "description": "How many comments (default 20, max 60)."},
            },
        },
    },
    {
        "name": "ask_user",
        "description": (
            "Ask the user ONE clarifying question with tappable options, when "
            "the answer would materially change what you say and you genuinely "
            "cannot resolve it yourself. Legitimate uses: which entity/scenario "
            "they mean, what target or assumption to plan against, which of two "
            "readings of an ambiguous request they want, how aggressive a "
            "recommendation should be. NEVER use it for something a tool can "
            "answer (which month, what an account balance is, who's on the "
            "team) — look it up instead. Ask at most one question per answer, "
            "and ALWAYS give your best partial answer in the same turn: the "
            "question refines a response, it never replaces one."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The single question, one short sentence."},
                "options": {
                    "type": "array",
                    "description": "2-5 tappable answers, each a few words.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "hint": {"type": "string", "description": "Optional half-line of what this choice means."},
                        },
                        "required": ["label"],
                    },
                },
                "allow_free_text": {"type": "boolean", "description": "Let them type their own instead (default true)."},
            },
            "required": ["question", "options"],
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


def _summary_texts(items) -> list[str]:
    """Management-summary lines as plain strings.

    They are {text, action} objects now; a payload cached before that change
    still holds bare strings, so both are accepted rather than one crashing the
    assistant on a stale blob.
    """
    out: list[str] = []
    for it in items or []:
        if isinstance(it, dict):
            t = it.get("text")
            if t:
                out.append(str(t))
        elif it:
            out.append(str(it))
    return out


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


# Statement metrics the cross-period tools can trend or project. Keyed to the
# names totals_series returns, so a metric can never mean one thing here and
# another on the Financial Statements screen.
_TREND_METRICS = {
    "revenue", "cogs", "gross_profit", "opex", "operating_income",
    "net_income", "cash", "assets", "liabilities", "equity",
    "current_assets", "current_liabilities",
}
# Metrics that are a BALANCE, not activity. They are never differenced and a
# "total assets for the month of June" question is a category error.
_POINT_IN_TIME = {"cash", "assets", "liabilities", "equity",
                  "current_assets", "current_liabilities"}


async def _fiscal_year_end(db: AsyncSession, tenant_id: uuid.UUID) -> str | None:
    """The client's fiscal year end ('MM-DD'), or None for the calendar default.

    Read directly rather than assumed: a June-year-end client's July is the
    first month of a fiscal year, and treating it as a mid-year month makes
    every month-activity figure a subtraction of two unrelated running totals.
    """
    try:
        from models.tenant import Tenant
        return (await db.execute(
            select(Tenant.fiscal_year_end).where(Tenant.id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
    except Exception:
        return None


async def _find_account(db: AsyncSession, period_end: date, q: str):
    """Resolve a user's account phrase to one snapshot row for the period."""
    like = f"%{q}%"
    return (await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.period_end == period_end,
            (GlBalanceSnapshot.account_number.ilike(like))
            | (GlBalanceSnapshot.account_name.ilike(like))
            | (GlBalanceSnapshot.qbo_account_id == q),
        ).limit(1)
    )).scalars().first()


async def _metric_series(
    db: AsyncSession, tenant_id: uuid.UUID, period_end: date, metric: str, months: int,
) -> tuple[list[dict], str]:
    """(points, note) for a statement metric across the trailing `months`.

    Months with no snapshot are absent from the list rather than zero — a month
    nobody synced is not a month of no revenue, and averaging the two together
    would understate every figure downstream.
    """
    from modules.financials.internal import totals_series

    fye = await _fiscal_year_end(db, tenant_id)
    ends = month_ends_back(period_end, months)
    rows = await totals_series(db, tenant_id, ends, fiscal_year_end=fye)
    point_in_time = metric in _POINT_IN_TIME
    points: list[dict] = []
    gaps: list[str] = []
    for r in rows:
        val = r.get(metric)
        if val is None or (not point_in_time and r.get("pl_basis") != "month"):
            gaps.append(r["period_end"].isoformat())
            continue
        points.append({"period_end": r["period_end"].isoformat(), "value": float(val)})
    missing = len(ends) - len(rows)
    note_bits = []
    if missing > 0:
        note_bits.append(f"{missing} of the {len(ends)} months requested have never been synced")
    if gaps:
        note_bits.append(
            f"{len(gaps)} month(s) had no prior period to measure activity against "
            f"({', '.join(gaps[:3])})"
        )
    return points, "; ".join(note_bits)


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

    if name == "get_audit_trail":
        # The audit log's entity filters have existed since it was built and had
        # no caller anywhere in the product. "Who approved this account?" is
        # exactly what it answers and nothing was asking it.
        from models.audit_log import AuditLog

        limit = min(int(ti.get("limit") or 25), 100)
        q = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
        etype = (ti.get("entity_type") or "").strip() or None
        eid = (ti.get("entity_id") or "").strip() or None
        if etype:
            q = q.where(AuditLog.entity_type == etype)
        if eid:
            q = q.where(AuditLog.entity_id == eid)
        rows = list((await db.execute(q)).scalars().all())
        # Reuse the workspace roster rather than a second Clerk lookup — the
        # audit log stores user ids and the reader wants names.
        members = await workspace_members(db, tenant_id)
        names = {str(m.get("id")): m.get("display_name") for m in members if m.get("id")}
        return {
            "events": [
                {
                    "action": r.action,
                    "who": names.get(str(r.user_id), "System") if r.user_id else "System",
                    "at": r.created_at.isoformat() if r.created_at else None,
                    "entity_type": r.entity_type,
                    "summary": (r.event_data or {}).get("summary")
                               if isinstance(r.event_data, dict) else None,
                }
                for r in rows
            ],
            "count": len(rows),
            "scoped_to": {"entity_type": etype, "entity_id": eid} if etype else None,
        }

    if name == "get_automation_status":
        from models.autopilot import AutopilotConfig, AutopilotRun
        from models.gl_scan_run import GlScanRun
        from models.period_sync import PeriodSync
        from models.qbo_connection import QboConnection

        conn = (await db.execute(
            select(QboConnection).where(QboConnection.tenant_id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        last_sync = (await db.execute(
            select(PeriodSync.synced_at).order_by(PeriodSync.synced_at.desc()).limit(1)
        )).scalar_one_or_none()
        cfg = (await db.execute(select(AutopilotConfig))).scalar_one_or_none()
        last_run = (await db.execute(
            select(AutopilotRun).order_by(AutopilotRun.started_at.desc()).limit(1)
        )).scalar_one_or_none()
        # Continuous close tracks the CURRENT calendar month, never the one
        # being closed — so its last check is looked up against that month.
        from modules.gl_accuracy.service import _current_period
        watch = (await db.execute(
            select(GlScanRun).where(GlScanRun.period_end == _current_period())
            .order_by(GlScanRun.started_at.desc()).limit(1)
        )).scalar_one_or_none()
        return {
            "quickbooks": {
                "connected": conn is not None,
                "last_sync_at": last_sync.isoformat() if last_sync else None,
            },
            "autopilot": {
                "enabled": bool(cfg and cfg.enabled),
                "run_day": cfg.run_day if cfg else None,
                "last_run": {
                    "period_end": last_run.period_end.isoformat(),
                    "status": last_run.status,
                    "started_at": last_run.started_at.isoformat() if last_run.started_at else None,
                } if last_run else None,
            },
            "continuous_close": {
                "enabled": bool(cfg and cfg.continuous_enabled),
                "check_hour": cfg.check_hour if cfg else None,
                "emails_the_workspace": bool(cfg and cfg.continuous_email),
                "tracking_period": _current_period().isoformat(),
                "last_checked_at": watch.finished_at.isoformat()
                                   if watch and watch.finished_at else None,
                "last_check_ok": watch.ok if watch else None,
                "transactions_reviewed": watch.transactions_reviewed if watch else None,
            },
        }

    if name == "ask_user":
        # The copilot could always ASK in prose; what it couldn't do was make
        # answering cheap. A prose question costs the user a sentence of typing,
        # so most go unanswered and the answer stays generic.
        q = (ti.get("question") or "").strip()
        opts: list[dict] = []
        for o in (ti.get("options") or []):
            if isinstance(o, dict) and (o.get("label") or "").strip():
                opts.append({"label": str(o["label"]).strip()[:80],
                             "hint": (str(o.get("hint")).strip()[:120] if o.get("hint") else None)})
            elif isinstance(o, str) and o.strip():
                opts.append({"label": o.strip()[:80], "hint": None})
        if not q or len(opts) < 2:
            return {"ok": False, "error": "A question and at least 2 options are required."}
        return {"ok": True, "clarify": {
            "question": q,
            "options": opts[:5],
            "allow_free_text": ti.get("allow_free_text") is not False,
        }}

    if name == "search_everything":
        from modules.search.service import search as workspace_search
        q = (ti.get("query") or "").strip()
        if len(q) < 2:
            return {"ok": False, "error": "Give me at least two characters to search for."}
        hits = await workspace_search(db, tenant_id, q, limit=20)
        return {"query": q, "count": len(hits), "results": hits}

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

    if name == "get_trend":
        months = int(ti.get("months") or MONTHS_DEFAULT)
        acct_q = (ti.get("account") or "").strip()
        metric = (ti.get("metric") or "").strip().lower()

        if acct_q:
            row = await _find_account(db, pe, acct_q)
            if row is None:
                return {"ok": False, "error": f"No account matching '{acct_q}' for {pe.isoformat()}."}
            ends = month_ends_back(pe, months)
            brows = (await db.execute(
                select(GlBalanceSnapshot).where(
                    GlBalanceSnapshot.qbo_account_id == row.qbo_account_id,
                    GlBalanceSnapshot.period_end.in_(ends),
                ).order_by(GlBalanceSnapshot.period_end)
            )).scalars().all()
            points = [{"period_end": b.period_end.isoformat(), "value": float(b.balance)} for b in brows]
            label = f"{row.account_number or ''} {row.account_name or ''}".strip()
            note = (f"{len(ends) - len(points)} of {len(ends)} months not synced"
                    if len(points) < len(ends) else "")
            basis = "Account balance at each month end (point in time)."
        else:
            if metric not in _TREND_METRICS:
                metric = "revenue"
            points, note = await _metric_series(db, tenant_id, pe, metric, months)
            label = metric.replace("_", " ")
            basis = ("Balance at each month end (point in time)."
                     if metric in _POINT_IN_TIME
                     else "Each month's own activity, not year-to-date.")

        vals = [p["value"] for p in points]
        if not points:
            return {"ok": False, "metric": label, "period_end": pe.isoformat(),
                    "note": note or "No synced months in this window."}
        best = max(points, key=lambda p: p["value"])
        worst = min(points, key=lambda p: p["value"])
        return {
            "ok": True,
            "metric": label,
            "months": len(points),
            "basis": basis,
            "points": points,
            "direction": direction(vals),
            "total_change_pct": (round(total_change_pct(vals), 1)
                                 if total_change_pct(vals) is not None else None),
            "latest": vals[-1],
            "average": round(sum(vals) / len(vals), 2),
            "best_month": {"period_end": best["period_end"], "value": best["value"]},
            "worst_month": {"period_end": worst["period_end"], "value": worst["value"]},
            "note": note or None,
        }

    if name == "get_forecast":
        metric = (ti.get("metric") or "revenue").strip().lower()
        if metric not in _TREND_METRICS:
            metric = "revenue"
        hist = int(ti.get("months_history") or MONTHS_DEFAULT)
        ahead = int(ti.get("months_ahead") or 3)
        points, note = await _metric_series(db, tenant_id, pe, metric, hist)
        vals = [p["value"] for p in points]
        fc = forecast(vals, ahead)
        # Label the projected months so the model quotes "October", not "step 3".
        if fc.get("ok"):
            cur = pe
            for p in fc["points"]:
                nxt_first = (cur.replace(day=28) + timedelta(days=10)).replace(day=1)
                cur = ((nxt_first.replace(day=28) + timedelta(days=10)).replace(day=1)
                       - timedelta(days=1))
                p["period_end"] = cur.isoformat()
        return {
            "metric": metric.replace("_", " "),
            "from_period": pe.isoformat(),
            "history": points,
            "forecast": fc,
            "note": note or None,
        }

    if name == "plan_to_target":
        metric = (ti.get("metric") or "net_income").strip().lower()
        if metric not in _TREND_METRICS or metric in _POINT_IN_TIME:
            metric = "net_income"
        try:
            target = Decimal(str(ti.get("target")))
        except Exception:
            return {"ok": False, "error": "A numeric target is required."}
        kind = "monthly" if (ti.get("target_kind") or "").strip().lower() == "monthly" else "total"

        fye = await _fiscal_year_end(db, tenant_id)
        deadline = _parse_period(ti.get("by_period_end"), None)
        if deadline is None:
            from core.fiscal import fiscal_year_start
            fy_start = fiscal_year_start(pe, fye)
            deadline = (fy_start.replace(year=fy_start.year + 1)
                        - timedelta(days=1))
        months_left = max(0, (deadline.year - pe.year) * 12 + (deadline.month - pe.month))

        points, note = await _metric_series(db, tenant_id, pe, metric, 12)
        vals = [p["value"] for p in points]
        if not vals:
            return {"ok": False, "error": (
                f"No synced months to measure {metric.replace('_', ' ')} against. "
                "Sync the period first."
            )}
        # Current pace = the trailing three months, not the latest one. A single
        # month is exactly the noise a plan should not be built on.
        recent = vals[-3:]
        current_monthly = sum(recent) / len(recent)

        # Fiscal-year-to-date achievement, for a cumulative target.
        from core.fiscal import same_fiscal_year
        achieved = sum(
            p["value"] for p in points
            if same_fiscal_year(date.fromisoformat(p["period_end"]), pe, fye)
        )

        bridge = bridge_to_target(
            target=target,
            current_monthly=current_monthly,
            months_remaining=months_left,
            achieved_to_date=achieved,
            best_month=max(vals),
            target_kind=kind,
        )

        # The levers: the client's own largest expense lines this period, so the
        # advice is about their cost base rather than a generic checklist.
        levers: list[dict] = []
        try:
            from modules.financials.internal import totals_series  # noqa: F401
            prior_end = pe.replace(day=1) - timedelta(days=1)
            cur_rows = (await db.execute(
                select(GlBalanceSnapshot).where(
                    GlBalanceSnapshot.period_end == pe,
                    GlBalanceSnapshot.account_type.in_(["Expense", "Cost of Goods Sold"]),
                )
            )).scalars().all()
            prior_rows = (await db.execute(
                select(GlBalanceSnapshot).where(
                    GlBalanceSnapshot.period_end == prior_end,
                    GlBalanceSnapshot.account_type.in_(["Expense", "Cost of Goods Sold"]),
                )
            )).scalars().all()
            prior_by_id = {r.qbo_account_id: r.balance for r in prior_rows}
            for r in cur_rows:
                # Expense snapshots are year-to-date; difference to the month.
                monthly = r.balance - prior_by_id.get(r.qbo_account_id, Decimal("0"))
                if monthly > 0:
                    levers.append({"name": r.account_name or r.account_number or "?",
                                   "monthly_amount": float(monthly)})
        except Exception:
            pass

        monthly_gap = bridge.get("monthly_delta") or 0
        ranked = rank_levers(levers, monthly_gap if monthly_gap > 0 else 0)[:6]

        return {
            "ok": True,
            "metric": metric.replace("_", " "),
            "as_of": pe.isoformat(),
            "deadline": deadline.isoformat(),
            "bridge": bridge,
            "recent_months": points[-6:],
            "levers": ranked,
            "levers_note": (
                "Each lever shows the percentage cut in THAT line alone that would close "
                "the monthly gap. Anything over 100% cannot do it by itself; 'structural' "
                "lines (rent, insurance, interest, depreciation) can't be flexed inside a "
                "quarter."
            ),
            "note": note or None,
        }

    if name == "get_transactions":
        acct_q = (ti.get("account") or "").strip()
        row = await _find_account(db, pe, acct_q)
        if row is None:
            return {"ok": False, "error": f"No account matching '{acct_q}' for {pe.isoformat()}."}
        try:
            floor = Decimal(str(ti.get("min_amount"))) if ti.get("min_amount") is not None else None
        except Exception:
            floor = None
        label = f"{row.account_number or ''} {row.account_name or ''}".strip()

        # GL transactions pulled by "Find reasons" on a flux variance.
        from models.variance_transaction import VarianceTransaction
        gl_txns: list[dict] = []
        try:
            vrows = (await db.execute(
                select(VarianceTransaction, Variance, Account)
                .join(Variance, Variance.id == VarianceTransaction.variance_id)
                .join(Account, Account.id == Variance.account_id)
                .join(TrialBalance, TrialBalance.id == Account.trial_balance_id)
                .where(TrialBalance.period_current == pe)
                .where((Account.account_number == row.account_number)
                       | (Account.account_name == row.account_name))
                .order_by(VarianceTransaction.txn_date.desc())
                .limit(60)
            )).all()
            for vt, _v, _a in vrows:
                if floor is not None and abs(vt.amount) < floor:
                    continue
                gl_txns.append({
                    "date": vt.txn_date.isoformat() if vt.txn_date else None,
                    "type": vt.txn_type, "number": vt.txn_number,
                    "amount": str(vt.amount), "who": vt.entity_name,
                    "memo": vt.memo, "reviewed": vt.is_checked,
                })
        except Exception:
            pass

        # The bank's own record, where a statement has been uploaded.
        bank_txns: list[dict] = []
        try:
            from models.bank_statement_txn import BankStatementTxn
            brows = (await db.execute(
                select(BankStatementTxn).where(
                    BankStatementTxn.period_end == pe,
                    BankStatementTxn.qbo_account_id == row.qbo_account_id,
                ).order_by(BankStatementTxn.txn_date.desc()).limit(60)
            )).scalars().all()
            for b in brows:
                if floor is not None and abs(b.amount) < floor:
                    continue
                bank_txns.append({
                    "date": b.txn_date.isoformat() if b.txn_date else None,
                    "amount": str(b.amount), "description": b.description,
                    "ref": b.bank_ref, "match_status": b.match_status,
                })
        except Exception:
            pass

        # Forensic flags already raised on this account by the bank engine.
        flags: list[dict] = []
        try:
            from modules.gl_accuracy.service import list_findings
            data = await list_findings(db, pe)
            for it in (data.get("items") or []):
                if it.get("posted_account_id") == row.qbo_account_id:
                    flags.append({"title": it.get("title"), "severity": it.get("severity"),
                                  "kind": it.get("kind"), "amount": it.get("amount"),
                                  "vendor": it.get("vendor")})
            flags = flags[:10]
        except Exception:
            pass

        return {
            "account": label,
            "period_end": pe.isoformat(),
            "balance": str(row.balance),
            "gl_transactions": gl_txns[:30],
            "bank_transactions": bank_txns[:30],
            "forensic_flags": flags,
            "note": (
                None if (gl_txns or bank_txns or flags) else
                "No transaction detail stored for this account. Nordavix pulls it on "
                "demand — 'Find reasons' on the account's flux variance fetches the GL "
                "transactions, and a bank statement upload brings in the bank's own lines."
            ),
        }

    if name == "get_tie_out":
        from modules.financials.internal import statement_totals, statement_validation
        fye = await _fiscal_year_end(db, tenant_id)
        validation = await statement_validation(db, tenant_id, pe)
        totals = await statement_totals(db, tenant_id, pe, fiscal_year_end=fye)
        if totals is None:
            return {"ok": False, "period_end": pe.isoformat(),
                    "note": "This period has never been synced, so there is nothing to tie."}

        # Reconciliations that carry an uncleared GL-vs-subledger difference.
        unreconciled: list[dict] = []
        tb_check = None
        try:
            ov = await read_overview_from_snapshots(db, pe)
            tb_check = ov.get("tb_check")
            for a in ov.get("accounts", []):
                try:
                    var = Decimal(str(a.get("variance") or "0"))
                except Exception:
                    continue
                if abs(var) >= 1 and a.get("review_status") != "approved":
                    unreconciled.append({
                        "account": f"{a.get('account_number') or ''} {a.get('account_name') or ''}".strip(),
                        "gl_balance": a.get("gl_balance"),
                        "subledger_balance": a.get("subledger_balance"),
                        "variance": a.get("variance"),
                        "review_status": a.get("review_status"),
                    })
            unreconciled.sort(key=lambda r: abs(Decimal(str(r["variance"] or 0))), reverse=True)
        except Exception:
            pass

        return {
            "period_end": pe.isoformat(),
            "balance_sheet_balances": validation.get("balanced"),
            "balance_sheet_difference": validation.get("bs_diff"),
            "cash_flow_plug": validation.get("cf_plug"),
            "unclassified_account_types": validation.get("unclassified_types"),
            "problems": validation.get("messages"),
            "trial_balance_check": tb_check,
            "totals": {
                "assets": str(totals["assets"]),
                "liabilities_and_equity": str(totals["balance_sheet_total"]),
                "net_income_ytd": str(totals["net_income"]),
            },
            "accounts_with_open_variance": unreconciled[:10],
            "open_variance_count": len(unreconciled),
            "compare_to_quickbooks": (
                "This is Nordavix's books checked against themselves. To compare them "
                "line-by-line with live QuickBooks, use 'Check against QuickBooks' on "
                "the Financial Statements screen."
            ),
        }

    if name == "get_repeat_issues":
        from models.gl_accuracy_finding import GlAccuracyFinding
        from modules.gl_accuracy.repeats import (
            REPEAT_AFTER_PERIODS,
            Occurrence,
            find_repeats,
            summarise,
        )
        # Every period, not just this one — a pattern is only visible across
        # closes, which is the entire point of the module.
        rows = (await db.execute(
            select(GlAccuracyFinding).order_by(GlAccuracyFinding.period_end.desc())
        )).scalars().all()
        repeats = find_repeats([
            Occurrence(
                period_end=f.period_end, vendor=f.vendor or "",
                posted_account_name=f.posted_account_name,
                suggested_account_name=f.suggested_account_name,
                amount=Decimal(str(f.amount or 0)), status=f.status,
            )
            for f in rows
        ])
        return {
            "period_end": pe.isoformat(),
            "min_periods_to_count": REPEAT_AFTER_PERIODS,
            "repeats": repeats or [],
            "count": len(repeats or []),
            "summary": summarise(repeats or []),
            "why_it_matters": (
                "A one-off is a mistake; the same vendor hitting the same wrong account "
                "for three months is a process failure. The fix is a coding rule or a "
                "conversation with whoever enters it — not another journal entry."
            ),
        }

    if name == "get_discussion":
        from models.comment import Comment
        limit = min(int(ti.get("limit") or 20), 60)
        q = select(Comment).where(Comment.deleted_at.is_(None))
        acct_q = (ti.get("account") or "").strip()
        scoped_to = None
        if acct_q:
            row = await _find_account(db, pe, acct_q)
            if row is None:
                return {"ok": False, "error": f"No account matching '{acct_q}' for {pe.isoformat()}."}
            scoped_to = f"{row.account_number or ''} {row.account_name or ''}".strip()
            q = q.where(Comment.entity_id.like(f"{row.qbo_account_id}:%"))
        rows = list((await db.execute(
            q.order_by(Comment.created_at.desc()).limit(limit)
        )).scalars().all())
        names = await name_map(db, tenant_id)
        return {
            "period_end": pe.isoformat(),
            "scoped_to": scoped_to,
            "count": len(rows),
            "comments": [
                {
                    "on": c.entity_type,
                    "ref": c.entity_id,
                    "who": names.get(str(c.author_user_id)) or "Someone",
                    "at": c.created_at.isoformat() if c.created_at else None,
                    "text": c.body,
                    "mentions": len(c.mentions or []),
                }
                for c in rows
            ],
            "note": None if rows else "No comments on this workspace yet.",
        }

    if name == "get_close_review":
        from models.close_review import CloseReview

        row = (await db.execute(
            select(CloseReview).where(CloseReview.period_end == pe)
            .order_by(CloseReview.generated_at.desc()).limit(1)
        )).scalar_one_or_none()
        if row is None:
            return {"period_end": pe.isoformat(), "reviewed": False,
                    "message": "No reviewing-partner pass has been run for this period yet."}
        return {
            "period_end": pe.isoformat(),
            "reviewed": True,
            "status": row.status,
            "summary": row.summary,
            "high": row.high_count,
            "to_review": row.review_count,
            "info": row.info_count,
            "cleared": row.cleared_count,
            "checks_run": row.checks_run,
            "signed_off": row.signed_off_by is not None,
            "generated_at": row.generated_at.isoformat() if row.generated_at else None,
        }

    if name == "get_workpapers":
        from models.workpaper_evidence import WorkpaperEvidence

        rows = list((await db.execute(
            select(WorkpaperEvidence).where(WorkpaperEvidence.period_end == pe)
        )).scalars().all())
        by_section: dict[str, int] = {}
        for r in rows:
            by_section[r.ref_type] = by_section.get(r.ref_type, 0) + 1
        return {
            "period_end": pe.isoformat(),
            "documents": len(rows),
            "sections_with_evidence": by_section,
            "files": [
                {"section": r.ref_type, "name": r.file_name,
                 "size_kb": round((r.file_size or 0) / 1024, 1)}
                for r in rows[:40]
            ],
        }

    if name == "get_advisory":
        from models.advisory import KpiTarget, TrackedRecommendation

        recs = list((await db.execute(
            select(TrackedRecommendation).where(TrackedRecommendation.period_end == pe)
        )).scalars().all())
        targets = list((await db.execute(select(KpiTarget))).scalars().all())
        return {
            "period_end": pe.isoformat(),
            "recommendations": [
                {"title": r.title, "priority": r.priority, "status": r.status,
                 "detail": r.detail, "client_action": r.client_action}
                for r in recs
            ],
            "open_count": sum(1 for r in recs if r.status == "open"),
            "kpi_targets": [
                {"kpi": t.kpi_key, "comparator": t.comparator,
                 "target": float(t.target_value), "note": t.note}
                for t in targets
            ],
        }

    if name == "get_evidence_requests":
        from models.evidence_request import EvidenceRequest

        rows = list((await db.execute(
            select(EvidenceRequest).where(EvidenceRequest.period_end == pe)
        )).scalars().all())
        now = datetime.now(UTC)

        def _state(r) -> str:
            # Fulfilled beats expired: a client who delivered before the link
            # lapsed is not outstanding, and listing them as such sends someone
            # to chase a document they already sent.
            if r.fulfilled_at is not None:
                return "received"
            if r.expires_at and r.expires_at < now:
                return "expired"
            return "waiting"

        items = [
            {"account": r.account_label or r.qbo_account_id, "title": r.title,
             "sent_to": r.recipient_email, "state": _state(r),
             "files": len(r.files or []) if isinstance(r.files, list) else 0}
            for r in rows
        ]
        return {
            "period_end": pe.isoformat(),
            "requests": items,
            "waiting_on_client": sum(1 for i in items if i["state"] == "waiting"),
            "expired": sum(1 for i in items if i["state"] == "expired"),
        }

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
        # Refuse a snapshot that predates the period's current sync. Answering
        # from figures QuickBooks has since superseded is worse than saying we
        # don't know — the assistant states its answers as fact, and nothing
        # here would flag them as out of date.
        from models.period_sync import PeriodSync
        from modules.insights.service import cache_is_fresh
        _sync = (await db.execute(
            select(PeriodSync.synced_at).where(PeriodSync.period_end == pe)
        )).scalar_one_or_none()
        if not cache_is_fresh(dict(snap.payload or {}),
                              _sync.isoformat() if _sync else None):
            return {
                "ok": False,
                "period_end": pe.isoformat(),
                "note": (
                    "The saved insights for this period are older than the last "
                    "QuickBooks sync, so the figures would be out of date. Open "
                    "the Insights screen for this period to refresh them, then "
                    "ask again."
                ),
            }
        p = snap.payload or {}
        ms = p.get("management_summary") or {}
        liq = p.get("liquidity") or {}
        prof = p.get("profitability") or {}
        recs = p.get("recommendations") or []
        cf = p.get("cash_forecast") or {}
        growth = p.get("growth") or {}
        be = p.get("breakeven") or {}
        ar = p.get("receivables") or {}
        ap = p.get("payables") or {}
        exp = p.get("expenses") or {}
        return {
            "ok": True,
            "period_end": pe.isoformat(),
            "computed_at": snap.computed_at.isoformat() if snap.computed_at else None,
            "management_summary": {
                "headline": ms.get("headline"),
                "health": ms.get("health"),
                "score": ms.get("score"),
                # Summary lines are {text, action} objects; the action is a UI
                # affordance the assistant cannot click, so it reads the text.
                # Tolerates the older plain-string shape from a stale cache.
                "strengths": _summary_texts(ms.get("strengths")),
                "watch_items": _summary_texts(ms.get("watch_items")),
                "priorities": _summary_texts(ms.get("priorities")),
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
            # Everything below was already computed and saved on every Insights
            # run, and the copilot was dropping it — so "how do we improve cash"
            # got a generic answer while the client's own DSO, aging profile and
            # customer concentration sat one dict key away.
            "cash_forecast": {
                "out_of_cash_date": cf.get("out_of_cash_date"),
                "projected_cash_3mo": cf.get("projected_cash_3mo"),
                "projected_cash_6mo": cf.get("projected_cash_6mo"),
                "runway_if_burn_cut_10pct": cf.get("runway_minus_10"),
                "runway_if_burn_grows_10pct": cf.get("runway_plus_10"),
            },
            "growth": {
                "revenue_growth_mom_pct": growth.get("revenue_growth_mom"),
                "trend_3mo_growth_pct": growth.get("trend_3mo_growth"),
                "annualized_run_rate": growth.get("annualized_run_rate"),
                "expense_growth_mom_pct": growth.get("expense_growth_mom"),
                "operating_leverage": growth.get("operating_leverage"),
            },
            "breakeven": {
                "break_even_revenue": be.get("break_even_revenue"),
                "current_revenue": be.get("current_revenue"),
                "margin_of_safety_pct": be.get("margin_of_safety_pct"),
                "contribution_margin_pct": be.get("contribution_margin_pct"),
                "fixed_costs": be.get("fixed_costs"),
            },
            "receivables": {
                "ar_balance": ar.get("ar_balance"),
                "dso_days": ar.get("dso_days"),
                "aging": ar.get("aging"),
                "over_60_days_pct": ar.get("aging_over_60_pct"),
                "top_customers": (ar.get("top_customers") or [])[:5],
            },
            "payables": {
                "ap_balance": ap.get("ap_balance"),
                "dpo_days": ap.get("dpo_days"),
                "aging": ap.get("aging"),
                "over_60_days_pct": ap.get("aging_over_60_pct"),
                "top_vendors": (ap.get("top_vendors") or [])[:5],
            },
            "expenses": {
                "total": exp.get("total_expenses"),
                "top_categories": (exp.get("top_categories") or [])[:6],
                "biggest_mover_vs_last_month": exp.get("biggest_mom_mover"),
            },
            "recommendations": [
                {"priority": r.get("priority"), "title": r.get("title"),
                 "detail": r.get("detail")}
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
        label = ti.get("label") or default_label
        # Deep-link straight into one account's reconciliation drawer when an account
        # is given — the recon dashboard opens it from the `#acct=<id>` URL hash.
        acct = (ti.get("account") or "").strip()
        if target == "reconciliations" and acct:
            like = f"%{acct}%"
            row = (await db.execute(
                select(GlBalanceSnapshot).where(
                    GlBalanceSnapshot.period_end == pe,
                    (GlBalanceSnapshot.account_number.ilike(like))
                    | (GlBalanceSnapshot.account_name.ilike(like))
                    | (GlBalanceSnapshot.qbo_account_id == acct),
                ).limit(1)
            )).scalars().first()
            if row is not None:
                path = f"/app/reconciliations/period/{pe.isoformat()}#acct={row.qbo_account_id}"
                if not ti.get("label"):
                    acct_label = f"{row.account_number or ''} {row.account_name or ''}".strip()
                    label = f"Open {acct_label or acct} reconciliation"
        return {"ok": True, "link": {"path": path, "label": label}}

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
