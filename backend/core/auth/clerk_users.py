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
