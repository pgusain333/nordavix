"""
Comments & @mentions API.

  GET    /api/comments?entity_type=&entity_id=  → the thread (oldest first)
  POST   /api/comments                          → add a comment (+ mention fan-out)
  DELETE /api/comments/{id}                      → soft-delete (author or admin)

A comment's @mentions create `mention` notifications and, best-effort, email the
mentioned users (Phase 2). Threads attach to any entity via (entity_type,
entity_id). All scoped to the current tenant.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.clerk_users import get_clerk_user
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.comment import Comment
from modules.comments.service import list_comments, valid_mention_ids
from modules.notifications.emails import schedule_notification_emails
from modules.notifications.service import notify, resolve_email_targets

logger = logging.getLogger(__name__)
router = APIRouter()


class CommentOut(BaseModel):
    id:             str
    entity_type:    str
    entity_id:      str
    author_user_id: str
    body:           str
    mentions:       list[str]
    created_at:     str
    deleted:        bool = False


class CommentList(BaseModel):
    items: list[CommentOut]


class CommentIn(BaseModel):
    entity_type:        str = Field(..., max_length=50)
    entity_id:          str = Field(..., max_length=100)
    body:               str = Field(..., min_length=1, max_length=5000)
    mentioned_user_ids: list[str] = Field(default_factory=list)
    link:               str | None = Field(default=None, max_length=500)


def _serialize(c: Comment) -> CommentOut:
    return CommentOut(
        id=str(c.id),
        entity_type=c.entity_type,
        entity_id=c.entity_id,
        author_user_id=str(c.author_user_id),
        body=c.body,
        mentions=[str(m) for m in (c.mentions or [])],
        created_at=c.created_at.isoformat() if c.created_at else "",
        deleted=c.deleted_at is not None,
    )


async def _actor_name(user: CurrentUser) -> str:
    """Best display name for the comment author (Clerk first/last, else email).
    Cached 5 min by get_clerk_user, so cheap."""
    try:
        cu = await get_clerk_user(user.clerk_user_id)
        if cu:
            name = f"{cu.get('first_name') or ''} {cu.get('last_name') or ''}".strip()
            if name:
                return name
            if cu.get("email"):
                return str(cu["email"])
    except Exception:
        logger.debug("actor name resolution failed", exc_info=True)
    return user.email or "Someone"


def _audit_entity_uuid(entity_id: str) -> uuid.UUID | None:
    """Comment entity ids are strings (e.g. "<qbo_account_id>:<period_end>"),
    but audit_log.entity_id is a UUID column — pass it through only when it
    really is a UUID. The raw string always travels in the event metadata."""
    try:
        return uuid.UUID(entity_id)
    except ValueError:
        return None


@router.get("", response_model=CommentList)
async def get_comments(
    tenant_id: CurrentTenantId,
    entity_type: str = Query(..., max_length=50),
    entity_id: str = Query(..., max_length=100),
    db: AsyncSession = Depends(get_db),
) -> CommentList:
    rows = await list_comments(db, entity_type=entity_type, entity_id=entity_id)
    return CommentList(items=[_serialize(c) for c in rows])


@router.post("", response_model=CommentOut, status_code=201)
async def create_comment(
    payload: CommentIn,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> CommentOut:
    text = payload.body.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Comment body is required.")

    mention_ids = await valid_mention_ids(
        db, payload.mentioned_user_ids, exclude_user_id=user.id,
    )

    row = Comment(
        tenant_id=tenant_id,
        entity_type=payload.entity_type.strip(),
        entity_id=payload.entity_id.strip(),
        author_user_id=user.id,
        body=text,
        mentions=[str(m) for m in mention_ids],
        link=(payload.link or None),
    )
    db.add(row)
    await db.flush()  # populate row.id for the audit event

    # Audit — reuse the comment's entity so the event links to the
    # recon/variance it sits on. No comment body in the summary (privacy);
    # a short truncated preview in metadata is enough for the trail.
    audit_preview = text if len(text) <= 60 else text[:59] + "…"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="comment.added",
        entity_type=row.entity_type, entity_id=_audit_entity_uuid(row.entity_id),
        metadata={
            "summary": f"Comment added on {row.entity_type}",
            "entity_id": row.entity_id,
            "comment_id": str(row.id),
            "preview": audit_preview,
        },
    )

    # Knowledge graph: a note on a reconciliation documents it. entity_id is
    # already the recon node id ("<qbo_account_id>:<period>"). Best-effort.
    if row.entity_type == "reconciliation":
        try:
            from core.db.base import tenant_scope
            from core.graph import Node, link
            with tenant_scope(tenant_id):
                await link(
                    db, Node("memo", str(row.id)), "documents",
                    Node("reconciliation", row.entity_id), origin="system", created_by=user.id,
                )
        except Exception:
            import logging
            logging.getLogger(__name__).exception("graph link failed for comment (non-fatal)")

    await db.commit()

    # @mentions → in-app notifications + (best-effort) email. Never let a
    # notification failure undo the saved comment.
    if mention_ids:
        try:
            actor = await _actor_name(user)
            preview = text if len(text) <= 140 else text[:139] + "…"
            title = f"{actor} mentioned you"
            for uid in mention_ids:
                notify(
                    db, tenant_id=tenant_id, recipient_user_id=uid,
                    type="mention", title=title, body=preview,
                    link=payload.link or "/app",
                    entity_type=payload.entity_type, entity_id=payload.entity_id,
                )
            await db.commit()
            targets = await resolve_email_targets(db, mention_ids)
            schedule_notification_emails(
                background_tasks, targets=targets,
                title=title, body=preview, link=payload.link, actor_name=actor,
            )
        except Exception:
            logger.warning("mention fan-out failed (non-fatal)", exc_info=True)

    return _serialize(row)


@router.delete("/{comment_id}")
async def delete_comment(
    comment_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    try:
        cid = uuid.UUID(comment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid comment id.")
    row = (await db.execute(
        select(Comment).where(Comment.id == cid)
    )).scalar_one_or_none()
    if row is None or row.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Comment not found.")
    # Author or an admin may remove a comment.
    if row.author_user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="You can only delete your own comments.")
    row.deleted_at = datetime.now(UTC)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="comment.deleted",
        entity_type=row.entity_type, entity_id=_audit_entity_uuid(row.entity_id),
        metadata={
            "summary": f"Comment deleted on {row.entity_type}",
            "entity_id": row.entity_id,
            "comment_id": str(row.id),
        },
    )
    await db.commit()
    return {"ok": True}
