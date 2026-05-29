"""
Per-schedule-type standalone workbook (.xlsx).

One thin endpoint per schedule type (prepaids, accruals, fixed assets,
leases, loans). Each export gets a cover sheet + the type's full table,
using the same xlsx_builder named styles as Period Export so the look
is consistent across every download.

The actual sheet builders live in period_workbook.py — this module
just calls the right one with a tailored cover sheet.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date
from io import BytesIO

from openpyxl import Workbook
from sqlalchemy.ext.asyncio import AsyncSession

from modules.exports import period_workbook as pw
from modules.exports.xlsx_builder import fmt_date, register_styles

logger = logging.getLogger(__name__)

# Public schedule type identifiers (also used as URL slugs).
SCHEDULE_TYPES = ("prepaids", "accruals", "fixed-assets", "leases", "loans")

# Display titles for the cover sheet H1
_TITLE = {
    "prepaids":     "Prepaid Expense Schedule",
    "accruals":     "Accrued Expense Schedule",
    "fixed-assets": "Fixed Asset Register",
    "leases":       "Lease Schedule",
    "loans":        "Loan Schedule",
}

# Cover-sheet contents description (matches what the table sheet holds)
_CONTENTS = {
    "prepaids":     "Active prepaid items with period amortization, amortized-to-date, and unamortized balance.",
    "accruals":     "Active accrued expense items with accrual date, amount, reversal date, and status.",
    "fixed-assets": "Fixed asset register with cost, salvage, useful life, accumulated depreciation, and net book value.",
    "leases":       "Active leases with monthly payment, discount rate, initial ROU asset, and initial liability.",
    "loans":        "Active loans with original principal, rate, term, payment type, and monthly payment.",
}

# Filename slugs
_FNAME_PREFIX = {
    "prepaids":     "prepaid-schedule",
    "accruals":     "accrual-schedule",
    "fixed-assets": "fixed-asset-register",
    "leases":       "lease-schedule",
    "loans":        "loan-schedule",
}

# Map URL slug → period_workbook builder
def _builder_for(schedule_type: str):
    return {
        "prepaids":     pw._build_prepaids_sheet,
        "accruals":     pw._build_accruals_sheet,
        "fixed-assets": pw._build_fixed_assets_sheet,
        "leases":       pw._build_leases_sheet,
        "loans":        pw._build_loans_sheet,
    }[schedule_type]


async def build_schedule_workbook(
    *,
    schedule_type: str,
    db: AsyncSession,
    tenant_id: uuid.UUID,
    period_end: date,
    company_name: str,
    generated_by_name: str,
) -> bytes:
    """Build a single-type schedule workbook + return raw bytes."""
    if schedule_type not in SCHEDULE_TYPES:
        raise ValueError(f"Unknown schedule type: {schedule_type}")

    wb = Workbook()
    register_styles(wb)
    if wb.active is not None:
        wb.remove(wb.active)

    pw.build_cover_sheet(
        wb,
        company_name=company_name,
        package_title=_TITLE[schedule_type],
        period_label=f"As of {fmt_date(period_end)}",
        generated_by=generated_by_name,
        contents_text=_CONTENTS[schedule_type],
    )

    builder = _builder_for(schedule_type)
    await builder(wb, db, tenant_id, period_end)

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.read()


def filename_for(schedule_type: str, company_name: str, period_end: date) -> str:
    """Build a clean download filename."""
    import re
    safe = re.sub(r"[^A-Za-z0-9 _-]+", "", company_name or "").strip()
    safe = re.sub(r"\s+", "_", safe)[:50] or "Nordavix"
    return f"{safe}_{_FNAME_PREFIX[schedule_type]}_{period_end.isoformat()}.xlsx"
