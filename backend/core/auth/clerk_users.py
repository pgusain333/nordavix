"""
Resolve Clerk user IDs to display names + emails via Clerk's REST API.

Used by /workspace/members and any place we render `user_id` UUIDs to the
end user (audit log entries, reviewed-by / prepared-by chips, etc.).

Backed by a small in-memory TTL cache so a busy reviewer dashboard
doesn't hammer Clerk for every row render. Cache is global per process —
fine for a few-machines deployment; would need Redis for horizontal scale.
"""
from __future__ import annotations

import logging
import time
from typing import TypedDict

import httpx

from core.config import settings

logger = logging.getLogger(__name__)

_TTL_SECONDS = 300  # 5 minutes
_cache: dict[str, tuple[ClerkUser, float]] = {}


class ClerkUser(TypedDict):
    id: str
    first_name: str | None
    last_name: str | None
    email: str | None
    image_url: str | None


def _format_display_name(u: ClerkUser) -> str:
    """Return 'First Last', or email if no name, or the user_id as a last resort."""
    parts = [u.get("first_name") or "", u.get("last_name") or ""]
    joined = " ".join(p for p in parts if p).strip()
    return joined or (u.get("email") or u["id"])


async def get_clerk_user(clerk_user_id: str) -> ClerkUser | None:
    """Fetch a single user from Clerk by ID, with TTL cache."""
    if not clerk_user_id:
        return None
    now = time.time()
    cached = _cache.get(clerk_user_id)
    if cached and now - cached[1] < _TTL_SECONDS:
        return cached[0]

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"https://api.clerk.com/v1/users/{clerk_user_id}",
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
        if resp.status_code != 200:
            logger.warning("Clerk user fetch %s returned %s", clerk_user_id, resp.status_code)
            return None
        data = resp.json()
        emails = data.get("email_addresses", []) or []
        primary_email_id = data.get("primary_email_address_id")
        primary_email = next(
            (e.get("email_address") for e in emails if e.get("id") == primary_email_id),
            emails[0].get("email_address") if emails else None,
        )
        user: ClerkUser = {
            "id":         data.get("id"),
            "first_name": data.get("first_name"),
            "last_name":  data.get("last_name"),
            "email":      primary_email,
            "image_url":  data.get("image_url"),
        }
    except Exception:
        logger.exception("Clerk user fetch failed for %s", clerk_user_id)
        return None

    _cache[clerk_user_id] = (user, now)
    return user


async def clerk_user_exists(clerk_user_id: str) -> bool | None:
    """Whether a Clerk user still exists.

    Returns True if Clerk returns the user, False if Clerk says it's gone
    (404 — e.g. the account was deleted), and None on any other/transient
    error (the caller should retry later rather than treat the user as
    deleted). A warm get_clerk_user cache entry counts as 'exists'.
    """
    if not clerk_user_id:
        return None
    cached = _cache.get(clerk_user_id)
    if cached and time.time() - cached[1] < _TTL_SECONDS:
        return True
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"https://api.clerk.com/v1/users/{clerk_user_id}",
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
    except Exception:
        logger.exception("Clerk exists-check failed for %s", clerk_user_id)
        return None
    if resp.status_code == 200:
        return True
    if resp.status_code == 404:
        return False
    logger.warning("Clerk exists-check %s returned %s", clerk_user_id, resp.status_code)
    return None


async def list_org_memberships(clerk_org_id: str) -> list[dict]:
    """
    Return every Clerk membership for an organization. Each row contains:
      { user_id, first_name, last_name, email, role }
    Role is the Clerk role string ('org:admin' / 'org:member' / custom).
    """
    if not clerk_org_id:
        return []
    out: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://api.clerk.com/v1/organizations/{clerk_org_id}/memberships",
                params={"limit": 100},
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
        if resp.status_code != 200:
            logger.warning("Clerk memberships fetch %s returned %s", clerk_org_id, resp.status_code)
            return []
        body = resp.json()
        rows = body.get("data") if isinstance(body, dict) else body
        for m in rows or []:
            pud = m.get("public_user_data") or {}
            out.append({
                "user_id":    pud.get("user_id"),
                "first_name": pud.get("first_name"),
                "last_name":  pud.get("last_name"),
                "email":      pud.get("identifier"),
                "image_url":  pud.get("image_url"),
                "role":       m.get("role"),
            })
            # Also warm the single-user cache so subsequent lookups skip a call.
            uid = pud.get("user_id")
            if uid:
                _cache[uid] = ({
                    "id":         uid,
                    "first_name": pud.get("first_name"),
                    "last_name":  pud.get("last_name"),
                    "email":      pud.get("identifier"),
                    "image_url":  pud.get("image_url"),
                }, time.time())
    except Exception:
        logger.exception("Clerk org memberships fetch failed for %s", clerk_org_id)
        return []
    return out


# ── Organization names ──────────────────────────────────────────────────────

_org_name_cache: dict[str, tuple[str, float]] = {}


async def get_clerk_org_name(clerk_org_id: str) -> str | None:
    """Fetch an organization's display name from Clerk, with TTL cache.

    Used to heal Tenant.name rows that were provisioned before the org
    had a human name (they hold the raw org_... id) — Clerk is the
    canonical source for workspace names.
    """
    if not clerk_org_id:
        return None
    cached = _org_name_cache.get(clerk_org_id)
    if cached and time.time() - cached[1] < _TTL_SECONDS:
        return cached[0]
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"https://api.clerk.com/v1/organizations/{clerk_org_id}",
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
        if resp.status_code != 200:
            logger.warning("Clerk org fetch %s returned %s", clerk_org_id, resp.status_code)
            return None
        name = (resp.json() or {}).get("name")
        if name:
            _org_name_cache[clerk_org_id] = (name, time.time())
        return name
    except Exception:
        logger.exception("Clerk org fetch failed for %s", clerk_org_id)
        return None


# ── Organization membership for a USER ────────────────────────────────────────
#
# Clerk is the source of truth for who belongs to which company. Nordavix used
# to infer that from local `User` rows instead, which broke in both directions:
#
#   • A User row is created lazily, on a member's first request IN that tenant.
#     So an invited teammate had no row until they'd already opened the company
#     — and the firm view, which lists companies you can access, showed them
#     nothing. To find a company you had to have already been in it.
#
#   • Nothing removes the row when someone is removed in CLERK. A person taken
#     off the organization there kept working access here.
#
# Resolving from Clerk fixes both at once, needs no webhooks, and can't drift.
_user_orgs_cache: dict[str, tuple[list[str], float]] = {}
# Short: this gates access, so a revocation must take effect quickly. Long
# enough that a page of API calls doesn't hit Clerk for every request.
_USER_ORGS_TTL = 60.0


async def list_user_org_ids(clerk_user_id: str, *, force: bool = False) -> list[str] | None:
    """Clerk organization ids this user belongs to.

    Returns None — never an empty list — when Clerk can't be reached. The
    distinction matters: callers must be able to FAIL CLOSED on an error rather
    than read it as "belongs to nothing", and must never quietly fall back to
    local rows, which is the exact behaviour this replaces.
    """
    if not clerk_user_id:
        return []

    now = time.time()
    if not force:
        cached = _user_orgs_cache.get(clerk_user_id)
        if cached and now - cached[1] < _USER_ORGS_TTL:
            return list(cached[0])

    org_ids: list[str] = []
    offset = 0
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            while True:
                resp = await client.get(
                    f"https://api.clerk.com/v1/users/{clerk_user_id}/organization_memberships",
                    params={"limit": 100, "offset": offset},
                    headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
                )
                if resp.status_code != 200:
                    logger.warning(
                        "Clerk org memberships for user %s returned %s",
                        clerk_user_id, resp.status_code,
                    )
                    return None
                body = resp.json()
                rows = (body.get("data") if isinstance(body, dict) else body) or []
                for m in rows:
                    org = m.get("organization") or {}
                    oid = org.get("id") or m.get("organization_id")
                    if oid:
                        org_ids.append(str(oid))
                if len(rows) < 100:
                    break
                offset += 100
    except Exception:
        logger.exception("Clerk org-membership fetch failed for user %s", clerk_user_id)
        return None

    _user_orgs_cache[clerk_user_id] = (org_ids, now)
    return org_ids


def invalidate_user_orgs(clerk_user_id: str) -> None:
    """Drop the cached membership list — call after granting or revoking access
    so the change is visible immediately rather than up to a TTL later."""
    _user_orgs_cache.pop(clerk_user_id, None)
