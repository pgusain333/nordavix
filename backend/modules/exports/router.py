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
from modules.exports.period_workbook import build_period_workbook
from modules.exports.schedules_workbook import (
    SCHEDULE_TYPES,
    build_schedule_workbook,
)
from modules.exports.schedules_workbook import (
    filename_for as schedule_filename_for,
)

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
