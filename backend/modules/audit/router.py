"""
Audit log API.

  GET /api/audit            most-recent first; optional ?entity_type / ?entity_id filters
"""
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from models.audit_log import AuditLog

router = APIRouter()


@router.get("")
async def list_audit_log(
    tenant_id: CurrentTenantId,
    entity_type: str | None = Query(default=None),
    entity_id:   uuid.UUID | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return audit log rows for the current tenant, most-recent first.
    Optionally narrow by entity_type / entity_id to get the activity for
    a single TB / variance / reconciliation.
    """
    stmt = select(AuditLog).order_by(desc(AuditLog.created_at)).limit(limit)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    rows = list((await db.execute(stmt)).scalars().all())

    return {
        "count": len(rows),
        "entries": [
            {
                "id":          str(r.id),
                "user_id":     str(r.user_id) if r.user_id else None,
                "action":      r.action,
                "entity_type": r.entity_type,
                "entity_id":   str(r.entity_id) if r.entity_id else None,
                "summary":     (r.event_data or {}).get("summary", r.action),
                "details":     {k: v for k, v in (r.event_data or {}).items() if k != "summary"},
                "created_at":  r.created_at.isoformat() if isinstance(r.created_at, datetime) else None,
            }
            for r in rows
        ],
    }
