"""
Financial Package API — Income Statement / Balance Sheet / Cash Flow.

  GET  /financials/income-statement?period_end=YYYY-MM-DD&comparative=true
  GET  /financials/balance-sheet?period_end=YYYY-MM-DD&comparative=true
  GET  /financials/cash-flow?period_end=YYYY-MM-DD&comparative=true
  GET  /financials/pdf?statement=is|bs|cf&period_end=YYYY-MM-DD
       — returns a Big-4 styled PDF. Only allowed when the period is
         closed (books locked) so the exported file reflects a frozen
         snapshot the firm has signed off on.

Each report endpoint returns a normalized `StatementOut` shape that
the frontend can render directly and the PDF generator can consume.
We pull data live from QuickBooks via the BalanceSheet, ProfitAndLoss,
and CashFlow report endpoints (one call per request, two when
comparative=true).
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


# ── Schemas ─────────────────────────────────────────────────────────────────

class StatementRow(BaseModel):
    label:        str
    current:      str | None         # numeric as string ("12345.67")
    prior:        str | None
    level:        int                 # nesting depth (0 = top-level)
    is_total:     bool = False        # bold + top border in UI / PDF
    is_subtotal:  bool = False        # italic + top border
    is_header:    bool = False        # section label, no values


class StatementSection(BaseModel):
    name:  str
    rows:  list[StatementRow]
    total: StatementRow | None = None


class StatementOut(BaseModel):
    statement:        str             # 'income_statement' | 'balance_sheet' | 'cash_flow'
    title:            str             # display title
    period_label:     str
    comparative_label:str | None
    period_end:       str
    comparative_end:  str | None
    company:          str
    sections:         list[StatementSection]
    # Computed footer line (Net Income / Total L+E / Net Change in Cash)
    footer:           StatementRow | None
    is_closed:        bool
    closed_at:        str | None


# ── Helpers ─────────────────────────────────────────────────────────────────

def _prior_month_end(pe: date) -> date:
    """Last day of the month one year before pe (for IS/CF comparative).
    BS uses last day of prior month for change context, but IS/CF
    convention is year-over-year for the prior column."""
    yr = pe.year - 1
    mo = pe.month
    last = monthrange(yr, mo)[1]
    return date(yr, mo, last)


def _ytd_start(pe: date) -> date:
    """First day of pe's calendar year — for YTD P&L / Cash Flow windows."""
    return date(pe.year, 1, 1)


def _walk_qbo_rows(report: dict) -> list[dict]:
    """
    QBO reports are deeply nested:
      Rows.Row[].Rows.Row[]... with optional Header / Summary cells per row.
    Flatten to a list of dicts:
      { "label": str, "values": [Decimal, ...], "level": int,
        "kind": "data" | "section_header" | "section_total" | "grand_total" }
    """
    out: list[dict] = []

    def walk(rows: list[dict], level: int) -> None:
        for r in rows:
            header = r.get("Header") or {}
            header_cells = header.get("ColData") or []
            summary = r.get("Summary") or {}
            summary_cells = summary.get("ColData") or []
            sub = (r.get("Rows") or {}).get("Row") or []
            cd  = r.get("ColData") or []
            rtype = (r.get("type") or "").strip().lower()
            group = (r.get("group") or "").strip().lower()

            # Section header — has a Header but no own data row
            if header_cells and (sub or summary_cells):
                label = (header_cells[0].get("value") or "").strip()
                if label:
                    out.append({"label": label, "values": [], "level": level, "kind": "section_header"})

            # Data row
            if cd:
                label = (cd[0].get("value") or "").strip()
                if label and rtype == "data":
                    vals = [_dec(c.get("value", "")) for c in cd[1:]]
                    out.append({"label": label, "values": vals, "level": level, "kind": "data"})

            # Recurse
            if sub:
                walk(sub, level + 1)

            # Summary (subtotal / total)
            if summary_cells:
                label = (summary_cells[0].get("value") or "").strip()
                if label:
                    vals = [_dec(c.get("value", "")) for c in summary_cells[1:]]
                    kind = "grand_total" if group in ("netincome", "totalassets",
                                                       "totalliabandequity") else "section_total"
                    out.append({"label": label, "values": vals, "level": level, "kind": kind})

    walk((report.get("Rows") or {}).get("Row") or [], 0)
    return out


def _flat_to_sections(flat: list[dict]) -> tuple[list[StatementSection], StatementRow | None]:
    """
    Convert the flat row list into StatementSections plus an optional
    footer (the grand-total row — Net Income / Total L+E / Net Change).

    Sectioning rule: a section header at level 0 starts a new section.
    Section ends when we hit the next level-0 section header OR the
    grand_total row at the end.
    """
    sections: list[StatementSection] = []
    footer: StatementRow | None = None

    cur_section: StatementSection | None = None
    for r in flat:
        kind = r["kind"]
        vals = r["values"]
        current = str(vals[0].quantize(Decimal("0.01"))) if len(vals) >= 1 else None
        prior   = str(vals[1].quantize(Decimal("0.01"))) if len(vals) >= 2 else None
        row = StatementRow(
            label=r["label"],
            current=current,
            prior=prior,
            level=r["level"],
            is_total=(kind == "section_total"),
            is_subtotal=False,
            is_header=(kind == "section_header"),
        )
        if kind == "section_header" and r["level"] == 0:
            # Close current and start new
            cur_section = StatementSection(name=r["label"], rows=[])
            sections.append(cur_section)
        elif kind == "grand_total" and r["level"] == 0:
            footer = StatementRow(
                label=r["label"], current=current, prior=prior,
                level=0, is_total=True, is_subtotal=False, is_header=False,
            )
        else:
            if cur_section is None:
                cur_section = StatementSection(name="(unsectioned)", rows=[])
                sections.append(cur_section)
            if kind == "section_total":
                if cur_section.total is None:
                    cur_section.total = row
                else:
                    cur_section.rows.append(row)
            else:
                cur_section.rows.append(row)
    return sections, footer


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
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    start = _ytd_start(pe)
    params: dict[str, Any] = {
        "start_date": start.isoformat(),
        "end_date":   pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion": "65",
    }
    if comparative:
        params["summarize_column_by"] = "Year"
    report = await _qbo_get(conn, db, "/reports/ProfitAndLoss", params=params)
    sections, footer = _flat_to_sections(_walk_qbo_rows(report))

    closed = await _is_period_closed(db, pe)
    return StatementOut(
        statement="income_statement",
        title="Income Statement",
        period_label=f"YTD {start.strftime('%b %d, %Y')} – {pe.strftime('%b %d, %Y')}",
        comparative_label=(_prior_month_end(pe).strftime("YTD %Y") if comparative else None),
        period_end=pe.isoformat(),
        comparative_end=_prior_month_end(pe).isoformat() if comparative else None,
        company=await _company_name(db, tenant_id),
        sections=sections,
        footer=footer,
        is_closed=closed is not None,
        closed_at=closed.closed_at.isoformat() if closed and closed.closed_at else None,
    )


@router.get("/balance-sheet", response_model=StatementOut)
async def get_balance_sheet(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    comparative: bool = Query(True),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    params: dict[str, Any] = {
        "end_date": pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion": "65",
    }
    if comparative:
        # BS comparative = same month last year — standard reporting convention.
        params["summarize_column_by"] = "Year"
    report = await _qbo_get(conn, db, "/reports/BalanceSheet", params=params)
    sections, footer = _flat_to_sections(_walk_qbo_rows(report))

    closed = await _is_period_closed(db, pe)
    return StatementOut(
        statement="balance_sheet",
        title="Balance Sheet",
        period_label=f"As of {pe.strftime('%b %d, %Y')}",
        comparative_label=(_prior_month_end(pe).strftime("As of %b %d, %Y") if comparative else None),
        period_end=pe.isoformat(),
        comparative_end=_prior_month_end(pe).isoformat() if comparative else None,
        company=await _company_name(db, tenant_id),
        sections=sections,
        footer=footer,
        is_closed=closed is not None,
        closed_at=closed.closed_at.isoformat() if closed and closed.closed_at else None,
    )


@router.get("/cash-flow", response_model=StatementOut)
async def get_cash_flow(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    comparative: bool = Query(True),
    db: AsyncSession = Depends(get_db),
) -> StatementOut:
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(409, "QuickBooks isn't connected.")

    start = _ytd_start(pe)
    params: dict[str, Any] = {
        "start_date": start.isoformat(),
        "end_date":   pe.isoformat(),
        "accounting_method": "Accrual",
        "minorversion": "65",
    }
    if comparative:
        params["summarize_column_by"] = "Year"
    report = await _qbo_get(conn, db, "/reports/CashFlow", params=params)
    sections, footer = _flat_to_sections(_walk_qbo_rows(report))

    closed = await _is_period_closed(db, pe)
    return StatementOut(
        statement="cash_flow",
        title="Statement of Cash Flows",
        period_label=f"YTD {start.strftime('%b %d, %Y')} – {pe.strftime('%b %d, %Y')}",
        comparative_label=(_prior_month_end(pe).strftime("YTD %Y") if comparative else None),
        period_end=pe.isoformat(),
        comparative_end=_prior_month_end(pe).isoformat() if comparative else None,
        company=await _company_name(db, tenant_id),
        sections=sections,
        footer=footer,
        is_closed=closed is not None,
        closed_at=closed.closed_at.isoformat() if closed and closed.closed_at else None,
    )


@router.get("/pdf")
async def export_pdf(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    statement: str = Query(..., description="is | bs | cf — or full"),
    period_end: str = Query(...),
    comparative: bool = Query(True),
    db: AsyncSession = Depends(get_db),
):
    """Big-4 styled PDF. Books must be closed for the requested period."""
    try: pe = date.fromisoformat(period_end)
    except ValueError: raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    closed = await _is_period_closed(db, pe)
    if closed is None:
        raise HTTPException(
            403,
            "Books for this period aren't closed yet. Close the books in "
            "Reconciliations before exporting the financial package.",
        )

    statement = statement.lower()
    statements: list[StatementOut] = []
    if statement in ("is", "income_statement"):
        statements.append(await get_income_statement(tenant_id, period_end, comparative, db))
    elif statement in ("bs", "balance_sheet"):
        statements.append(await get_balance_sheet(tenant_id, period_end, comparative, db))
    elif statement in ("cf", "cash_flow"):
        statements.append(await get_cash_flow(tenant_id, period_end, comparative, db))
    elif statement == "full":
        statements.append(await get_income_statement(tenant_id, period_end, comparative, db))
        statements.append(await get_balance_sheet(tenant_id, period_end, comparative, db))
        statements.append(await get_cash_flow(tenant_id, period_end, comparative, db))
    else:
        raise HTTPException(400, "statement must be is | bs | cf | full.")

    from modules.financials.pdf import build_pdf
    buf = io.BytesIO()
    company = statements[0].company if statements else "Your Company"
    build_pdf(buf, company=company, period_end=pe, statements=statements,
              prepared_by=user.email or "")
    buf.seek(0)
    fname = f"financial-package-{pe.isoformat()}.pdf"
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
