"""
Executive Financial Report — orchestrator.

This module assembles a *complete board-ready close package* for a single
month, pulls structured narrative from Claude, and hands the result off
to `exec_pdf.build_executive_pdf` for rendering.

Why it lives separately from `pdf.py`:
  • `pdf.py` is the standard financial-package PDF (IS / BS / CF tables
    only). It's used every month for routine audit support and stays
    deliberately mechanical.
  • This module is the bigger, AI-narrated, multi-section "exec report"
    that only runs once a month — after books are closed — and bundles
    every workspace surface (financials + insights + recons + flux)
    into a single CEO/CFO-ready document.

The endpoint that drives this lives in `router.py::export_executive_report`.

Data flow:

    period_end (closed) ────► gather_report_data ────► build_executive_pdf
                                       │
                                       ├── financials  (IS, BS, CF)        ── reuses _build_statement
                                       ├── insights    (liquidity, profit…) ── reuses insights.service
                                       ├── recons      (overview + flagged) ── reuses recons.service.get_overview
                                       └── flux        (analyses for month) ── reuses flux models directly
                                       │
                                       ▼
                              generate_ai_commentary ── single Claude call
                                       │
                                       ▼ AIReportNarrative
                              ExecReportData (one dataclass with everything)

Failure modes:
  • Any single data source (insights / flux / recons) may degrade
    gracefully — we surface a friendly "data unavailable" string in
    that section rather than fail the whole report.
  • The AI call has a per-section fallback: if Anthropic times out or
    returns malformed JSON, we drop in a deterministic summary built
    from the raw numbers so the PDF still ships.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.client import generate_narrative
from models.closed_period import ClosedPeriod
from models.trial_balance import TrialBalance
from models.user import User

logger = logging.getLogger(__name__)


# ── Dataclasses ─────────────────────────────────────────────────────────────


@dataclass
class AIReportNarrative:
    """Structured output from the single Claude call."""
    executive_summary: str
    key_highlights: list[str]
    risks: list[str]
    recommendations: list[str]
    outlook: str


@dataclass
class ReconSummary:
    """Reconciliations rollup for the closing month."""
    total_accounts: int
    approved_count: int
    flagged_count: int
    pending_count: int
    total_variance: Decimal
    top_variances: list[dict]   # [{account_name, account_number, variance, status}]
    flagged_items: list[dict]   # [{account_name, notes}]
    ai_prepared_count: int      # number of accounts AI touched


@dataclass
class FluxHighlight:
    """One flux analysis distilled to its narrative-worthy bits."""
    name: str
    period_current: date
    period_prior: date
    materiality_threshold: Decimal
    approved_by_name: str | None
    material_variance_count: int
    top_variances: list[dict]   # [{account_name, account_number, current, prior, change_pct, narrative}]


@dataclass
class ExecReportData:
    """Everything the PDF builder needs in one place."""
    # Identity / period
    company: str
    period_end: date
    period_label: str           # "April 2026"
    closed_at: datetime | None
    closed_by_name: str

    # Financial statements (StatementOut objects from financials/router.py)
    income_statement: Any
    balance_sheet:    Any
    cash_flow:        Any | None   # may be None if QBO CF call failed

    # Insights — full dict from insights.service.compute_overview
    insights: dict[str, Any]

    # Reconciliations rollup
    recons: ReconSummary

    # Flux highlights — one entry per approved flux analysis for the month
    flux: list[FluxHighlight]

    # AI-generated narrative (one structured Claude call)
    ai: AIReportNarrative

    # Soft warnings to render in a Notes section
    warnings: list[str] = field(default_factory=list)


# ── Data gathering ──────────────────────────────────────────────────────────


async def _gather_recon_summary(
    db: AsyncSession, tenant_id, period_end: date,
) -> ReconSummary:
    """Pull the recons overview straight from the DB (no QBO calls) and
    distill it to the rollup the exec report needs. Live with the
    insights/recons modules already touching the DB heavily — keeping
    the read here avoids importing the dashboard endpoint."""
    from models.account_review_status import AccountReviewStatus

    rows = list((await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.period_end == period_end,
        )
    )).scalars().all())

    total = len(rows)
    approved = sum(1 for r in rows if r.status == "approved")
    flagged  = sum(1 for r in rows if r.status == "flagged")
    pending  = sum(1 for r in rows if r.status in ("pending", "reviewed"))
    ai_prep  = sum(1 for r in rows if r.ai_commentary is not None)

    # We need account names to label the rows in the PDF. The status
    # rows themselves only carry qbo_account_id — join to the latest
    # gl_balance_snapshot for the period to grab account_name +
    # account_number + balance.
    from models.gl_balance_snapshot import GlBalanceSnapshot
    snaps = list((await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.period_end == period_end,
        )
    )).scalars().all())
    snap_by_id = {s.qbo_account_id: s for s in snaps}

    # Top variances by absolute size
    decorated: list[tuple[Decimal, dict]] = []
    flagged_list: list[dict] = []
    total_variance = Decimal("0")
    for r in rows:
        snap = snap_by_id.get(r.qbo_account_id)
        # Variance = GL − Subledger (recomputed here so it's always
        # consistent with what the dashboard shows; we don't store it
        # on AccountReviewStatus).
        gl  = Decimal(snap.balance) if snap and snap.balance is not None else Decimal("0")
        sub = Decimal(r.subledger_total) if r.subledger_total is not None else gl
        var = gl - sub
        total_variance += abs(var)
        record = {
            "account_name":   snap.account_name if snap else f"Account {r.qbo_account_id[:8]}",
            "account_number": (snap.account_number if snap else "") or "",
            "account_type":   snap.account_type if snap else "",
            "variance":       var,
            "gl_balance":     gl,
            "subledger_total": sub,
            "status":         r.status,
        }
        decorated.append((abs(var), record))
        if r.status == "flagged":
            note = (r.notes or "")[:240]
            flagged_list.append({
                "account_name":   record["account_name"],
                "account_number": record["account_number"],
                "notes":          note or "(no notes)",
            })

    decorated.sort(key=lambda t: t[0], reverse=True)
    top_variances = [d[1] for d in decorated[:8] if d[0] > Decimal("0.5")]

    return ReconSummary(
        total_accounts=total,
        approved_count=approved,
        flagged_count=flagged,
        pending_count=pending,
        total_variance=total_variance,
        top_variances=top_variances,
        flagged_items=flagged_list,
        ai_prepared_count=ai_prep,
    )


async def _gather_flux_highlights(
    db: AsyncSession, tenant_id, period_end: date,
) -> list[FluxHighlight]:
    """One FluxHighlight per flux analysis whose period_current falls in
    the closing month. The close gate already requires every flux for
    the month to be approved — so this is a clean list of approved work.

    Model chain (one row per TB → many Accounts → many Variances →
    optional Narrative):
        TrialBalance.id ←── Account.trial_balance_id
                            Account.id     ←── Variance.account_id
                                               Variance.id ←── Narrative.variance_id
    """
    from models.account import Account
    from models.narrative import Narrative
    from models.variance import Variance

    first = period_end.replace(day=1)
    tbs = list((await db.execute(
        select(TrialBalance).where(
            TrialBalance.period_current >= first,
            TrialBalance.period_current <= period_end,
        )
    )).scalars().all())

    out: list[FluxHighlight] = []
    for tb in tbs:
        # Approver name (best effort — falls back to email/uuid stub).
        approver_name: str | None = None
        if tb.approved_by:
            u = (await db.execute(
                select(User).where(User.id == tb.approved_by)
            )).scalar_one_or_none()
            if u:
                approver_name = u.email or f"User {str(u.id)[:8]}"

        # Pull all accounts + variances for this TB. Build a map for
        # fast join-in-Python; the row counts are tiny (≤ ~200 per TB).
        accounts = list((await db.execute(
            select(Account).where(Account.trial_balance_id == tb.id)
        )).scalars().all())
        acct_by_id = {a.id: a for a in accounts}

        variances = list((await db.execute(
            select(Variance).where(Variance.account_id.in_([a.id for a in accounts]))
        )).scalars().all()) if accounts else []

        narratives_by_var = {
            n.variance_id: n for n in
            (await db.execute(
                select(Narrative).where(Narrative.variance_id.in_([v.id for v in variances]))
            )).scalars().all()
        } if variances else {}

        material = [v for v in variances if v.is_material]
        material.sort(key=lambda v: abs(v.dollar_variance or Decimal("0")), reverse=True)

        top_var_rows: list[dict] = []
        for v in material[:5]:
            acc = acct_by_id.get(v.account_id)
            if not acc:
                continue
            narr = narratives_by_var.get(v.id)
            top_var_rows.append({
                "account_name":   acc.account_name or "",
                "account_number": acc.account_number or "",
                "current":        Decimal(acc.current_balance or 0),
                "prior":          Decimal(acc.prior_balance or 0),
                "absolute":       abs(v.dollar_variance or Decimal("0")),
                "change_pct":     (Decimal(v.pct_variance) if v.pct_variance is not None else None),
                "narrative":      (narr.content if narr else None),
            })

        out.append(FluxHighlight(
            name=tb.name or f"Analysis {str(tb.id)[:8]}",
            period_current=tb.period_current,
            period_prior=tb.period_prior,
            materiality_threshold=Decimal(str(tb.materiality_threshold or "0")),
            approved_by_name=approver_name,
            material_variance_count=len(material),
            top_variances=top_var_rows,
        ))
    return out


# ── AI narrative ────────────────────────────────────────────────────────────


_AI_SYSTEM_PROMPT = """\
You are a senior controller writing an executive summary for the company's CEO and CFO.

Your audience is business-focused — not technical accountants. They want to know:
  • What happened this month (in plain English)
  • What's working and what isn't
  • What they should pay attention to
  • What they should do next
  • What the next 30-90 days might look like

Be specific. Use the actual numbers from the data. Cite percentages,
dollar amounts, and account names where they help. Avoid hedging
("could potentially", "may indicate") — be direct.

You return ONE JSON object with this exact shape and nothing else:

{
  "executive_summary": "2-4 sentence overview of the period suitable to read aloud at a board meeting",
  "key_highlights": ["3-6 specific, fact-based bullets about the period"],
  "risks": ["2-4 specific risks visible in the data, ordered by severity"],
  "recommendations": ["3-5 concrete actions the company should take, ordered by impact"],
  "outlook": "2-3 sentence forward-looking statement based on the trends in the data"
}

Each bullet is one sentence, ≤ 35 words. No markdown. No leading dash or number.
Do not invent numbers — only cite what's in the data.
"""


_AI_CLIENT_SYSTEM_PROMPT = """\
You are a trusted advisor writing a monthly business review FOR THE BUSINESS OWNER — a smart, busy non-accountant.

Write in plain, warm, confident English. NO accounting jargon: if you reference a
metric, translate it to everyday terms — say "you have about 7 months of cash at
the current spend rate" not "runway is 7.0 months"; "customers take ~45 days to
pay" not "DSO is 45". Never use GAAP, accrual, reconciliation, flux, DSO, DPO, or
COGS without explaining them in plain words. Focus on what it means for THEIR
business and what to do next. Be encouraging but honest.

You return ONE JSON object with this exact shape and nothing else:

{
  "executive_summary": "2-4 warm, plain-English sentences a busy owner reads in 15 seconds",
  "key_highlights": ["3-6 plain-English wins or facts about the month"],
  "risks": ["2-4 things to keep an eye on, everyday language, most important first"],
  "recommendations": ["3-5 concrete, doable next steps, most impactful first"],
  "outlook": "2-3 plain-English sentences on what the next month or two could look like"
}

Each bullet is one sentence, ≤ 30 words. No markdown. No leading dash or number.
Use real numbers from the data but round to what an owner cares about. Do not invent numbers.
"""


def _serialize_for_ai(data: dict) -> str:
    """Convert Decimals to floats / dates to strings so json.dumps works."""
    def conv(v: Any) -> Any:
        if isinstance(v, Decimal): return float(v)
        if isinstance(v, (date, datetime)): return v.isoformat()
        if isinstance(v, dict): return {k: conv(x) for k, x in v.items()}
        if isinstance(v, list): return [conv(x) for x in v]
        return v
    return json.dumps(conv(data), indent=2)


def _build_ai_user_prompt(
    *, company: str, period_label: str, period_end: date,
    income_stmt, balance_sheet, cash_flow,
    insights: dict, recons: ReconSummary, flux: list[FluxHighlight],
) -> str:
    """Hand Claude a tight, structured snapshot of the period.

    We pre-summarize the largest numbers so the model doesn't have to
    sift through a 200-row JSON dump. Detail rows stay available
    (top variances, flagged items) for when the model wants to cite
    specifics in recommendations.
    """
    # Pull headline numbers off each statement. Statement.rows have
    # `current` as a string Decimal so we coerce.
    def row_value(stmt, label_match: str) -> Decimal | None:
        if not stmt:
            return None
        for r in stmt.rows:
            if r.label.strip().lower() == label_match.strip().lower() and r.current:
                try:
                    return Decimal(r.current)
                except Exception:
                    return None
        return None

    headline = {
        "revenue":       row_value(income_stmt, "Total Revenue")
                          or row_value(income_stmt, "Revenue"),
        "gross_profit":  row_value(income_stmt, "Gross Profit"),
        "operating_income": row_value(income_stmt, "Operating Income"),
        "net_income":    row_value(income_stmt, "Net Income"),
        "total_assets":  row_value(balance_sheet, "Total Assets"),
        "total_liabilities": row_value(balance_sheet, "Total Liabilities"),
        "total_equity":  row_value(balance_sheet, "Total Stockholders' Equity")
                          or row_value(balance_sheet, "Total Equity"),
    }
    headline_prior = {
        "revenue":       _prior(income_stmt, "Total Revenue") or _prior(income_stmt, "Revenue"),
        "net_income":    _prior(income_stmt, "Net Income"),
        "total_assets":  _prior(balance_sheet, "Total Assets"),
    }

    # Compress insights to the narrative-worthy fields
    liq = insights.get("liquidity") or {}
    prof = insights.get("profitability") or {}
    arap = insights.get("ar_ap") or {}
    expenses = insights.get("expenses") or {}

    flux_summary = [
        {
            "name":              f.name,
            "approved_by":       f.approved_by_name,
            "materiality":       f.materiality_threshold,
            "material_count":    f.material_variance_count,
            "top_variances":     [
                {
                    "account":   v["account_name"],
                    "current":   v["current"],
                    "prior":     v["prior"],
                    "change_pct": v["change_pct"],
                    "narrative": (v["narrative"] or "")[:600],
                } for v in f.top_variances
            ],
        } for f in flux
    ]

    payload = {
        "company":     company,
        "period":      period_label,
        "period_end":  period_end,
        "financial_headline": headline,
        "financial_prior":    headline_prior,
        "liquidity": {
            "cash_balance":   liq.get("cash_balance"),
            "monthly_burn":   liq.get("monthly_burn"),
            "runway_months":  liq.get("runway_months"),
            "operating_cash_flow": liq.get("operating_cash_flow"),
            "history":        (liq.get("history") or [])[-6:],
        },
        "profitability": {
            "revenue":              prof.get("revenue"),
            "gross_profit":         prof.get("gross_profit"),
            "gross_margin_pct":     prof.get("gross_margin_pct"),
            "operating_income":     prof.get("operating_income"),
            "operating_margin_pct": prof.get("operating_margin_pct"),
            "net_income":           prof.get("net_income"),
            "net_margin_pct":       prof.get("net_margin_pct"),
            "revenue_change_str":   prof.get("revenue_change_str"),
        },
        "ar_ap": {
            "dso":              arap.get("dso"),
            "dpo":              arap.get("dpo"),
            "ar_over_60_pct":   arap.get("ar_over_60_pct"),
            "ap_over_60_pct":   arap.get("ap_over_60_pct"),
        },
        "expenses": {
            "top_categories":   (expenses.get("top_categories") or [])[:6],
            "mom_movers":       (expenses.get("mom_movers") or [])[:5],
        },
        "reconciliations": {
            "total_accounts":   recons.total_accounts,
            "approved_count":   recons.approved_count,
            "flagged_count":    recons.flagged_count,
            "total_variance":   recons.total_variance,
            "top_variances":    [
                {
                    "account":  v["account_name"],
                    "variance": v["variance"],
                    "status":   v["status"],
                } for v in recons.top_variances[:5]
            ],
            "flagged_notes":    [f["notes"] for f in recons.flagged_items[:3]],
        },
        "flux_analyses": flux_summary,
    }

    return (
        f"Generate the executive report JSON for the period ending {period_end.isoformat()} "
        f"at {company}. Source data below:\n\n"
        + _serialize_for_ai(payload)
    )


def _prior(stmt, label: str) -> Decimal | None:
    if not stmt: return None
    for r in stmt.rows:
        if r.label.strip().lower() == label.strip().lower() and r.prior:
            try: return Decimal(r.prior)
            except Exception: return None
    return None


def _fallback_narrative(
    *, company: str, period_label: str,
    recons: ReconSummary, flux: list[FluxHighlight], insights: dict,
) -> AIReportNarrative:
    """Deterministic narrative built from the raw numbers. Used when
    the Claude call fails so the PDF still ships with something useful."""
    liq = insights.get("liquidity") or {}
    prof = insights.get("profitability") or {}
    runway = liq.get("runway_months")
    runway_str = (f"{runway:.1f} months" if isinstance(runway, (int, float)) else "indefinite")
    return AIReportNarrative(
        executive_summary=(
            f"{company} closed {period_label} with {recons.approved_count} of "
            f"{recons.total_accounts} balance-sheet accounts reconciled and "
            f"{len(flux)} flux analysis/analyses approved. "
            f"Net income was ${prof.get('net_income', 0):,.0f}, "
            f"with cash runway at {runway_str}."
        ),
        key_highlights=[
            f"{recons.approved_count} accounts reconciled; "
            f"{recons.flagged_count} flagged for follow-up.",
            f"{recons.ai_prepared_count} of {recons.total_accounts} accounts "
            f"reconciled with AI assistance.",
            f"Total reconciliation variance: ${recons.total_variance:,.0f}.",
            f"Cash on hand: ${liq.get('cash_balance', 0):,.0f}; "
            f"monthly burn: ${liq.get('monthly_burn', 0):,.0f}.",
            f"Gross margin {prof.get('gross_margin_pct', 0):.1f}%; "
            f"net margin {prof.get('net_margin_pct', 0):.1f}%.",
        ],
        risks=[
            "AI narrative service unavailable — review the financials directly.",
            f"{recons.flagged_count} reconciliation(s) require manual follow-up."
            if recons.flagged_count > 0 else "No critical risks flagged by the system.",
        ],
        recommendations=[
            "Review the financial statements and reconciliation flagged items.",
            "Re-run the executive report later for AI-generated insights.",
            "Confirm cash burn rate and runway with management.",
        ],
        outlook=(
            "Forward outlook unavailable in fallback mode. "
            "Re-generate this report once AI service is restored "
            "for a full forward-looking analysis."
        ),
    )


def generate_ai_commentary(
    *, company: str, period_label: str, period_end: date,
    income_stmt, balance_sheet, cash_flow,
    insights: dict, recons: ReconSummary, flux: list[FluxHighlight],
    audience: str = "internal",
) -> AIReportNarrative:
    """One Claude call. Parse JSON or fall back to a deterministic narrative.
    audience='client' switches to a plain-language, jargon-free tone for the
    business owner; 'internal' is the controller/board voice."""
    user_prompt = _build_ai_user_prompt(
        company=company, period_label=period_label, period_end=period_end,
        income_stmt=income_stmt, balance_sheet=balance_sheet, cash_flow=cash_flow,
        insights=insights, recons=recons, flux=flux,
    )
    is_client = audience == "client"
    system_prompt = _AI_CLIENT_SYSTEM_PROMPT if is_client else _AI_SYSTEM_PROMPT
    # Cache key folds in the audience — the two editions share the same data /
    # user_prompt, so without this the client + internal narratives collide.
    cache_key = hashlib.sha256(f"{audience}|{user_prompt}".encode()).hexdigest()
    try:
        response = generate_narrative(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            cache_key=cache_key,
            max_tokens=1500,
            operation="exec_report_client" if is_client else "exec_report",
        )
        raw = response.content.strip()
        # Be liberal about extra prose before/after the JSON block.
        first, last = raw.find("{"), raw.rfind("}")
        if first == -1 or last == -1:
            raise ValueError("No JSON object found in AI response")
        parsed = json.loads(raw[first:last + 1])
        # Defensive: enforce the contract — missing fields become empty.
        return AIReportNarrative(
            executive_summary=str(parsed.get("executive_summary") or "").strip(),
            key_highlights=[str(x).strip() for x in (parsed.get("key_highlights") or []) if str(x).strip()],
            risks=[str(x).strip() for x in (parsed.get("risks") or []) if str(x).strip()],
            recommendations=[str(x).strip() for x in (parsed.get("recommendations") or []) if str(x).strip()],
            outlook=str(parsed.get("outlook") or "").strip(),
        )
    except Exception:
        logger.exception("Executive-report AI call failed — falling back to deterministic narrative")
        return _fallback_narrative(
            company=company, period_label=period_label,
            recons=recons, flux=flux, insights=insights,
        )


# ── Public entry point ──────────────────────────────────────────────────────


async def gather_report_data(
    *, tenant_id, db: AsyncSession, period_end: date, audience: str = "internal",
) -> ExecReportData:
    """Pull every section of the executive report and call the AI.
    Returns a fully populated ExecReportData ready to hand to
    exec_pdf.build_executive_pdf. audience='client' yields a plain-language
    narrative for the business owner."""
    # ── Closed-period metadata ──────────────────────────────────────
    cp = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == period_end)
    )).scalar_one_or_none()
    if cp is None:
        # Caller should have gated already; defensive double-check.
        from fastapi import HTTPException
        raise HTTPException(
            status_code=403,
            detail="Books are not closed for this period — executive report unavailable.",
        )

    closed_by_name = "an admin"
    if cp.closed_by:
        u = (await db.execute(
            select(User).where(User.id == cp.closed_by)
        )).scalar_one_or_none()
        if u:
            closed_by_name = u.email or closed_by_name

    # ── Financial statements ────────────────────────────────────────
    from modules.financials.router import _build_statement
    warnings: list[str] = []
    income_stmt = await _build_statement(
        tenant_id, db, period_end, "income_statement",
        comparative=True, source="nordavix", comparative_basis="prior_month",
    )
    balance_sheet = await _build_statement(
        tenant_id, db, period_end, "balance_sheet",
        comparative=True, source="nordavix", comparative_basis="prior_month",
    )
    try:
        cash_flow = await _build_statement(
            tenant_id, db, period_end, "cash_flow",
            comparative=True, source="quickbooks",   # CF always live
            comparative_basis="prior_month",
        )
    except Exception as e:
        logger.warning("Cash flow statement unavailable for exec report: %s", e)
        cash_flow = None
        warnings.append("Cash Flow statement could not be pulled — QuickBooks unreachable at report time.")

    # ── Insights ────────────────────────────────────────────────────
    insights: dict[str, Any] = {}
    try:
        from modules.insights.service import compute_overview
        insights = await compute_overview(db, tenant_id, period_end)
    except Exception as e:
        logger.warning("Insights data unavailable for exec report: %s", e)
        warnings.append("Some insights metrics could not be computed for this report.")
        insights = {}

    # ── Recons + Flux ───────────────────────────────────────────────
    recons = await _gather_recon_summary(db, tenant_id, period_end)
    flux   = await _gather_flux_highlights(db, tenant_id, period_end)

    # ── Company name + period label ─────────────────────────────────
    company = income_stmt.company  # already resolved by _build_statement
    period_label = period_end.strftime("%B %Y")

    # ── AI narrative ────────────────────────────────────────────────
    # Single Claude call — wraps Anthropic SDK; ~5-15s typical latency.
    ai = generate_ai_commentary(
        company=company, period_label=period_label, period_end=period_end,
        income_stmt=income_stmt, balance_sheet=balance_sheet, cash_flow=cash_flow,
        insights=insights, recons=recons, flux=flux, audience=audience,
    )

    return ExecReportData(
        company=company,
        period_end=period_end,
        period_label=period_label,
        closed_at=cp.closed_at,
        closed_by_name=closed_by_name,
        income_statement=income_stmt,
        balance_sheet=balance_sheet,
        cash_flow=cash_flow,
        insights=insights,
        recons=recons,
        flux=flux,
        ai=ai,
        warnings=warnings,
    )
