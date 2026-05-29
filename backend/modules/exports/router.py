"""
Exports endpoint — streams the Period Export workbook as an .xlsx
attachment download. Single endpoint for now; more report formats can
be added as siblings (e.g., /period/csv, /trial-balance/xlsx, etc.).
"""
from __future__ import annotations

import logging
import re
from datetime import date as _date
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from modules.exports.period_workbook import build_period_workbook

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
    except Exception:
        logger.exception("Period workbook build failed")
        raise HTTPException(
            status_code=500,
            detail="Could not build the export workbook. Check server logs.",
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
