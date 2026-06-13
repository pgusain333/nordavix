"""
Close Binder endpoint — one paginated, audit-ready PDF per closed period.

Gated to a CLOSED period so the binder is byte-stable: every section reads the
committed snapshot, never a fresh QBO pull, so a binder a reviewer signs today
regenerates identically tomorrow.
"""
from __future__ import annotations

import io
import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.closed_period import ClosedPeriod
from modules.workpapers.binder import build_close_binder

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/binder")
async def download_close_binder(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="YYYY-MM-DD — must be a closed period"),
    db: AsyncSession = Depends(get_db),
):
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    closed = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == pe)
    )).scalar_one_or_none()
    if closed is None:
        raise HTTPException(
            409,
            "The books for this period aren't closed yet. Close them in "
            "Reconciliations to generate the signed close binder.",
        )

    from modules.financials.router import _company_name
    company = await _company_name(db, tenant_id)
    generated_by = user.email or "Nordavix"

    logger.info("Close binder: building tenant=%s period=%s", tenant_id, pe)
    try:
        pdf = await build_close_binder(
            db=db, tenant_id=tenant_id, period_end=pe,
            company=company, generated_by_name=generated_by, closed=closed)
    except Exception as exc:
        logger.exception("Close binder build failed tenant=%s period=%s", tenant_id, pe)
        raise HTTPException(
            500,
            f"Close binder generation failed: {type(exc).__name__}: {str(exc)[:200]}",
        ) from exc

    try:
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="workpapers.binder_exported", entity_type="closed_period",
            entity_id=closed.id, metadata={"summary": f"Close binder exported for {pe.isoformat()}"})
        await db.commit()
    except Exception:
        await db.rollback()
        logger.debug("Close binder: audit write failed (non-fatal)", exc_info=True)

    logger.info("Close binder done: tenant=%s period=%s bytes=%d", tenant_id, pe, len(pdf))
    fname = f"close-binder-{pe.isoformat()}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf), media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )
