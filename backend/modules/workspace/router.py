"""
Workspace endpoints — team / member management.

  GET  /workspace/members           Resolved org members (Clerk-backed)
  GET  /workspace/users/lookup       Bulk resolve our user UUIDs → display names

Used by the frontend to render "Reviewed by Jatin" instead of
"Reviewed by 4c1d8a-...-uuid" in the audit log and on the dashboards.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.clerk_users import (
    _format_display_name,
    get_clerk_user,
    list_org_memberships,
)
from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from models.tenant import Tenant
from models.user import User

router = APIRouter()


@router.get("/members")
async def list_members(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return every member of the current Clerk organization with their name,
    email, Clerk role, and (if they've signed in) our internal user UUID.
    The internal UUID is what audit-log rows reference, so the frontend
    can lookup display names without a second call.
    """
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found.")

    # Clerk membership = authoritative list
    memberships = await list_org_memberships(tenant.clerk_org_id)

    # Map clerk_user_id → our user.id so audit-log UUID refs resolve.
    our_users = list((await db.execute(
        select(User).where(User.tenant_id == tenant_id)
    )).scalars().all())
    clerk_to_uuid = {u.clerk_user_id: str(u.id) for u in our_users if u.clerk_user_id}

    members = []
    for m in memberships:
        clerk_id = m.get("user_id") or ""
        first = m.get("first_name") or ""
        last  = m.get("last_name") or ""
        full  = " ".join(p for p in [first, last] if p).strip() or m.get("email") or clerk_id
        members.append({
            "id":            clerk_to_uuid.get(clerk_id),
            "clerk_user_id": clerk_id,
            "first_name":    first,
            "last_name":     last,
            "display_name":  full,
            "email":         m.get("email"),
            "image_url":     m.get("image_url"),
            "role":          m.get("role"),
        })
    return {"members": members}


@router.get("/users/lookup")
async def lookup_users(
    tenant_id: CurrentTenantId,
    ids: str = Query("", description="Comma-separated internal user UUIDs"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Bulk resolve internal user UUIDs to display names. Used by the audit
    log viewer and reviewed-by chips. Resolves through Clerk for the real
    name; falls back to the email stored on our user row, then the UUID.
    """
    if not ids.strip():
        return {"users": {}}
    try:
        uuid_list = [uuid.UUID(s.strip()) for s in ids.split(",") if s.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be comma-separated UUIDs.")
    if not uuid_list:
        return {"users": {}}

    users = list((await db.execute(
        select(User).where(User.id.in_(uuid_list))
    )).scalars().all())

    out: dict[str, dict] = {}
    for u in users:
        clerk = await get_clerk_user(u.clerk_user_id) if u.clerk_user_id else None
        if clerk:
            out[str(u.id)] = {
                "display_name":  _format_display_name(clerk),
                "email":         clerk.get("email") or u.email,
                "image_url":     clerk.get("image_url"),
                "clerk_user_id": u.clerk_user_id,
            }
        else:
            out[str(u.id)] = {
                "display_name":  u.email,
                "email":         u.email,
                "image_url":     None,
                "clerk_user_id": u.clerk_user_id,
            }
    # Also include UUIDs that aren't in our DB at all (rare race condition)
    # — frontend will fall back to "Unknown" for these.
    for u in uuid_list:
        out.setdefault(str(u), {"display_name": "Unknown user", "email": None, "image_url": None, "clerk_user_id": None})
    return {"users": out}
