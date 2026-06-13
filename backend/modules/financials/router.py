"""
Financial Package API — Income Statement, Balance Sheet, Cash Flow.

Endpoints:
  GET  /financials/income-statement?period_end=…&comparative=true
  GET  /financials/balance-sheet?period_end=…&comparative=true
  GET  /financials/cash-flow?period_end=…&comparative=true
  GET  /financials/pdf?statement=is|bs|cf|full&period_end=…
       — audit-ready styled PDF. Books must be closed to export.

Design:
  • Statements return a FLAT list of `FinancialRow`s with explicit
    kind ('section_header', 'data', 'subtotal', 'total', 'computed',
    'grand_total') and a numeric level (indentation depth). The
    frontend and PDF generator render based on kind+level — no
    fragile "section grouping" in the data model.
  • Comparative period is fetched as a SEPARATE QBO call and merged
    row-by-row using a stable key (level + parent-path label). This
    works for all three reports — the alternative `summarize_column_by`
    parameter isn't supported by CashFlow and is inconsistent across
    P&L and BS depending on QBO version.
  • Labels coming out of QBO ("Income", "Cost of Goods Sold",
    "Bank Accounts", "TOTAL ASSETS") get rewritten to US-GAAP-style
    equivalents ("Revenue", "Cost of Sales", "Cash and Cash
    Equivalents", "Total Assets") via the GAAP_LABEL_MAP. Keeps the
    statements reading like an audited package.
"""
import base64
import io
import logging
import re
from calendar import monthrange
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.guard import enforce_ai_limits
from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from core.email.sender import send_email
from models.closed_period import ClosedPeriod
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from modules.recons.service import _dec, _qbo_get

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────

class FinancialRow(BaseModel):
    label:   str
    current: str | None
    prior:   str | None
    level:   int                     # 0 = top section; data rows deeper
    # kind drives rendering:
    #   section_header → uppercase, no values, navy
    #   data           → indented, plain
    #   subtotal       → bold, single top rule (within-section totals)
    #   total          → bold, single top rule (Total Current Assets etc.)
    #   computed       → bold, top rule (Gross Profit, Operating Income)
    #   grand_total    → bold + navy + double rule (Net Income, Total Assets)
    #   spacer         → blank row for breathing room
    kind:    str


class StatementOut(BaseModel):
    statement:         str
    title:             str
    subtitle:          str           # date range / "As of" text
    company:           str
    period_label:      str           # short header e.g. "YTD Apr 2026"
    comparative_label: str | None    # short header for the comparative column
    period_end:        str
    comparative_end:   str | None
    rows:              list[FinancialRow]
    is_closed:         bool
    closed_at:         str | None
    notes:             list[str]     # parser/source notes for footer disclosure
    # Statement-integrity check (Phase 2 trust sweep): {balanced, bs_diff,
    # cf_plug, unclassified_types, messages}. None on the live-QBO source
    # (no snapshot to cross-check against).
    validation:        dict | None = None


# ── GAAP label translation ──────────────────────────────────────────────────
#
# QBO uses everyday account names that don't quite read like an audited
# financial statement. These mappings rewrite the headline labels at the
# boundary so the user sees "Revenue" instead of "Income", "Cost of
# Sales" instead of "Cost of Goods Sold", etc. Only exact-match
# headline labels are translated — individual line-item account names
# (chart-of-accounts names) pass through untouched.

GAAP_LABEL_MAP: dict[str, str] = {
    # ── Income statement ──────────────────────────────
    "Income":                       "Revenue",
    "Total Income":                 "Total Revenue",
    "Cost of Goods Sold":           "Cost of Sales",
    "Total Cost of Goods Sold":     "Total Cost of Sales",
    "Gross Profit":                 "Gross Profit",
    "Expenses":                     "Operating Expenses",
    "Total Expenses":               "Total Operating Expenses",
    "Net Operating Income":         "Operating Income",
    "Other Income":                 "Other Income",
    "Total Other Income":           "Total Other Income",
    "Other Expense":                "Other Expense",
    "Other Expenses":               "Other Expense",
    "Total Other Expense":          "Total Other Expense",
    "Total Other Expenses":         "Total Other Expense",
    "Net Other Income":             "Other Income (Expense), net",
    "Net Income":                   "Net Income",
    # ── Balance sheet ─────────────────────────────────
    "ASSETS":                       "Assets",
    "Assets":                       "Assets",
    "Current Assets":               "Current Assets",
    "Bank Accounts":                "Cash and Cash Equivalents",
    "Total Bank Accounts":          "Total Cash and Cash Equivalents",
    "Accounts Receivable":          "Accounts Receivable, net",
    "Total Accounts Receivable":    "Total Accounts Receivable, net",
    "Other Current Assets":         "Prepaid Expenses and Other Current Assets",
    "Total Other Current Assets":   "Total Prepaid Expenses and Other Current Assets",
    "Total Current Assets":         "Total Current Assets",
    "Fixed Assets":                 "Property, Plant and Equipment, net",
    "Total Fixed Assets":           "Total Property, Plant and Equipment, net",
    "Other Assets":                 "Other Assets",
    "Total Other Assets":           "Total Other Assets",
    "TOTAL ASSETS":                 "Total Assets",
    "Total ASSETS":                 "Total Assets",
    "Liabilities and Equity":       "Liabilities and Stockholders' Equity",
    "LIABILITIES AND EQUITY":       "Liabilities and Stockholders' Equity",
    "Liabilities":                  "Liabilities",
    "Current Liabilities":          "Current Liabilities",
    "Accounts Payable":             "Accounts Payable",
    "Total Accounts Payable":       "Total Accounts Payable",
    "Credit Cards":                 "Credit Cards Payable",
    "Total Credit Cards":           "Total Credit Cards Payable",
    "Other Current Liabilities":    "Accrued and Other Current Liabilities",
    "Total Other Current Liabilities": "Total Accrued and Other Current Liabilities",
    "Total Current Liabilities":    "Total Current Liabilities",
    "Long-Term Liabilities":        "Long-Term Liabilities",
    "Long Term Liabilities":        "Long-Term Liabilities",
    "Total Long-Term Liabilities":  "Total Long-Term Liabilities",
    "Total Long Term Liabilities":  "Total Long-Term Liabilities",
    "Total Liabilities":            "Total Liabilities",
    "Equity":                       "Stockholders' Equity",
    "Total Equity":                 "Total Stockholders' Equity",
    "TOTAL LIABILITIES AND EQUITY": "Total Liabilities and Stockholders' Equity",
    "Total Liabilities and Equity": "Total Liabilities and Stockholders' Equity",
    # ── Cash flow ────────────────────────────────────
    "OPERATING ACTIVITIES":         "Cash Flows from Operating Activities",
    "Operating Activities":         "Cash Flows from Operating Activities",
    "Net cash provided by operating activities":
        "Net cash provided by (used in) operating activities",
    "Net Cash Provided by Operating Activities":
        "Net cash provided by (used in) operating activities",
    "INVESTING ACTIVITIES":         "Cash Flows from Investing Activities",
    "Investing Activities":         "Cash Flows from Investing Activities",
    "Net cash provided by investing activities":
        "Net cash provided by (used in) investing activities",
    "Net Cash Provided by Investing Activities":
        "Net cash provided by (used in) investing activities",
    "FINANCING ACTIVITIES":         "Cash Flows from Financing Activities",
    "Financing Activities":         "Cash Flows from Financing Activities",
    "Net cash provided by financing activities":
        "Net cash provided by (used in) financing activities",
    "Net Cash Provided by Financing Activities":
        "Net cash provided by (used in) financing activities",
    "Net cash increase for period": "Net Increase (Decrease) in Cash and Cash Equivalents",
    "Net Cash Increase for Period": "Net Increase (Decrease) in Cash and Cash Equivalents",
    "Cash at beginning of period":  "Cash and Cash Equivalents, Beginning of Period",
    "Cash at Beginning of Period":  "Cash and Cash Equivalents, Beginning of Period",
    "Cash at end of period":        "Cash and Cash Equivalents, End of Period",
    "Cash at End of Period":        "Cash and Cash Equivalents, End of Period",
}


def _gaap(label: str) -> str:
    """Translate a QBO label to GAAP-style when there's an exact match."""
    return GAAP_LABEL_MAP.get(label.strip(), label.strip())


# ── Period helpers ──────────────────────────────────────────────────────────

def _prior_year_period(pe: date) -> date:
    """Same month + day, one calendar year back."""
    yr = pe.year - 1
    last = monthrange(yr, pe.month)[1]
    return date(yr, pe.month, min(pe.day, last))


def _ytd_start(pe: date) -> date:
    return date(pe.year, 1, 1)


# ── QBO report parser ──────────────────────────────────────────────────────
#
# QBO reports are deeply nested:
#   { "Rows": { "Row": [
#       { "Header": {...}, "Rows": {...}, "Summary": {...}, "type": "Section" },
#       { "ColData": [...], "type": "Data" },
#       ...
#   ] } }
# Each Section row may contain nested Sections OR Data rows AND a
# Summary row at the bottom (the subtotal). Walk recursively, emitting
# flat ParsedRow tuples that capture (kind, level, label, values).

class _ParsedRow:
    __slots__ = ("kind", "level", "label", "values", "group", "path_key")
    def __init__(self, kind: str, level: int, label: str,
                 values: list[Decimal], group: str, path_key: str):
        self.kind, self.level, self.label = kind, level, label
        self.values, self.group, self.path_key = values, group, path_key


def _parse_qbo_report(report: dict) -> list[_ParsedRow]:
    """
    Walk the QBO report tree and emit a flat list of ParsedRow.
    `kind` is one of: section_header, data, total (subtotal of a
    Section), computed (group=GrossProfit / NetOperatingIncome /
    NetOtherIncome — calculated rows that aren't summaries of a
    section), grand_total (NetIncome, TotalAssets, etc.).
    `path_key` is the stable identifier used to merge comparative
    periods row-by-row.
    """
    out: list[_ParsedRow] = []

    def walk(rows: list[dict], level: int, path: list[str]) -> None:
        for r in rows:
            rtype  = (r.get("type")  or "").strip().lower()
            group  = (r.get("group") or "").strip()
            header = (r.get("Header") or {}).get("ColData") or []
            summary= (r.get("Summary") or {}).get("ColData") or []
            sub    = (r.get("Rows") or {}).get("Row") or []
            cd     = r.get("ColData") or []

            # Section row — has a Header and nested Rows. The Header
            # text is the section label; values live on the trailing
            # Summary row at the same level.
            if rtype == "section" or header:
                section_label = (header[0].get("value") or "").strip() if header else (group or "")
                new_path = path + [section_label]
                # Emit section header (don't if it's empty)
                if section_label:
                    out.append(_ParsedRow(
                        kind="section_header", level=level,
                        label=section_label, values=[],
                        group=group,
                        path_key="|".join(new_path) + "|HDR",
                    ))
                # Recurse into rows
                if sub:
                    walk(sub, level + 1, new_path)
                # Emit summary (total / subtotal)
                if summary:
                    sum_label = (summary[0].get("value") or "").strip()
                    sum_vals  = [_dec(c.get("value", "")) for c in summary[1:]]
                    # Classify by group: grand totals get special styling.
                    g = group.lower()
                    if g in ("netincome", "totalassets", "totalliabandequity",
                              "netcashincreaseforperiod"):
                        kind = "grand_total"
                    else:
                        kind = "total"
                    out.append(_ParsedRow(
                        kind=kind, level=level,
                        label=sum_label, values=sum_vals,
                        group=group,
                        path_key="|".join(new_path) + "|SUM",
                    ))
                continue

            # Computed row — QBO emits rows with group=GrossProfit etc.
            # as standalone rows BETWEEN sections (no nested rows). They're
            # calculated subtotals like Gross Profit, Operating Income.
            if group in ("GrossProfit", "NetOperatingIncome", "NetOtherIncome",
                          "NetCashChangeForPeriod") and cd:
                label = (cd[0].get("value") or "").strip()
                vals  = [_dec(c.get("value", "")) for c in cd[1:]]
                out.append(_ParsedRow(
                    kind="computed", level=level,
                    label=label, values=vals, group=group,
                    path_key="|".join(path) + f"|{group}",
                ))
                continue

            # Data row — leaf account
            if cd:
                label = (cd[0].get("value") or "").strip()
                if label:
                    vals = [_dec(c.get("value", "")) for c in cd[1:]]
                    if any(v != 0 for v in vals) or any(c.get("value") for c in cd[1:]):
                        out.append(_ParsedRow(
                            kind="data", level=level,
                            label=label, values=vals, group=group,
                            path_key="|".join(path + [label]),
                        ))

    walk((report.get("Rows") or {}).get("Row") or [], 0, [])
    return out


def _merge_periods(cur: list[_ParsedRow], prior: list[_ParsedRow]) -> list[FinancialRow]:
    """
    Merge current + prior period rows into one FinancialRow list. Rows
    are matched by path_key. Prior-only rows are dropped (rare — usually
    when an account was deleted between periods; we follow the current
    chart-of-accounts).
    """
    prior_by_key = {p.path_key: p for p in prior}
    out: list[FinancialRow] = []
    for r in cur:
        p = prior_by_key.get(r.path_key)
        cur_val   = str(r.values[0].quantize(Decimal("0.01"))) if r.values else None
        prior_val = (str(p.values[0].quantize(Decimal("0.01")))
                     if (p and p.values) else None)
        out.append(FinancialRow(
            label=_gaap(r.label),
            current=cur_val,
            prior=prior_val,
            level=r.level,
            kind=r.kind,
        ))
    return out


# ── Per-statement builders ──────────────────────────────────────────────────

async def _company_name(db: AsyncSession, tenant_id, conn: QboConnection | None = None) -> str:
    """
    Resolve the entity name that appears on every statement masthead.

    Source priority (per CPA feedback — workspace name wins):
      1. Tenant.name — the workspace name the user set when creating
         the company in our app (Companies panel). This is the
         user's authoritative name and overrides QBO. Skipped only
         when it's a Clerk-id fallback ("user_…" / "org_…").
      2. QboConnection.company_name — cached on connect; used when
         the workspace doesn't have a real name yet.
      3. Live QBO /companyinfo fetch (cached back to the conn row).
      4. Hard fallback "Your Company".

    Why workspace first: QBO sandboxes have generic names like
    "Sandbox Company US 1a65". The user set up the workspace
    intentionally — that's the name they want on their statements.
    """
    # 1. Workspace name
    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t and t.name and t.name.strip() and not t.name.startswith(("user_", "org_")):
        return t.name.strip()

    # 2. Cached on the connection
    if conn is None:
        conn = (await db.execute(
            select(QboConnection).where(QboConnection.tenant_id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
    if conn and conn.company_name and conn.company_name.strip():
        return conn.company_name.strip()

    # 3. Live fetch from QBO
    if conn:
        try:
            data = await _qbo_get(
                conn, db,
                f"/companyinfo/{conn.realm_id}",
                params={"minorversion": "65"},
            )
            ci = (data.get("CompanyInfo") or {})
            name = (ci.get("CompanyName") or ci.get("LegalName") or "").strip()
            if name:
                conn.company_name = name
                await db.commit()
                return name
        except Exception:
            logger.exception("CompanyInfo fetch failed")

    return "Your Company"


async def _is_period_closed(db: AsyncSession, pe: date) -> ClosedPeriod | None:
    return (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == pe)
    )).scalar_one_or_none()


async def _qbo_connection(db: AsyncSession, tenant_id) -> QboConnection:
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")
    return conn


async def _fetch_pl(conn: QboConnection, db: AsyncSession, pe: date,
                    ps: date | None = None) -> list[_ParsedRow]:
    """Pull P&L for [ps..pe]. If ps is None, defaults to YTD (Jan 1)."""
    start = ps or _ytd_start(pe)
    report = await _qbo_get(conn, db, "/reports/ProfitAndLoss", params={
        "start_date":        start.isoformat(),
        "end_date":          pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion":      "65",
    })
    return _parse_qbo_report(report)


async def _fetch_bs(conn: QboConnection, db: AsyncSession, pe: date) -> list[_ParsedRow]:
    """Balance Sheet is point-in-time — only end_date matters."""
    report = await _qbo_get(conn, db, "/reports/BalanceSheet", params={
        "end_date":          pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion":      "65",
    })
    return _parse_qbo_report(report)


async def _fetch_cf(conn: QboConnection, db: AsyncSession, pe: date,
                    ps: date | None = None) -> list[_ParsedRow]:
    """Pull Cash Flow for [ps..pe]. If ps is None, defaults to YTD (Jan 1)."""
    start = ps or _ytd_start(pe)
    report = await _qbo_get(conn, db, "/reports/CashFlow", params={
        "start_date":        start.isoformat(),
        "end_date":          pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion":      "65",
    })
    return _parse_qbo_report(report)


def _prior_year_range(ps: date, pe: date) -> tuple[date, date]:
    """Mirror a custom date range to the prior calendar year for comparatives.
    Same month + day on both ends, year - 1. Handles Feb 29 by snapping
    to Feb 28 in non-leap years."""
    def _shift(d: date) -> date:
        yr = d.year - 1
        last = monthrange(yr, d.month)[1]
        return date(yr, d.month, min(d.day, last))
    return _shift(ps), _shift(pe)


async def _build_statement(
    tenant_id, db, pe: date, statement_kind: str, comparative: bool,
    source: str = "quickbooks", period_start: date | None = None,
) -> StatementOut:
    """
    `source` controls where the underlying data comes from:
      • "quickbooks" — live QBO Reports API (default). Always matches
        what QBO would show; requires QBO to be reachable.
      • "nordavix"   — Built from gl_balance_snapshots captured on
        every reconciliations sync. Works offline; respects manual
        subledger overrides; deterministic GAAP layout.
        Cash Flow stays QBO-backed in this mode for now.
    """
    company = await _company_name(db, tenant_id)
    conn = None
    if source != "nordavix" or statement_kind == "cash_flow":
        conn = await _qbo_connection(db, tenant_id)
        # Pre-refresh the OAuth token BEFORE any QBO calls. Subsequent
        # calls inside this function share the same SQLAlchemy session —
        # concurrent commits inside the auto-refresh path used to cause
        # intermittent "Network Error" failures on PDF export.
        from modules.recons.service import _refresh_token_if_needed
        await _refresh_token_if_needed(conn, db)
        company = await _company_name(db, tenant_id, conn)

    # Period labelling — Income Statement and Cash Flow are "for a period
    # of time" (a range from period_start to period_end). Balance Sheet
    # is "as of a date" (single point in time). When the caller passes
    # an explicit period_start for IS/CF, we honor it; otherwise we
    # default to YTD (Jan 1). BS ignores period_start entirely.
    is_period_based = statement_kind in ("income_statement", "cash_flow")
    effective_ps: date | None = period_start if is_period_based else None
    if is_period_based and effective_ps is None:
        effective_ps = _ytd_start(pe)

    if statement_kind == "income_statement":
        title = "Income Statement"
        if period_start is not None:
            subtitle = (
                f"For the Period from {effective_ps.strftime('%B %d, %Y')} "
                f"to {pe.strftime('%B %d, %Y')}"
            )
            period_label = f"{effective_ps.strftime('%b %d')} – {pe.strftime('%b %d, %Y')}"
        else:
            subtitle = f"For the Year-to-Date Ended {pe.strftime('%B %d, %Y')}"
            period_label = f"YTD {pe.strftime('%b %Y')}"
    elif statement_kind == "balance_sheet":
        title = "Balance Sheet"
        subtitle = f"As of {pe.strftime('%B %d, %Y')}"
        period_label = pe.strftime("%b %d, %Y")
    elif statement_kind == "cash_flow":
        title = "Statement of Cash Flows"
        if period_start is not None:
            subtitle = (
                f"For the Period from {effective_ps.strftime('%B %d, %Y')} "
                f"to {pe.strftime('%B %d, %Y')}"
            )
            period_label = f"{effective_ps.strftime('%b %d')} – {pe.strftime('%b %d, %Y')}"
        else:
            subtitle = f"For the Year-to-Date Ended {pe.strftime('%B %d, %Y')}"
            period_label = f"YTD {pe.strftime('%b %Y')}"
    else:
        raise HTTPException(400, f"Unknown statement: {statement_kind}")
    # Prior-period mapping for the comparative column. For custom ranges,
    # mirror the EXACT range to the prior calendar year; for YTD, use
    # the prior YTD (same month-end last year).
    if period_start is not None and is_period_based:
        prior_ps, prior_pe = _prior_year_range(effective_ps, pe)
    else:
        prior_pe = _prior_year_period(pe)
        prior_ps = None  # YTD computes from Jan 1 of prior year automatically

    # Comparative column header — shared by both sources. Point-in-time for BS,
    # range-aware for IS / CF.
    if not comparative:
        comparative_label = None
    elif statement_kind == "balance_sheet":
        comparative_label = prior_pe.strftime("%b %d, %Y")
    elif period_start is not None:
        comparative_label = f"{prior_ps.strftime('%b %d')} – {prior_pe.strftime('%b %d, %Y')}"
    else:
        comparative_label = f"YTD {prior_pe.strftime('%b %Y')}"

    notes: list[str] = []

    # ── Nordavix-synced source (BS + IS + CF) ─────────────────────────
    # Build from the gl_balance_snapshots table populated on every recons
    # sync. Cash Flow is derived (indirect method) from beginning + ending
    # snapshots; when no beginning snapshot exists we fall through to QBO.
    if source == "nordavix" and statement_kind in ("balance_sheet", "income_statement", "cash_flow"):
        from modules.financials.internal import (
            build_balance_sheet as _bs_internal,
        )
        from modules.financials.internal import (
            build_cash_flow as _cf_internal,
        )
        from modules.financials.internal import (
            build_income_statement as _is_internal,
        )
        from modules.financials.internal import statement_validation
        rows_raw: list[dict] = []
        internal_notes: list[str] = []
        if statement_kind == "balance_sheet":
            rows_raw, internal_notes = await _bs_internal(
                db, tenant_id, pe, prior_pe if comparative else None)
        elif statement_kind == "income_statement":
            rows_raw, internal_notes = await _is_internal(
                db, tenant_id, pe, prior_pe if comparative else None,
                period_start=effective_ps, comparative_start=prior_ps)
        else:  # cash_flow
            rows_raw, internal_notes = await _cf_internal(
                db, tenant_id, pe,
                period_start=effective_ps,
                comparative_end=prior_pe if comparative else None,
                comparative_start=prior_ps)

        # Cash flow with no beginning snapshot → fall through to the QBO
        # block below (note carried). All other cases return here.
        if not (statement_kind == "cash_flow" and not rows_raw):
            notes.extend(internal_notes)
            # Normalize internal dict rows to FinancialRow, applying the same
            # GAAP label translator the QBO path uses for consistency.
            rows = [FinancialRow(
                label=_gaap(r["label"]),
                current=r["current"],
                prior=r["prior"],
                level=r["level"],
                kind=r["kind"],
            ) for r in rows_raw]
            closed = await _is_period_closed(db, pe)
            # Statement-integrity cross-check (period-wide; shared by all three
            # statements since they read the same snapshot).
            _val = await statement_validation(db, tenant_id, pe)
            return StatementOut(
                statement=statement_kind,
                title=title,
                subtitle=subtitle + " · Source: Nordavix synced data",
                company=company,
                period_label=period_label,
                comparative_label=comparative_label,
                period_end=pe.isoformat(),
                comparative_end=prior_pe.isoformat() if comparative else None,
                rows=rows,
                is_closed=closed is not None,
                closed_at=closed.closed_at.isoformat() if closed and closed.closed_at else None,
                notes=notes,
                validation=_val,
            )
        notes.extend(internal_notes)  # CF fallback — carry the explanatory note

    # ── QuickBooks source (live API) ─────────────────────────────────
    # period_start is honored for IS / CF (P&L-style reports) and
    # ignored for BS (point-in-time).
    cur_rows: list[_ParsedRow] = []
    prior_rows: list[_ParsedRow] = []
    try:
        if statement_kind == "income_statement":
            cur_rows = await _fetch_pl(conn, db, pe, effective_ps)
        elif statement_kind == "balance_sheet":
            cur_rows = await _fetch_bs(conn, db, pe)
        else:
            cur_rows = await _fetch_cf(conn, db, pe, effective_ps)
    except Exception as e:
        logger.exception("Current fetch failed for %s @ %s", statement_kind, pe)
        raise HTTPException(502, "Could not pull statement data from QuickBooks. Try again.") from e
    if comparative:
        try:
            if statement_kind == "income_statement":
                prior_rows = await _fetch_pl(conn, db, prior_pe, prior_ps)
            elif statement_kind == "balance_sheet":
                prior_rows = await _fetch_bs(conn, db, prior_pe)
            else:
                prior_rows = await _fetch_cf(conn, db, prior_pe, prior_ps)
        except Exception:
            logger.warning("Comparative fetch failed for %s @ %s — continuing without it",
                            statement_kind, prior_pe)
            notes.append("Prior-year comparative could not be loaded.")

    # comparative_label was computed once above and is shared by both sources.
    merged = _merge_periods(cur_rows, prior_rows)
    closed = await _is_period_closed(db, pe)
    return StatementOut(
        statement=statement_kind,
        title=title,
        subtitle=subtitle,
        company=company,
        period_label=period_label,
        comparative_label=comparative_label,
        period_end=pe.isoformat(),
        comparative_end=prior_pe.isoformat() if comparative else None,
        rows=merged,
        is_closed=closed is not None,
        closed_at=closed.closed_at.isoformat() if closed and closed.closed_at else None,
        notes=notes,
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

def _parse_period_start(
    period_start: str | None, pe: date,
) -> date | None:
    """Validate an optional custom period_start. Returns parsed date or
    None for "use YTD default". Raises 400 on bad input."""
    if not period_start:
        return None
    try:
        ps = date.fromisoformat(period_start)
    except ValueError:
        raise HTTPException(400, "period_start must be YYYY-MM-DD.")
    if ps > pe:
        raise HTTPException(400, "period_start must be on or before period_end.")
    return ps


@router.get("/income-statement", response_model=StatementOut)
async def get_income_statement(
    tenant_id: CurrentTenantId,
    period_end:   str        = Query(...),
    period_start: str | None = Query(None, description="Optional custom start date (defaults to YTD)"),
    comparative:  bool       = Query(True),
    source:       str        = Query("quickbooks", description="quickbooks | nordavix"),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    ps = _parse_period_start(period_start, pe)
    return await _build_statement(
        tenant_id, db, pe, "income_statement", comparative,
        source=source, period_start=ps,
    )


@router.get("/balance-sheet", response_model=StatementOut)
async def get_balance_sheet(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    comparative: bool = Query(True),
    source: str = Query("quickbooks", description="quickbooks | nordavix"),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    # Balance Sheet is point-in-time — no period_start. Anyone passing
    # one gets it silently ignored (no error — keeps the URL ergonomics
    # consistent when the same UI submits all three together).
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    return await _build_statement(tenant_id, db, pe, "balance_sheet", comparative, source=source)


@router.get("/cash-flow", response_model=StatementOut)
async def get_cash_flow(
    tenant_id: CurrentTenantId,
    period_end:   str        = Query(...),
    period_start: str | None = Query(None, description="Optional custom start date (defaults to YTD)"),
    comparative:  bool       = Query(True),
    source:       str        = Query("quickbooks", description="quickbooks | nordavix"),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    ps = _parse_period_start(period_start, pe)
    return await _build_statement(
        tenant_id, db, pe, "cash_flow", comparative,
        source=source, period_start=ps,
    )


@router.get("/pdf")
async def export_pdf(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    statement: str = Query(..., description="is | bs | cf | full"),
    period_end: str = Query(...),
    comparative: bool = Query(True),
    draft: bool = Query(False, description="Allow draft export for unclosed period; PDF will be watermarked"),
    source: str = Query("quickbooks", description="quickbooks | nordavix"),
    db: AsyncSession = Depends(get_db),
):
    """Returns a audit-ready styled PDF. Closed periods produce a clean final
    version; unclosed periods can be exported as DRAFT with watermark."""
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    closed = await _is_period_closed(db, pe)
    if closed is None and not draft:
        raise HTTPException(
            403,
            "Books for this period aren't closed. Close them in Reconciliations, "
            "or re-export with draft=true for a watermarked draft.",
        )

    statement = statement.lower()
    if statement in ("is", "income_statement"):
        kinds = ["income_statement"]
    elif statement in ("bs", "balance_sheet"):
        kinds = ["balance_sheet"]
    elif statement in ("cf", "cash_flow"):
        kinds = ["cash_flow"]
    elif statement == "full":
        kinds = ["income_statement", "balance_sheet", "cash_flow"]
    else:
        raise HTTPException(400, "statement must be is | bs | cf | full.")
    # Wrap the whole build in explicit error capture so the user sees a
    # useful message in the UI instead of a generic axios "Network Error".
    # Logs the full traceback for our own debugging. Each stage logs its
    # own start/end so when something hangs we can see which stage
    # consumed the time.
    logger.info("PDF export start: tenant=%s period=%s source=%s kinds=%s",
                tenant_id, pe, source, kinds)
    try:
        # Sequential builds — see note in _build_statement about the
        # SQLAlchemy session race that asyncio.gather triggers.
        statements: list[StatementOut] = []
        for k in kinds:
            logger.info("PDF export: building %s", k)
            statements.append(await _build_statement(tenant_id, db, pe, k, comparative, source=source))

        logger.info("PDF export: rendering PDF (%d statements)", len(statements))
        from modules.financials.pdf import build_pdf
        buf = io.BytesIO()
        company = statements[0].company if statements else "Your Company"
        # Watermark as DRAFT when the period is unclosed OR any statement fails
        # its integrity check (doesn't balance) — never let a broken statement
        # leave the building looking clean.
        _is_draft = (closed is None) or any(
            not (s.validation or {}).get("balanced", True) for s in statements
        )
        build_pdf(
            buf,
            company=company,
            period_end=pe,
            statements=statements,
            prepared_by=user.email or "",
            is_draft=_is_draft,
        )
        buf.seek(0)
        label = "draft-" if _is_draft else ""
        fname = f"{label}financial-package-{pe.isoformat()}.pdf"
        logger.info("PDF export done: %d bytes", buf.getbuffer().nbytes)
        return StreamingResponse(
            buf, media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )
    except HTTPException:
        # Already a user-shaped error (401, 403, 502 from QBO failures
        # inside _build_statement) — let FastAPI handle it normally so
        # the frontend's error reader sees a real detail string.
        raise
    except Exception as exc:
        logger.exception("PDF export failed for tenant=%s period=%s source=%s",
                          tenant_id, pe, source)
        # Surface the real failure to the user — never leave them with
        # the browser's generic "Network Error".
        raise HTTPException(
            status_code=500,
            detail=f"PDF generation failed: {type(exc).__name__}: {str(exc)[:200]}",
        ) from exc


@router.get("/executive-report", dependencies=[Depends(enforce_ai_limits)])
async def export_executive_report(
    tenant_id: CurrentTenantId,
    user: CurrentUser,           # noqa: ARG001 — currently unused, here for auth + future audit log
    period_end: str = Query(..., description="Period end YYYY-MM-DD (books must be closed)"),
    audience: str = Query("internal", description="internal (board package) | client (plain-language business review)"),
    db: AsyncSession = Depends(get_db),
):
    """
    Build and stream the **Executive Financial Report** PDF for a closed
    period. Pulls every workspace surface — financials, insights, recons,
    flux — runs a single Claude call for the narrative sections, and
    renders a multi-page, board-ready document.

    Gates:
      • Period must be CLOSED (books locked). If not closed, returns 403
        — the report is meant as a final close deliverable, not a draft.
      • Generation typically takes 10–30 seconds because of the live QBO
        pulls + AI call. Frontend should show a spinner.

    The endpoint is NOT admin-only — anyone who can see the workspace can
    download the report. The audit trail is on the *close* action; the
    report itself is read-only.
    """
    aud = "client" if audience == "client" else "internal"
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    closed = await _is_period_closed(db, pe)
    if closed is None:
        raise HTTPException(
            status_code=403,
            detail=(
                "Executive report is only available after books are closed for the period. "
                "Close them on the dashboard's Month-End Close Progress card first."
            ),
        )

    logger.info("Executive report build start: tenant=%s period=%s audience=%s", tenant_id, pe, aud)
    try:
        from modules.financials.exec_pdf import build_executive_pdf
        from modules.financials.exec_report import gather_report_data

        data = await gather_report_data(tenant_id=tenant_id, db=db, period_end=pe, audience=aud)

        # Persist the board recommendations as trackable advisory items (the
        # internal edition is canonical; the client edition reuses the same
        # data so we don't double-write). Best-effort — never break the export.
        if aud == "internal":
            try:
                from modules.advisory.service import persist_exec_recommendations
                await persist_exec_recommendations(db, tenant_id, pe, data.ai.recommendations)
            except Exception:
                logger.warning("Could not persist exec recommendations for tenant=%s period=%s", tenant_id, pe)
                # A failed flush (e.g. read-only demo tenant) leaves the session
                # in a needs-rollback state — clear it so the rest of the request
                # (and session teardown) stays healthy.
                try:
                    await db.rollback()
                except Exception:
                    pass

        buf = io.BytesIO()
        build_executive_pdf(buf, data=data, audience=aud)
        buf.seek(0)
        # Clean filename: ExecutiveReport_Acme-Corp_April-2026.pdf
        safe_co = "".join(c if c.isalnum() else "-" for c in data.company)[:40].strip("-") or "Company"
        kind = "BusinessReview" if aud == "client" else "ExecutiveReport"
        fname = f"{kind}_{safe_co}_{pe.strftime('%B-%Y')}.pdf"
        logger.info("Executive report done: %d bytes for tenant=%s period=%s",
                    buf.getbuffer().nbytes, tenant_id, pe)
        return StreamingResponse(
            buf, media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Executive report failed for tenant=%s period=%s", tenant_id, pe)
        raise HTTPException(
            status_code=500,
            detail=f"Executive report failed: {type(exc).__name__}: {str(exc)[:240]}",
        ) from exc


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SendReportBody(BaseModel):
    recipient_email: str
    recipient_name: str | None = None
    audience: str = "client"


def _send_report_html(*, company: str, period_label: str, recipient_name: str | None) -> str:
    greeting = f"Hi {recipient_name}," if recipient_name else "Hi,"
    return f"""\
<div style="background:#F4F1E9;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #E6E4DF;overflow:hidden;">
    <div style="background:#0C2620;padding:18px 28px;">
      <span style="color:#F4F1E9;font-size:15px;font-weight:700;">nordavix<span style="color:#9CC4AD;">.</span></span>
      <span style="float:right;color:#9CC4AD;font-size:10px;letter-spacing:0.16em;font-weight:700;">BUSINESS REVIEW</span>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 6px;color:#8A8F98;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">{company} · {period_label}</p>
      <h1 style="margin:0 0 10px;color:#14181A;font-size:20px;line-height:1.3;">Your {period_label} business review</h1>
      <p style="margin:0 0 14px;color:#3C4146;font-size:13.5px;line-height:1.6;">{greeting}</p>
      <p style="margin:0 0 14px;color:#3C4146;font-size:13.5px;line-height:1.6;">
        Your monthly business review for <strong>{company}</strong> is attached as a PDF —
        a plain-English look at how the month went, what's working, what to watch, and what we'd suggest next.
      </p>
      <p style="margin:0;color:#8A8F98;font-size:12px;line-height:1.6;">Prepared with Nordavix.</p>
    </div>
  </div>
</div>"""


@router.post("/executive-report/send", dependencies=[Depends(enforce_ai_limits)])
async def send_executive_report(
    body: SendReportBody,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD (books must be closed)"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Email the report (client edition by default) to a client as a PDF
    attachment. Books must be closed. Outward-facing — the firm user triggers
    it; we record it in the audit trail."""
    recipient = (body.recipient_email or "").strip()
    if not _EMAIL_RE.match(recipient):
        raise HTTPException(status_code=422, detail="Enter a valid recipient email address.")
    aud = "internal" if body.audience == "internal" else "client"
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    if await _is_period_closed(db, pe) is None:
        raise HTTPException(status_code=403, detail="Close the books for this period before sending the report.")

    from modules.financials.exec_pdf import build_executive_pdf
    from modules.financials.exec_report import gather_report_data
    try:
        data = await gather_report_data(tenant_id=tenant_id, db=db, period_end=pe, audience=aud)
        buf = io.BytesIO()
        build_executive_pdf(buf, data=data, audience=aud)
        pdf_bytes = buf.getvalue()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Send-report build failed tenant=%s period=%s", tenant_id, pe)
        raise HTTPException(status_code=500, detail=f"Could not build the report: {type(exc).__name__}") from exc

    safe_co = "".join(c if c.isalnum() else "-" for c in data.company)[:40].strip("-") or "Company"
    kind = "BusinessReview" if aud == "client" else "ExecutiveReport"
    fname = f"{kind}_{safe_co}_{pe.strftime('%B-%Y')}.pdf"
    sent = await send_email(
        to=recipient,
        subject=f"{data.company} — {data.period_label} business review",
        html=_send_report_html(company=data.company, period_label=data.period_label,
                               recipient_name=body.recipient_name),
        text=(f"{('Hi ' + body.recipient_name) if body.recipient_name else 'Hi'},\n\n"
              f"Your {data.period_label} business review for {data.company} is attached.\n\n"
              f"Prepared with Nordavix."),
        attachments=[{
            "filename": fname,
            "content": base64.b64encode(pdf_bytes).decode("ascii"),
            "content_type": "application/pdf",
        }],
    )
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="financials.report_sent", entity_type="period", entity_id=None,
        metadata={"summary": f"Emailed the {data.period_label} {aud} report to {recipient}"},
    )
    await db.commit()
    if not sent:
        raise HTTPException(status_code=502, detail="Email isn't configured, or the send failed. Check email settings.")
    return {"sent": True, "recipient": recipient, "period_label": data.period_label}
