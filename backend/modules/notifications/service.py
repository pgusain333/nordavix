"""
Notification creation helpers. Call these from the same places that write the
audit log (period close, etc.).

Both helpers only ADD rows to the session — they do NOT commit. Callers decide
the transaction boundary. To keep notifications best-effort (a notification
failure must never break the underlying action), producers call these AFTER
their main commit and commit again in a try/except. See the period-close hook.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.notification import Notification
from models.user import User


def notify(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    recipient_user_id: uuid.UUID,
    type: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
) -> None:
    """Queue one notification for a specific user (no commit)."""
    db.add(Notification(
        tenant_id=tenant_id,
        recipient_user_id=recipient_user_id,
        type=type, title=title, body=body, link=link,
        entity_type=entity_type, entity_id=entity_id,
    ))


async def broadcast_workspace(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    type: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    exclude_user_id: uuid.UUID | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
) -> list[uuid.UUID]:
    """Queue a notification for every user in the workspace (no commit).

    `exclude_user_id` skips the actor (no point telling someone about the thing
    they just did). Returns the recipient user ids queued (len = count). User is
    tenant-scoped, so the SELECT is auto-filtered to this workspace.
    """
    user_ids = list((await db.execute(select(User.id))).scalars().all())
    recipients: list[uuid.UUID] = []
    for uid in user_ids:
        if exclude_user_id is not None and uid == exclude_user_id:
            continue
        notify(
            db, tenant_id=tenant_id, recipient_user_id=uid,
            type=type, title=title, body=body, link=link,
            entity_type=entity_type, entity_id=entity_id,
        )
        recipients.append(uid)
    return recipients


async def resolve_email_targets(
    db: AsyncSession,
    recipient_ids: list[uuid.UUID],
) -> list[tuple[uuid.UUID, str]]:
    """Given recipient user ids, return (user_id, email) for those who have a
    non-empty email AND haven't opted out of notification emails. The SELECT on
    User is tenant-auto-filtered, so it can only return this workspace's users.
    """
    if not recipient_ids:
        return []
    rows = (await db.execute(
        select(User.id, User.email).where(
            User.id.in_(recipient_ids),
            User.email_notifications_enabled.is_(True),
        )
    )).all()
    return [(r[0], r[1]) for r in rows if r[1]]


async def workspace_user_ids_by_role(
    db: AsyncSession,
    roles: tuple[str, ...] | list[str],
    *,
    exclude_user_id: uuid.UUID | None = None,
) -> list[uuid.UUID]:
    """Internal user ids in this workspace whose role is in `roles` (the SELECT
    on User is tenant-auto-filtered), minus the actor. Used to route
    review-ready notifications to people who can approve."""
    rows = (await db.execute(
        select(User.id).where(User.role.in_(list(roles)))
    )).scalars().all()
    return [uid for uid in rows if uid != exclude_user_id]
