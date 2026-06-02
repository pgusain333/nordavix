"""
Workspace endpoints — team / member management.

  GET  /workspace/members           Resolved org members (Clerk-backed)
  GET  /workspace/users/lookup       Bulk resolve our user UUIDs → display names

Used by the frontend to render "Reviewed by Jatin" instead of
"Reviewed by 4c1d8a-...-uuid" in the audit log and on the dashboards.
"""
import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.clerk_users import (
    _format_display_name,
    get_clerk_user,
    list_org_memberships,
)
from core.auth.dependencies import (
    CurrentTenantId,
    CurrentUser,
    RequireAdmin,
    require_role,
)
from core.config import settings
from core.db.session import get_db
from core.email.welcome import send_welcome_email
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from models.user import User

# Grace window between soft-delete and irreversible purge. Matches the
# deletion language in the Privacy Policy ("removed within 30 days").
_DELETE_GRACE_DAYS = 30

logger = logging.getLogger(__name__)

router = APIRouter()

_VALID_ROLES = {"admin", "reviewer", "preparer"}


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

    # Index our DB users by clerk_id so we can attach our internal UUID +
    # Nordavix role to each Clerk membership row.
    our_users = list((await db.execute(
        select(User).where(User.tenant_id == tenant_id)
    )).scalars().all())
    clerk_to_user = {u.clerk_user_id: u for u in our_users if u.clerk_user_id}

    members = []
    for m in memberships:
        clerk_id = m.get("user_id") or ""
        first = m.get("first_name") or ""
        last  = m.get("last_name") or ""
        full  = " ".join(p for p in [first, last] if p).strip() or m.get("email") or clerk_id
        u = clerk_to_user.get(clerk_id)
        members.append({
            "id":            str(u.id) if u else None,
            "clerk_user_id": clerk_id,
            "first_name":    first,
            "last_name":     last,
            "display_name":  full,
            "email":         m.get("email"),
            "image_url":     m.get("image_url"),
            "clerk_role":    m.get("role"),     # Clerk's org role (org:admin / org:member)
            "role":          u.role if u else "preparer",  # Nordavix role
        })
    return {"members": members}


@router.get("/me")
async def get_me(
    user: CurrentUser,
    tenant_id: CurrentTenantId,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Current user's role + identity. The middleware handles most role
    provisioning at sign-in; this endpoint adds one extra safety net:
    if the caller's tenant has zero admins (e.g. the create-company
    flow lost a race and the founder ended up as a non-admin in their
    own workspace), promote the requester to admin so they can finish
    setting up (invite team, connect QBO, etc.).

    Strict scope — only fires when there's literally no admin at all.
    For tenants that already have an admin, role stays exactly as set.
    """
    if user.role != "admin":
        admin_count = (await db.execute(
            select(User).where(User.tenant_id == tenant_id, User.role == "admin")
        )).scalars().all()
        if not list(admin_count):
            old_role = user.role
            user.role = "admin"
            await db.commit()
            await db.refresh(user)
            from core.audit.log import write_audit_event
            await write_audit_event(
                db, tenant_id=tenant_id, user_id=user.id,
                action="workspace.role_self_heal_to_admin",
                entity_type="user", entity_id=user.id,
                metadata={
                    "summary":  f"Promoted {user.email} to admin (no admin existed in tenant)",
                    "old_role": old_role,
                    "new_role": "admin",
                },
            )
            await db.commit()

    # First-sign-in welcome email — once per person. `welcomed_at` gates it;
    # the cross-tenant check stops a multi-workspace founder being welcomed
    # twice. Cheap no-op after the first call (welcomed_at is set thereafter).
    if user.welcomed_at is None:
        first_ever = (await db.execute(
            select(User.id).where(
                User.clerk_user_id == user.clerk_user_id,
                User.welcomed_at.isnot(None),
            ),
            execution_options={"skip_tenant_filter": True},
        )).first() is None
        user.welcomed_at = datetime.now(UTC)
        await db.commit()
        if first_ever and settings.email_enabled and user.email:
            background_tasks.add_task(
                send_welcome_email,
                to_email=user.email,
                clerk_user_id=user.clerk_user_id,
                cta_url=settings.web_url + "/app",
            )

    return {
        "id":            str(user.id),
        "clerk_user_id": user.clerk_user_id,
        "email":         user.email,
        "role":          user.role or "preparer",
    }


@router.post("/members/{member_id}/role", dependencies=[Depends(require_role("admin"))])
async def set_member_role(
    member_id: uuid.UUID,
    body: dict,
    tenant_id: CurrentTenantId,
    current_user: RequireAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Admin-only: change a workspace member's role.
    Body: { role: "admin" | "reviewer" | "preparer" }

    Guards against an admin demoting themselves to the last admin (would
    lock the workspace out of admin actions). At least one admin must
    remain at all times.
    """
    new_role = (body.get("role") or "").strip().lower()
    if new_role not in _VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(_VALID_ROLES)}")

    target = (await db.execute(
        select(User).where(User.id == member_id)
    )).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found.")

    # Last-admin guard
    if target.role == "admin" and new_role != "admin":
        admin_count = (await db.execute(
            select(User).where(User.role == "admin")
        )).scalars().all()
        if len(list(admin_count)) <= 1:
            raise HTTPException(
                status_code=409,
                detail="Cannot demote the last admin. Promote another member to admin first.",
            )

    old_role = target.role
    target.role = new_role

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=current_user.id,
        action="workspace.role_changed",
        entity_type="user", entity_id=target.id,
        metadata={
            "summary":  f"Changed {target.email} role: {old_role} → {new_role}",
            "user_id":  str(target.id),
            "old_role": old_role,
            "new_role": new_role,
        },
    )
    await db.commit()
    return {"id": str(target.id), "role": target.role}


@router.get("/invitations")
async def list_invitations(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """List pending Clerk org invitations for this workspace."""
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if tenant is None:
        return {"invitations": []}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://api.clerk.com/v1/organizations/{tenant.clerk_org_id}/invitations",
                params={"status": "pending", "limit": 100},
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
        if resp.status_code != 200:
            logger.warning("Clerk invitations fetch returned %s", resp.status_code)
            return {"invitations": []}
        body = resp.json()
        rows = body.get("data") if isinstance(body, dict) else body
        out = []
        for inv in rows or []:
            out.append({
                "id":             inv.get("id"),
                "email":          inv.get("email_address"),
                "clerk_role":     inv.get("role"),
                "nordavix_role":  (inv.get("public_metadata") or {}).get("nordavix_role") or "preparer",
                "created_at":     inv.get("created_at"),
                "expires_at":     inv.get("expires_at"),
                "status":         inv.get("status"),
            })
        return {"invitations": out}
    except Exception:
        logger.exception("Listing invitations failed")
        return {"invitations": []}


@router.post("/invitations", dependencies=[Depends(require_role("admin"))])
async def create_invitation(
    body: dict,
    tenant_id: CurrentTenantId,
    current_user: RequireAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Admin-only: create a Clerk org invitation. The invited email gets a
    Clerk-sent invitation; their intended Nordavix role is stashed in the
    invitation's public_metadata so we can apply it when they first sign in.
    Body: { email: string, role: "admin" | "reviewer" | "preparer" }
    """
    email = (body.get("email") or "").strip().lower()
    role  = (body.get("role")  or "preparer").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Valid email required.")
    if role not in _VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(_VALID_ROLES)}")

    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found.")

    # When a user signs into Nordavix without ever creating a Clerk
    # organization, the tenancy middleware provisions a personal
    # pseudo-org keyed `user_<clerk_user_id>`. That's not a real
    # Clerk org — calling Clerk's /v1/organizations/{id}/invitations
    # with a pseudo-org id returns 404 ("Clerk: not found"), which
    # is what the user just hit. Detect it up-front and tell them
    # the actual fix: create a workspace via the Companies page.
    if not tenant.clerk_org_id or tenant.clerk_org_id.startswith("user_"):
        # Log enough to diagnose stale-JWT cases: the API saw `org_id`
        # missing from the Clerk token even though the user may have a
        # company workspace selected in the UI. Most often this means
        # the JWT was issued before the org switch and Clerk's cache
        # hasn't rolled it over yet.
        logger.warning(
            "Invite blocked — current request resolved to personal workspace "
            "(tenant.clerk_org_id=%s, user.clerk_user_id=%s). "
            "Either no active org or stale JWT cache.",
            tenant.clerk_org_id, current_user.clerk_user_id,
        )
        raise HTTPException(
            status_code=400,
            detail=(
                "You're on a personal workspace right now, so invites can't be "
                "sent. Click your company name in the top-left, choose 'Switch "
                "company' to load a real workspace, then try the invite again. "
                "If you just switched companies, a hard refresh (Ctrl+Shift+R) "
                "will pick up the change."
            ),
        )

    # Map our role → Clerk's built-in roles. Admin = org:admin so they can
    # manage the org in Clerk's hosted pages; reviewer/preparer = member.
    #
    # NOTE: the default non-admin role key is `org:member` in modern
    # Clerk production instances. The older `org:basic_member` key only
    # exists in some legacy dev instances; sending it against a current
    # production instance returns a 404 "Organization role not found"
    # which we wrap as "Clerk organization isn't accessible" — masking
    # the real cause. Always use `org:member` going forward.
    clerk_role = "org:admin" if role == "admin" else "org:member"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://api.clerk.com/v1/organizations/{tenant.clerk_org_id}/invitations",
                json={
                    "email_address": email,
                    "role":          clerk_role,
                    "inviter_user_id": current_user.clerk_user_id,
                    "public_metadata": {"nordavix_role": role},
                },
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
        if resp.status_code not in (200, 201):
            try:
                detail = resp.json().get("errors", [{}])[0].get("message") or resp.text
            except Exception:
                detail = resp.text
            # Translate Clerk's two most common errors into actionable copy.
            if resp.status_code == 404:
                logger.warning(
                    "Clerk 404 inviting %s to org=%s inviter=%s — org or inviter missing in Clerk",
                    email, tenant.clerk_org_id, current_user.clerk_user_id,
                )
                raise HTTPException(
                    status_code=404,
                    detail=(
                        "The workspace's Clerk organization isn't accessible "
                        "(it may have been deleted or the link is stale). "
                        "Go to Companies and pick / recreate the workspace, "
                        "then try again."
                    ),
                )
            if resp.status_code == 422 and "already" in detail.lower():
                raise HTTPException(
                    status_code=409,
                    detail=f"{email} already has an invitation or is already a member.",
                )
            raise HTTPException(status_code=resp.status_code, detail=f"Clerk: {detail}")
        inv = resp.json()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Clerk invitation create failed")
        raise HTTPException(status_code=502, detail=f"Could not create invitation: {e}")

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=current_user.id,
        action="workspace.invited",
        entity_type="invitation", entity_id=None,
        metadata={
            "summary":  f"Invited {email} as {role}",
            "email":    email,
            "role":     role,
        },
    )
    await db.commit()
    return {
        "id":            inv.get("id"),
        "email":         inv.get("email_address"),
        "nordavix_role": role,
        "status":        inv.get("status"),
    }


@router.delete("/invitations/{invitation_id}", dependencies=[Depends(require_role("admin"))])
async def revoke_invitation(
    invitation_id: str,
    tenant_id: CurrentTenantId,
    current_user: RequireAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Admin-only: revoke a pending Clerk org invitation."""
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://api.clerk.com/v1/organizations/{tenant.clerk_org_id}/invitations/{invitation_id}/revoke",
                json={"requesting_user_id": current_user.clerk_user_id},
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not revoke: {e}")

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=current_user.id,
        action="workspace.invitation_revoked",
        entity_type="invitation", entity_id=None,
        metadata={"summary": f"Revoked invitation {invitation_id}"},
    )
    await db.commit()
    return {"id": invitation_id, "status": "revoked"}


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


@router.get("/ai-usage")
async def get_ai_usage(
    tenant_id: CurrentTenantId,
) -> dict:
    """
    Current calendar-month AI spend vs the workspace's cap. Powers the usage
    indicator in Settings so users can see how much AI budget remains before
    they hit the limit. Read-only; available to any member.
    """
    from core.ai.budget import get_budget_status
    status = await get_budget_status(tenant_id)
    return status.as_dict()


@router.delete("", dependencies=[Depends(require_role("admin"))])
async def delete_workspace(
    tenant_id: CurrentTenantId,
    current_user: RequireAdmin,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Admin-only: delete this workspace (the Danger Zone action).

    Soft-delete with a 30-day grace window:
      1. Revoke + delete the QBO connection so no live token to the company's
         books survives the moment of deletion.
      2. Mark the tenant deleted_at = now, purge_after = now + 30d. The tenancy
         middleware immediately returns 410 for every request to this tenant —
         it's inaccessible everywhere from this point on.
      3. A scheduled purge job hard-deletes all the tenant's data + R2 files
         once the grace window elapses. Audit logs are retained.

    The deletion is recoverable (by clearing deleted_at) until the purge runs.
    The frontend destroys the Clerk organization separately after this returns.
    """
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found.")

    if tenant.deleted_at is not None:
        # Idempotent — already scheduled for purge.
        return {
            "deleted": True,
            "already_deleted": True,
            "purge_after": tenant.purge_after.isoformat() if tenant.purge_after else None,
        }

    # 1. Sever the live QBO link (revoke at Intuit + drop local tokens).
    qbo_revoked: bool | None = None
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id)
    )).scalar_one_or_none()
    if conn is not None:
        from modules.qbo.router import revoke_qbo_token
        qbo_revoked = await revoke_qbo_token(conn)
        await db.delete(conn)

    # 2. Soft-delete + schedule purge.
    now = datetime.now(UTC)
    tenant.deleted_at = now
    tenant.purge_after = now + timedelta(days=_DELETE_GRACE_DAYS)
    tenant.deleted_by = current_user.id

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=current_user.id,
        action="workspace.deleted",
        entity_type="tenant", entity_id=tenant_id,
        metadata={
            "summary":      f"Deleted workspace (purge after {tenant.purge_after.date().isoformat()})",
            "purge_after":  tenant.purge_after.isoformat(),
            "qbo_revoked":  qbo_revoked,
            "grace_days":   _DELETE_GRACE_DAYS,
        },
    )
    await db.commit()
    return {
        "deleted": True,
        "purge_after": tenant.purge_after.isoformat(),
        "grace_days": _DELETE_GRACE_DAYS,
        "qbo_revoked": qbo_revoked,
    }
