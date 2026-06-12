"""
Audit log API.

  GET /api/audit            most-recent first; optional ?entity_type / ?entity_id filters
  GET /api/audit/export     full structured .xlsx audit trail (date + time + user per event)
"""
import asyncio
import logging
import uuid
from datetime import date, datetime, time, timedelta
from io import BytesIO

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import asc, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.clerk_users import _format_display_name, get_clerk_user
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.audit_log import AuditLog
from models.user import User

logger = logging.getLogger(__name__)

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


# Hard cap on exported rows — far above any real workspace's history, but
# bounds memory if a tenant ever accumulates a pathological event count.
_EXPORT_ROW_CAP = 20_000


async def _resolve_user_names(db: AsyncSession, user_ids: list[uuid.UUID]) -> dict[str, str]:
    """user_id → display name. Clerk profile name when available (5-min
    cached), DB email as fallback — same approach as the workspace
    member-name resolver, bounded fan-out so big logs can't stampede Clerk."""
    if not user_ids:
        return {}
    users = list((await db.execute(
        select(User).where(User.id.in_(user_ids[:500]))
    )).scalars().all())

    sem = asyncio.Semaphore(8)

    async def _one(u: User) -> tuple[str, str]:
        name = u.email
        if u.clerk_user_id:
            async with sem:
                try:
                    clerk = await get_clerk_user(u.clerk_user_id)
                    if clerk:
                        name = _format_display_name(clerk) or u.email
                except Exception:
                    logger.debug("clerk lookup failed for %s", u.clerk_user_id, exc_info=True)
        return str(u.id), name

    resolved = await asyncio.gather(*(_one(u) for u in users))
    return dict(resolved)


@router.get("/export")
async def export_audit_trail(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    start: date | None = Query(default=None, description="Include events on/after this date"),
    end:   date | None = Query(default=None, description="Include events on/before this date"),
    tz_offset: int = Query(default=0, ge=-840, le=840,
                           description="Browser getTimezoneOffset() so Date/Time render in the user's local time"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    The full audit trail as a structured Excel workbook — every recorded
    action with date, time, user, module, and a human summary. Chronological
    (oldest first) like a workpaper, frozen header + autofilter.
    """
    from modules.exports.audit_workbook import build_audit_workbook
    from modules.exports.router import _resolve_company_and_user

    stmt = select(AuditLog).order_by(asc(AuditLog.created_at)).limit(_EXPORT_ROW_CAP)
    if start:
        # Date filters are interpreted in the USER'S timezone (that's what the
        # picker shows them), so shift the boundary back to UTC for the query.
        stmt = stmt.where(AuditLog.created_at >= datetime.combine(start, time.min) + timedelta(minutes=tz_offset))
    if end:
        stmt = stmt.where(AuditLog.created_at <= datetime.combine(end, time.max) + timedelta(minutes=tz_offset))
    rows = list((await db.execute(stmt)).scalars().all())

    names = await _resolve_user_names(db, list({r.user_id for r in rows if r.user_id}))
    entries = [
        {
            "created_at":  r.created_at,
            "action":      r.action,
            "entity_type": r.entity_type,
            "summary":     (r.event_data or {}).get("summary", r.action),
            "user_name":   names.get(str(r.user_id)) if r.user_id else None,
        }
        for r in rows
    ]

    company_name, generated_by = await _resolve_company_and_user(db, tenant_id, user)
    if start and end:
        range_label = f"{start.strftime('%m-%d-%Y')} to {end.strftime('%m-%d-%Y')}"
    elif start:
        range_label = f"From {start.strftime('%m-%d-%Y')}"
    elif end:
        range_label = f"Through {end.strftime('%m-%d-%Y')}"
    else:
        range_label = "Full history"

    data = build_audit_workbook(
        company_name=company_name,
        generated_by=generated_by,
        entries=entries,
        tz_offset=tz_offset,
        range_label=range_label,
    )
    fname = f"nordavix_audit_trail_{datetime.utcnow().strftime('%Y-%m-%d')}.xlsx"
    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"', "Cache-Control": "no-store"},
    )
