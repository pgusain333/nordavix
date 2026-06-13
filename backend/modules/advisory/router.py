"""
Advisory API — longitudinal KPI trends vs targets + tracked recommendations.

  GET    /api/advisory?period=YYYY-MM-DD   KPI trend overview (any member)
  GET    /api/advisory/catalog             the KPI catalog (for the editor)
  PUT    /api/advisory/targets/{kpi_key}   set a KPI target (reviewer+)
  DELETE /api/advisory/targets/{kpi_key}   clear a target (reviewer+)
  GET    /api/advisory/recommendations     tracked advisory items (any member)
  POST   /api/advisory/recommendations/{id} update status / outcome (reviewer+)
"""
import logging
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_role
from core.db.session import get_db
from models.user import User
from modules.advisory import service as svc

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_period(period: str) -> date:
    try:
        return date.fromisoformat(period)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="period must be YYYY-MM-DD") from exc


@router.get("")
async def get_kpis(
    tenant_id: CurrentTenantId,
    period: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await svc.kpi_overview(db, tenant_id, _parse_period(period))


@router.get("/catalog")
async def get_catalog(tenant_id: CurrentTenantId) -> dict:
    return {"kpis": svc.KPI_CATALOG}


class TargetBody(BaseModel):
    comparator: str = "gte"
    value: float
    value_upper: float | None = None
    note: str | None = None


@router.put("/targets/{kpi_key}")
async def put_target(
    kpi_key: str,
    body: TargetBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        t = await svc.upsert_target(
            db, tenant_id, kpi_key, body.comparator, body.value, body.value_upper, body.note, user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="advisory.target_set", entity_type="kpi_target", entity_id=None,
        metadata={"summary": f"Set target for {kpi_key}: {body.comparator} {body.value}"},
    )
    await db.commit()
    return svc.serialize_target(t)


@router.delete("/targets/{kpi_key}")
async def remove_target(
    kpi_key: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await svc.delete_target(db, tenant_id, kpi_key)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="advisory.target_cleared", entity_type="kpi_target", entity_id=None,
        metadata={"summary": f"Cleared target for {kpi_key}"},
    )
    await db.commit()
    return {"ok": True}


@router.get("/recommendations")
async def get_recommendations(
    tenant_id: CurrentTenantId,
    status: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return {"items": await svc.list_recommendations(db, status=status)}


class RecBody(BaseModel):
    status: str | None = None
    client_action: str | None = None
    outcome_note: str | None = None


@router.post("/recommendations/{rec_id}")
async def patch_recommendation(
    rec_id: uuid.UUID,
    body: RecBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        r = await svc.update_recommendation(
            db, rec_id, status=body.status, client_action=body.client_action,
            outcome_note=body.outcome_note, user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if r is None:
        raise HTTPException(status_code=404, detail="Recommendation not found.")
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="advisory.recommendation_updated", entity_type="tracked_recommendation", entity_id=rec_id,
        metadata={"summary": f"Updated recommendation '{r['title'][:80]}'"},
    )
    await db.commit()
    return r
