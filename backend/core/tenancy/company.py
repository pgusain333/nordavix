"""The workspace's name, exactly as the person who owns it typed it.

`Tenant.name` is seeded with the raw Clerk org id (`org_2abc…`) the first time
an org hits the API, because the middleware that provisions the row has the id
and not the name. Clerk is the canonical source, and a single endpoint — the
firm dashboard — healed the placeholder on its way past. Nothing else did.

So the name a caller got depended on whether anyone had happened to open the
firm view. Three callers each noticed independently and invented their own
patch: autopilot substituted "Your company", the PBC magic link substituted
"Your accountant", and the exports substituted "Workspace" or "Nordavix". None
of them fixed it; each just hid it in a different place, and the Copilot's PDF
cover had no patch at all — it printed the raw org id onto a client
deliverable, or the vendor's name in place of the client's.

One accessor, used everywhere, that resolves a placeholder against Clerk
instead of papering over it. It does not write — see the note in the function —
so persisting the healed row stays with the firm-view endpoint that already did
it. The Clerk lookup is TTL-cached and only runs while the name is still a
placeholder, so a named workspace never pays for it at all.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.tenant import Tenant

logger = logging.getLogger(__name__)

# Clerk mints organization ids as "org_" + a ULID-ish suffix. A Tenant.name
# still holding one was never given a human name.
_PLACEHOLDER_PREFIX = "org_"


def is_placeholder(name: str | None) -> bool:
    """True when this is the provisioning id rather than a name a person chose.

    A workspace genuinely called "org_" something is not a case worth ruining
    this for, but the check stays exact-prefix so "Organic Foods Ltd" is never
    mistaken for one.
    """
    return not name or not name.strip() or name.startswith(_PLACEHOLDER_PREFIX)


async def company_name(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    *,
    fallback: str = "Workspace",
) -> str:
    """The workspace's display name — verbatim, never transformed.

    No title-casing, no truncation, no sanitising: whatever the admin typed is
    what appears on the cover of a document their client will read. Callers
    that need to put it in a *filename* sanitise it there, for the filesystem's
    sake, and leave the displayed name alone.

    `fallback` is used only when the row is missing or Clerk cannot be reached.
    Pick one that reads sensibly in the caller's context — and never the vendor
    name, which on a client deliverable is worse than a generic word.
    """
    try:
        tenant = (await db.execute(
            select(Tenant).where(Tenant.id == tenant_id)
        )).scalar_one_or_none()
    except Exception:
        logger.exception("company_name: tenant lookup failed for %s", tenant_id)
        return fallback

    if tenant is None:
        return fallback
    if not is_placeholder(tenant.name):
        return tenant.name

    # Still a placeholder — ask Clerk.
    #
    # Deliberately a PURE READ: no assignment to tenant.name, no commit. This
    # is called from inside an autopilot run and from export handlers that own
    # their own transactions, and a read accessor that commits someone else's
    # in-flight work — or leaves their session dirty so their next commit
    # writes something they never asked for — is a much worse bug than an
    # occasional extra lookup. get_clerk_org_name is TTL-cached, so the cost is
    # one call per org per TTL, not one per export.
    #
    # Persisting the healed name stays where it already was: the firm-view
    # endpoint, which does it in a transaction it owns. Correctness here does
    # not depend on that having run.
    try:
        from core.auth.clerk_users import get_clerk_org_name
        real = await get_clerk_org_name(tenant.clerk_org_id)
    except Exception:
        logger.exception("company_name: Clerk lookup failed for %s", tenant_id)
        return fallback

    return real or fallback
