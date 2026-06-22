"""
Exports endpoints — stream xlsx attachments for the close package and
per-schedule-type downloads. Sibling endpoints in flux + recons
routers delegate into modules.exports.{flux,recon}_workbook.
"""
from __future__ import annotations

import logging
import re
from datetime import date as _date
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from modules.exports.financials_workbook import (
    FINANCIAL_SHEET_LABELS,
    build_financials_workbook,
    build_single_financial_workbook,
)
from modules.exports.financials_workbook import (
    filename_for as financial_filename_for,
)
from modules.exports.period_workbook import build_period_workbook
from modules.exports.schedules_workbook import (
    SCHEDULE_TYPES,
    build_schedule_workbook,
)
from modules.exports.schedules_workbook import (
    filename_for as schedule_filename_for,
)

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

logger = logging.getLogger(__name__)

router = APIRouter()


def _safe_filename_segment(s: str | None) -> str:
    """Sanitize a string for use inside a Content-Disposition filename.
    Keeps alphanum + space + hyphen + underscore, collapses the rest."""
    if not s:
        return ""
    cleaned = re.sub(r"[^A-Za-z0-9 _-]+", "", s).strip()
    return re.sub(r"\s+", "_", cleaned)[:60]


@router.get("/period")
async def export_period_workbook(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    Build + stream the Period Export workbook (.xlsx) for the calling
    tenant + the given period_end. Includes all sheets defined in
    period_workbook.build_period_workbook.

    No role check beyond authentication — anyone with workspace access
    can pull their own period export. (Admin-only would block preparers
    from grabbing supporting workpapers, which is the wrong friction.)
    """
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    # Resolve workspace + user display info for the cover sheet
    company_name = "Workspace"
    try:
        from sqlalchemy import select

        from models.tenant import Tenant
        t = (await db.execute(
            select(Tenant).where(Tenant.id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        if t and getattr(t, "name", None):
            company_name = t.name
    except Exception:
        # Cover sheet falls back to "Workspace" — non-fatal
        pass

    generated_by = "Unknown user"
    try:
        if user:
            display = getattr(user, "display_name", None) or getattr(user, "email", None)
            if display:
                generated_by = str(display)
    except Exception:
        pass

    try:
        data = await build_period_workbook(
            db=db,
            tenant_id=tenant_id,
            period_end=pe,
            company_name=company_name,
            generated_by_name=generated_by,
        )
    except Exception as exc:
        # Surface the error class + short message so the frontend can
        # show "Excel export failed: <reason>" instead of a generic 500.
        # Per-sheet failures don't reach here (period_workbook now
        # swallows them and inserts a placeholder sheet); this catches
        # only the unrecoverable shell-level failure (e.g. workbook
        # save errored, cover sheet broke). Full traceback in logs.
        logger.exception("Period workbook build failed")
        raise HTTPException(
            status_code=500,
            detail=f"Could not build the workbook ({type(exc).__name__}: {str(exc)[:200]}).",
        )

    fname_company = _safe_filename_segment(company_name) or "Nordavix"
    fname = f"{fname_company}_close_{pe.isoformat()}.xlsx"

    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )


# ── Per-schedule-type exports ─────────────────────────────────────────────────

@router.get("/schedules/{schedule_type}")
async def export_schedule_workbook(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    schedule_type: str = Path(
        ...,
        description="One of: prepaids, accruals, fixed-assets, leases, loans",
    ),
    period_end: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Stream a single-type schedule workbook for the calling tenant.

    URL slug → schedule type mapping:
      /schedules/prepaids        → Prepaid Expense Schedule
      /schedules/accruals        → Accrued Expense Schedule
      /schedules/fixed-assets    → Fixed Asset Register
      /schedules/leases          → Lease Schedule
      /schedules/loans           → Loan Schedule
    """
    if schedule_type not in SCHEDULE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"schedule_type must be one of: {', '.join(SCHEDULE_TYPES)}",
        )

    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    company_name = "Workspace"
    try:
        from sqlalchemy import select

        from models.tenant import Tenant
        t = (await db.execute(
            select(Tenant).where(Tenant.id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        if t and getattr(t, "name", None):
            company_name = t.name
    except Exception:
        pass

    generated_by = "Unknown user"
    try:
        if user:
            display = getattr(user, "display_name", None) or getattr(user, "email", None)
            if display:
                generated_by = str(display)
    except Exception:
        pass

    try:
        data = await build_schedule_workbook(
            schedule_type=schedule_type,
            db=db,
            tenant_id=tenant_id,
            period_end=pe,
            company_name=company_name,
            generated_by_name=generated_by,
        )
    except Exception:
        logger.exception("Schedule workbook build failed (%s)", schedule_type)
        raise HTTPException(
            status_code=500,
            detail="Could not build the schedule export. Check server logs.",
        )

    fname = schedule_filename_for(schedule_type, company_name, pe)

    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )


# ── Financial Package (.xlsx) ─────────────────────────────────────────────────

async def _resolve_company_and_user(db: AsyncSession, tenant_id, user) -> tuple[str, str]:
    """Company name (workspace) + generated-by display for the cover sheet."""
    company_name = "Workspace"
    try:
        from sqlalchemy import select

        from models.tenant import Tenant
        t = (await db.execute(
            select(Tenant).where(Tenant.id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        if t and getattr(t, "name", None):
            company_name = t.name
    except Exception:
        pass
    generated_by = "Unknown user"
    try:
        if user:
            display = getattr(user, "display_name", None) or getattr(user, "email", None)
            if display:
                generated_by = str(display)
    except Exception:
        pass
    return company_name, generated_by


def _parse_pe(period_end: str) -> _date:
    try:
        return _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")


def _parse_ps(period_start: str | None, pe: _date) -> _date | None:
    if not period_start:
        return None
    try:
        ps = _date.fromisoformat(period_start)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_start must be YYYY-MM-DD.")
    if ps > pe:
        raise HTTPException(status_code=400, detail="period_start must be on or before period_end.")
    return ps


@router.get("/financials")
async def export_financials(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    period_start: str | None = Query(None, description="Optional custom start (defaults to YTD/Jan 1)"),
    comparative: bool = Query(True),
    source: str = Query("nordavix", description="nordavix | quickbooks"),
    comparative_basis: str = Query("prior_year", description="prior_year | prior_month"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Full financial-package workbook — statements + the complete schedule set."""
    pe = _parse_pe(period_end)
    ps = _parse_ps(period_start, pe)
    company_name, generated_by = await _resolve_company_and_user(db, tenant_id, user)
    try:
        data = await build_financials_workbook(
            db=db, tenant_id=tenant_id, period_end=pe, period_start=ps,
            comparative=comparative, source=source,
            company_name=company_name, generated_by_name=generated_by,
            comparative_basis=comparative_basis,
        )
    except Exception as exc:
        logger.exception("Financials workbook build failed")
        raise HTTPException(
            status_code=500,
            detail=f"Could not build the financial package ({type(exc).__name__}: {str(exc)[:200]}).",
        )

    fname_company = _safe_filename_segment(company_name) or "Nordavix"
    fname = f"{fname_company}_financial-package_{pe.isoformat()}.xlsx"
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"', "Cache-Control": "no-store"},
    )


@router.get("/financials/{schedule}")
async def export_financial_schedule(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    schedule: str = Path(..., description="One of the financial schedule slugs"),
    period_end: str = Query(..., description="YYYY-MM-DD"),
    period_start: str | None = Query(None),
    comparative: bool = Query(True),
    source: str = Query("nordavix", description="nordavix | quickbooks"),
    comparative_basis: str = Query("prior_year", description="prior_year | prior_month"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """A single financial schedule (cover + one sheet) as .xlsx."""
    if schedule not in FINANCIAL_SHEET_LABELS:
        raise HTTPException(
            status_code=400,
            detail=f"schedule must be one of: {', '.join(FINANCIAL_SHEET_LABELS)}",
        )
    pe = _parse_pe(period_end)
    ps = _parse_ps(period_start, pe)
    company_name, generated_by = await _resolve_company_and_user(db, tenant_id, user)
    try:
        data = await build_single_financial_workbook(
            slug=schedule, db=db, tenant_id=tenant_id, period_end=pe, period_start=ps,
            comparative=comparative, source=source,
            company_name=company_name, generated_by_name=generated_by,
            comparative_basis=comparative_basis,
        )
    except Exception as exc:
        logger.exception("Financial schedule export failed (%s)", schedule)
        raise HTTPException(
            status_code=500,
            detail=f"Could not build the schedule export ({type(exc).__name__}: {str(exc)[:200]}).",
        )

    fname = financial_filename_for(schedule, company_name, pe)
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"', "Cache-Control": "no-store"},
    )
