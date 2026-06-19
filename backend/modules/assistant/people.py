"""Workspace people for the assistant — members + actor-id → name resolution.

Reuses the same Clerk-backed resolution as /workspace/members so the copilot can
answer "who's on the team?" and render real names instead of raw UUIDs (e.g. a
close-task assignee). Everything here is a READ (DB selects + cached Clerk GETs),
so it is safe inside the assistant's hard read-only guard.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.clerk_users import list_org_memberships
from models.tenant import Tenant
from models.user import User


async def workspace_members(db: AsyncSession, tenant_id: uuid.UUID) -> list[dict]:
    """Every member of the workspace's Clerk org with name, role, email, status.

    Mirrors the /workspace/members endpoint: Clerk membership is the authoritative
    roster; we attach each member's Nordavix role + active status from our User
    rows. Returns [] if the org can't be resolved.
    """
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if tenant is None or not getattr(tenant, "clerk_org_id", None):
        return []

    memberships = await list_org_memberships(tenant.clerk_org_id)
    our_users = list((await db.execute(
        select(User).where(User.tenant_id == tenant_id)
    )).scalars().all())
    by_clerk = {u.clerk_user_id: u for u in our_users if u.clerk_user_id}

    members: list[dict] = []
    for m in memberships:
        clerk_id = m.get("user_id") or ""
        first, last = m.get("first_name") or "", m.get("last_name") or ""
        full = " ".join(p for p in [first, last] if p).strip() or m.get("email") or clerk_id
        u = by_clerk.get(clerk_id)
        members.append({
            "user_id":   str(u.id) if u else None,
            "name":      full,
            "email":     m.get("email"),
            "role":      u.role if u else "preparer",   # Nordavix role
            "suspended": bool(u.suspended) if u else False,
            "signed_in": u is not None,
        })
    return members


async def name_map(db: AsyncSession, tenant_id: uuid.UUID) -> dict[str, str]:
    """{internal user UUID (str) → display name} for resolving actor IDs that
    tools return (task assignee, preparer/approver, etc.). Unknown ids simply
    won't be present, so callers should fall back gracefully."""
    return {
        m["user_id"]: m["name"]
        for m in await workspace_members(db, tenant_id)
        if m.get("user_id")
    }
