"""
Comment data access. Pure DB logic — side effects (notifications, email) live
in the router, mirroring how the feedback/notification producers are structured.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.comment import Comment
from models.user import User


async def list_comments(
    db: AsyncSession, *, entity_type: str, entity_id: str,
) -> list[Comment]:
    """All non-deleted comments for one entity, oldest first. SELECT on the
    tenant-scoped Comment auto-filters to the current workspace."""
    rows = (await db.execute(
        select(Comment)
        .where(
            Comment.entity_type == entity_type,
            Comment.entity_id == entity_id,
            Comment.deleted_at.is_(None),
        )
        .order_by(Comment.created_at.asc())
    )).scalars().all()
    return list(rows)


async def valid_mention_ids(
    db: AsyncSession,
    candidate_ids: list[str],
    *,
    exclude_user_id: uuid.UUID,
) -> list[uuid.UUID]:
    """Filter caller-supplied user-id strings to real users in this tenant
    (the SELECT on User is tenant-auto-filtered), dropping the author and
    duplicates. Guards against a client mentioning someone outside the
    workspace."""
    parsed: list[uuid.UUID] = []
    for c in candidate_ids:
        try:
            parsed.append(uuid.UUID(str(c)))
        except (ValueError, TypeError):
            continue
    if not parsed:
        return []
    real = (await db.execute(select(User.id).where(User.id.in_(parsed)))).scalars().all()
    seen: set[uuid.UUID] = set()
    out: list[uuid.UUID] = []
    for uid in real:
        if uid == exclude_user_id or uid in seen:
            continue
        seen.add(uid)
        out.append(uid)
    return out
