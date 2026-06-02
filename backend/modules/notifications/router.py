"""
Notifications API — the in-app bell.

  GET  /api/notifications        → recent items + unread count
  GET  /api/notifications/count  → unread count only (cheap badge poll)
  POST /api/notifications/read   → mark all (or specific ids) read

All scoped to the calling user within the current tenant.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.notification import Notification
from models.user import User

router = APIRouter()


class NotificationOut(BaseModel):
    id:          str
    type:        str
    title:       str
    body:        str | None
    link:        str | None
    read:        bool
    created_at:  str


class NotificationList(BaseModel):
    items:  list[NotificationOut]
    unread: int


def _serialize(n: Notification) -> NotificationOut:
    return NotificationOut(
        id=str(n.id), type=n.type, title=n.title, body=n.body, link=n.link,
        read=n.read_at is not None,
        created_at=n.created_at.isoformat() if n.created_at else "",
    )


async def _unread_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    return (await db.execute(
        select(func.count(Notification.id))
        .where(Notification.recipient_user_id == user_id, Notification.read_at.is_(None))
    )).scalar() or 0


@router.get("", response_model=NotificationList)
async def list_notifications(
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    limit: int = 30,
) -> NotificationList:
    rows = list((await db.execute(
        select(Notification)
        .where(Notification.recipient_user_id == user.id)
        .order_by(Notification.created_at.desc())
        .limit(min(max(limit, 1), 100))
    )).scalars().all())
    return NotificationList(items=[_serialize(n) for n in rows], unread=await _unread_count(db, user.id))


@router.get("/count")
async def unread_count(
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    return {"unread": await _unread_count(db, user.id)}


@router.post("/read")
async def mark_read(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    ids: list[str] | None = Body(default=None, embed=True),
) -> dict[str, bool]:
    """Mark notifications read. With `ids`, marks those; otherwise marks all
    of this user's unread. UPDATE is explicitly tenant- + user-scoped (the
    auto tenant filter only covers SELECTs)."""
    stmt = (
        update(Notification)
        .where(
            Notification.tenant_id == tenant_id,
            Notification.recipient_user_id == user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=datetime.now(UTC))
    )
    if ids:
        try:
            uuids = [uuid.UUID(i) for i in ids]
        except ValueError:
            uuids = []
        stmt = stmt.where(Notification.id.in_(uuids))
    await db.execute(stmt)
    await db.commit()
    return {"ok": True}


# ── Email preferences ────────────────────────────────────────────────────────

class PreferencesOut(BaseModel):
    email_notifications_enabled: bool


@router.get("/preferences", response_model=PreferencesOut)
async def get_preferences(user: CurrentUser) -> PreferencesOut:
    """The calling user's notification-email opt-in."""
    return PreferencesOut(email_notifications_enabled=user.email_notifications_enabled)


@router.patch("/preferences", response_model=PreferencesOut)
async def update_preferences(
    body: PreferencesOut,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> PreferencesOut:
    """Toggle the calling user's notification emails. UPDATE is explicitly
    scoped to this user within the tenant (the auto filter only covers SELECTs)."""
    await db.execute(
        update(User)
        .where(User.id == user.id, User.tenant_id == tenant_id)
        .values(email_notifications_enabled=body.email_notifications_enabled)
    )
    await db.commit()
    return PreferencesOut(email_notifications_enabled=body.email_notifications_enabled)
