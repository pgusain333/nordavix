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
    period: str | None = Query(None, description="Grade against this period end"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return {"items": await svc.list_recommendations(
        db, status=status, period_end=_parse_period(period) if period else None,
    )}


@router.get("/scorecard")
async def get_scorecard(
    tenant_id: CurrentTenantId,
    period: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """What the firm's advice has been worth — the case for the advisory fee,
    assembled from the client's own numbers rather than asserted."""
    return await svc.scorecard(db, _parse_period(period))


class NewRecBody(BaseModel):
    period_end: str
    title: str
    detail: str | None = None
    kpi_key: str | None = None
    priority: str = "medium"
    target_value: float | None = None
    due_date: str | None = None
    expected_impact: float | None = None
    impact_note: str | None = None
    owner: str | None = None


@router.post("/recommendations")
async def create_recommendation(
    body: NewRecBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Advice a human is giving. This path did not exist — `source` declared a
    'manual' value nothing could reach, so the module could hold what the AI
    said in a monthly report and nothing a partner noticed in a meeting."""
    try:
        rec = await svc.create_recommendation(
            db, tenant_id,
            period_end=_parse_period(body.period_end),
            title=body.title, detail=body.detail, kpi_key=body.kpi_key,
            priority=body.priority, target_value=body.target_value,
            due_date=_parse_period(body.due_date) if body.due_date else None,
            expected_impact=body.expected_impact, impact_note=body.impact_note,
            owner=body.owner,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="advisory.recommendation_created",
        entity_type="tracked_recommendation", entity_id=rec.id,
        metadata={"summary": f"Advised '{rec.title[:80]}'", "kpi_key": rec.kpi_key},
    )
    await db.commit()
    await db.refresh(rec)
    return svc.serialize_rec(rec)


class RecBody(BaseModel):
    status: str | None = None
    client_action: str | None = None
    outcome_note: str | None = None
    priority: str | None = None
    owner: str | None = None
    due_date: str | None = None
    target_value: float | None = None
    # Link (or unlink) the metric this advice is meant to move. Empty string
    # clears it; omitted leaves it alone.
    kpi_key: str | None = None


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
            outcome_note=body.outcome_note, priority=body.priority,
            owner=body.owner, target_value=body.target_value, kpi_key=body.kpi_key,
            due_date=_parse_period(body.due_date) if body.due_date else None,
            user_id=user.id,
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
