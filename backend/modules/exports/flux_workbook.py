"""
Flux variance analysis workbook (.xlsx).

Single sheet of variances (Account, Category, Current, Prior, $ Δ, % Δ,
status, AI commentary) with cover sheet. Uses the same xlsx_builder
named styles as Period Export for visual consistency.
"""
from __future__ import annotations

import logging
import re
import uuid
from decimal import Decimal
from io import BytesIO

from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account import Account
from models.narrative import Narrative
from models.trial_balance import TrialBalance
from models.variance import Variance
from modules.exports.period_workbook import build_cover_sheet
from modules.exports.xlsx_builder import (
    add_sheet_title,
    fmt_date,
    freeze_header,
    register_styles,
    safe_dec,
    set_column_widths,
    write_row,
    write_table_header,
)

logger = logging.getLogger(__name__)


async def build_flux_workbook(
    *,
    db: AsyncSession,
    tb_id: uuid.UUID,
    company_name: str,
    generated_by_name: str,
) -> tuple[bytes, str]:
    """Build the flux variance workbook + return (bytes, suggested_filename)."""
    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.id == tb_id)
    )).scalar_one_or_none()
    if tb is None:
        raise ValueError("Trial balance not found")

    wb = Workbook()
    register_styles(wb)
    if wb.active is not None:
        wb.remove(wb.active)

    period_label = (
        f"Current {fmt_date(tb.period_current)} vs prior {fmt_date(tb.period_prior)}"
    )

    build_cover_sheet(
        wb,
        company_name=company_name,
        package_title="Flux Variance Analysis",
        period_label=period_label,
        generated_by=generated_by_name,
        contents_text=(
            f"Analysis: {tb.name} · Materiality threshold "
            f"${float(tb.materiality_threshold):,.0f} · Status {tb.status}"
        ),
        footer_text=(
            "Variances are calculated as Current − Prior. AI commentary is included "
            "where generated. Rows are sorted by material first, then by absolute "
            "dollar variance descending."
        ),
    )

    await _build_variances_sheet(wb, db, tb_id)

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)

    # Filename
    safe_company = re.sub(r"[^A-Za-z0-9 _-]+", "", company_name or "").strip()
    safe_company = re.sub(r"\s+", "_", safe_company)[:50] or "Nordavix"
    fname = f"{safe_company}_flux_{tb.period_current.isoformat()}.xlsx"

    return buf.read(), fname


async def _build_variances_sheet(
    wb: Workbook, db: AsyncSession, tb_id: uuid.UUID,
) -> None:
    ws = wb.create_sheet("Variance Analysis")

    stmt = (
        select(Variance, Account, Narrative)
        .join(Account, Variance.account_id == Account.id)
        .outerjoin(Narrative, Narrative.variance_id == Variance.id)
        .where(Account.trial_balance_id == tb_id)
        .order_by(Variance.is_material.desc(), Variance.dollar_variance.desc())
    )
    rows = (await db.execute(stmt)).all()

    header_row = add_sheet_title(
        ws, "Variance Analysis",
        subtitle="Current vs prior — material flagged, sorted by $ variance",
    )
    headers = [
        "Acct #", "Account", "Category", "FS Line",
        "Current", "Prior", "$ Variance", "% Variance",
        "Material", "Status", "AI Commentary",
    ]
    set_column_widths(ws, [10, 30, 14, 18, 14, 14, 14, 12, 10, 12, 50])
    write_table_header(ws, header_row, headers)
    freeze_header(ws, header_row)

    if not rows:
        write_row(ws, header_row + 1, [
            ("No variances on this analysis.", "nx_cell_muted"),
            *[("", "nx_cell_text") for _ in range(10)],
        ])
        return

    sum_cur = sum_pri = sum_var = Decimal("0")
    r = header_row + 1
    for var, acct, narr in rows:
        cur = safe_dec(acct.current_balance)
        pri = safe_dec(acct.prior_balance)
        dvar = safe_dec(var.dollar_variance)
        sum_cur += cur
        sum_pri += pri
        sum_var += dvar

        # % variance: stored as decimal proportion (0.123 = 12.3%) — verify
        pct = float(var.pct_variance) if var.pct_variance is not None else None
        # Heuristic: backend persists % as a ratio (0.12) so format as percent.
        # If pct is wildly large (>10), it's already in % form — divide.
        if pct is not None and abs(pct) > 10:
            pct = pct / 100.0

        # AI commentary: prefer the structured ai_commentary narrative if present,
        # otherwise fall back to the legacy Narrative.content.
        commentary = ""
        if isinstance(var.ai_commentary, dict):
            commentary = var.ai_commentary.get("narrative") or ""
        if not commentary and narr is not None:
            commentary = narr.content or ""

        write_row(ws, r, [
            (acct.account_number or "",                    "nx_cell_text"),
            (acct.account_name or "",                      "nx_cell_text"),
            (acct.fs_category or "",                       "nx_cell_text"),
            (acct.fs_line or "",                           "nx_cell_text"),
            (cur,                                           "nx_cell_money"),
            (pri,                                           "nx_cell_money"),
            (dvar,                                          "nx_cell_money"),
            (pct if pct is not None else "",               "nx_cell_pct" if pct is not None else "nx_cell_text"),
            ("Yes" if var.is_material else "No",            "nx_cell_text"),
            ((var.status or "pending").title(),             "nx_cell_text"),
            (commentary,                                    "nx_cell_muted"),
        ])
        r += 1

    # Totals row
    write_row(ws, r, [
        ("", "nx_total_label"),
        ("TOTAL", "nx_total_label"),
        ("", "nx_total_label"),
        ("", "nx_total_label"),
        (sum_cur, "nx_total_money"),
        (sum_pri, "nx_total_money"),
        (sum_var, "nx_total_money"),
        ("", "nx_total_label"),
        ("", "nx_total_label"),
        ("", "nx_total_label"),
        ("", "nx_total_label"),
    ])
