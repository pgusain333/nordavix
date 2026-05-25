"""
Financial Package API — Income Statement, Balance Sheet, Cash Flow.

Endpoints:
  GET  /financials/income-statement?period_end=…&comparative=true
  GET  /financials/balance-sheet?period_end=…&comparative=true
  GET  /financials/cash-flow?period_end=…&comparative=true
  GET  /financials/pdf?statement=is|bs|cf|full&period_end=…
       — Big-4 styled PDF. Books must be closed to export.

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
import io
import logging
from calendar import monthrange
from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
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

async def _company_name(db: AsyncSession, tenant_id) -> str:
    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    return (t.name if t else "") or "Your Company"


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


async def _fetch_pl(conn: QboConnection, db: AsyncSession, pe: date) -> list[_ParsedRow]:
    start = _ytd_start(pe)
    report = await _qbo_get(conn, db, "/reports/ProfitAndLoss", params={
        "start_date":        start.isoformat(),
        "end_date":          pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion":      "65",
    })
    return _parse_qbo_report(report)


async def _fetch_bs(conn: QboConnection, db: AsyncSession, pe: date) -> list[_ParsedRow]:
    report = await _qbo_get(conn, db, "/reports/BalanceSheet", params={
        "end_date":          pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion":      "65",
    })
    return _parse_qbo_report(report)


async def _fetch_cf(conn: QboConnection, db: AsyncSession, pe: date) -> list[_ParsedRow]:
    start = _ytd_start(pe)
    report = await _qbo_get(conn, db, "/reports/CashFlow", params={
        "start_date":        start.isoformat(),
        "end_date":          pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion":      "65",
    })
    return _parse_qbo_report(report)


async def _build_statement(
    tenant_id, db, pe: date, statement_kind: str, comparative: bool,
) -> StatementOut:
    conn = await _qbo_connection(db, tenant_id)
    company = await _company_name(db, tenant_id)

    if statement_kind == "income_statement":
        title = "Income Statement"
        subtitle = f"For the Year-to-Date Ended {pe.strftime('%B %d, %Y')}"
        period_label = f"YTD {pe.strftime('%b %Y')}"
        fetch_fn, prior_pe = _fetch_pl, _prior_year_period(pe)
    elif statement_kind == "balance_sheet":
        title = "Balance Sheet"
        subtitle = f"As of {pe.strftime('%B %d, %Y')}"
        period_label = pe.strftime("%b %d, %Y")
        fetch_fn, prior_pe = _fetch_bs, _prior_year_period(pe)
    elif statement_kind == "cash_flow":
        title = "Statement of Cash Flows"
        subtitle = f"For the Year-to-Date Ended {pe.strftime('%B %d, %Y')}"
        period_label = f"YTD {pe.strftime('%b %Y')}"
        fetch_fn, prior_pe = _fetch_cf, _prior_year_period(pe)
    else:
        raise HTTPException(400, f"Unknown statement: {statement_kind}")

    cur_rows = await fetch_fn(conn, db, pe)
    prior_rows: list[_ParsedRow] = []
    notes: list[str] = []
    if comparative:
        try:
            prior_rows = await fetch_fn(conn, db, prior_pe)
        except Exception:
            logger.exception("Comparative fetch failed for %s @ %s", statement_kind, prior_pe)
            notes.append("Prior-year comparative could not be loaded.")

    merged = _merge_periods(cur_rows, prior_rows)
    closed = await _is_period_closed(db, pe)
    return StatementOut(
        statement=statement_kind,
        title=title,
        subtitle=subtitle,
        company=company,
        period_label=period_label,
        comparative_label=(prior_pe.strftime("%b %d, %Y") if comparative else None) if statement_kind == "balance_sheet"
                          else (f"YTD {prior_pe.strftime('%b %Y')}" if comparative else None),
        period_end=pe.isoformat(),
        comparative_end=prior_pe.isoformat() if comparative else None,
        rows=merged,
        is_closed=closed is not None,
        closed_at=closed.closed_at.isoformat() if closed and closed.closed_at else None,
        notes=notes,
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/income-statement", response_model=StatementOut)
async def get_income_statement(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    comparative: bool = Query(True),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    return await _build_statement(tenant_id, db, pe, "income_statement", comparative)


@router.get("/balance-sheet", response_model=StatementOut)
async def get_balance_sheet(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    comparative: bool = Query(True),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    return await _build_statement(tenant_id, db, pe, "balance_sheet", comparative)


@router.get("/cash-flow", response_model=StatementOut)
async def get_cash_flow(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    comparative: bool = Query(True),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    return await _build_statement(tenant_id, db, pe, "cash_flow", comparative)


@router.get("/pdf")
async def export_pdf(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    statement: str = Query(..., description="is | bs | cf | full"),
    period_end: str = Query(...),
    comparative: bool = Query(True),
    draft: bool = Query(False, description="Allow draft export for unclosed period; PDF will be watermarked"),
    db: AsyncSession = Depends(get_db),
):
    """Returns a Big-4 styled PDF. Closed periods produce a clean final
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
    statements: list[StatementOut] = []
    if statement in ("is", "income_statement"):
        statements.append(await _build_statement(tenant_id, db, pe, "income_statement", comparative))
    elif statement in ("bs", "balance_sheet"):
        statements.append(await _build_statement(tenant_id, db, pe, "balance_sheet", comparative))
    elif statement in ("cf", "cash_flow"):
        statements.append(await _build_statement(tenant_id, db, pe, "cash_flow", comparative))
    elif statement == "full":
        statements.append(await _build_statement(tenant_id, db, pe, "income_statement", comparative))
        statements.append(await _build_statement(tenant_id, db, pe, "balance_sheet", comparative))
        statements.append(await _build_statement(tenant_id, db, pe, "cash_flow", comparative))
    else:
        raise HTTPException(400, "statement must be is | bs | cf | full.")

    from modules.financials.pdf import build_pdf
    buf = io.BytesIO()
    company = statements[0].company if statements else "Your Company"
    build_pdf(
        buf,
        company=company,
        period_end=pe,
        statements=statements,
        prepared_by=user.email or "",
        is_draft=(closed is None),
    )
    buf.seek(0)
    label = "draft-" if closed is None else ""
    fname = f"{label}financial-package-{pe.isoformat()}.pdf"
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
