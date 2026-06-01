import uuid
from collections.abc import Awaitable, Callable

import jwt
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware

from core.auth.clerk import verify_clerk_token
from core.db.base import current_tenant_id
from core.db.session import AsyncSessionLocal
from models.tenant import Tenant
from models.user import User

# Routes that do not require authentication (exact paths or prefixes)
_PUBLIC_PATHS = {"/api/health", "/docs", "/redoc", "/openapi.json"}
# Path prefixes that are always public (e.g. OAuth callbacks from third parties).
# /api/internal/ bypasses Clerk auth because it's called by schedulers/cron, not
# users — those endpoints are instead gated by the X-Internal-Secret shared
# secret (see modules/internal/router.py). They have NO tenant context.
_PUBLIC_PREFIXES = {"/api/oauth/", "/api/internal/"}


class TenantMiddleware(BaseHTTPMiddleware):
    """
    Per-request middleware that authenticates the caller and establishes tenant context.

    Flow:
      1. Skip public routes.
      2. Verify Clerk JWT → extract org_id (tenant) and sub (user).
      3. Look up (or create) Tenant and User records using skip_tenant_filter
         because current_tenant_id is not yet set at this point.
      4. Set current_tenant_id ContextVar so all downstream ORM queries are
         automatically scoped to the correct tenant.
      5. Attach tenant_id and user to request.state for use by dependencies.
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        is_public = (
            request.method == "OPTIONS"  # always allow CORS preflight through
            or request.url.path in _PUBLIC_PATHS
            or not request.url.path.startswith("/api/")
            or any(request.url.path.startswith(p) for p in _PUBLIC_PREFIXES)
        )
        if is_public:
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse({"detail": "Missing authentication token"}, status_code=401)

        token = auth_header.removeprefix("Bearer ")
        try:
            claims = verify_clerk_token(token)
        except jwt.PyJWTError:
            return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)

        # Clerk session tokens carry the active org id in different
        # shapes depending on token version:
        #   v1 / custom templates  → claims.org_id
        #   v2 (current default)   → claims.o.id        (compact form)
        # Read both so the backend works regardless of which token type
        # the frontend SDK happens to issue.
        clerk_org_id: str | None = claims.get("org_id")  # type: ignore[assignment]
        if not clerk_org_id:
            o = claims.get("o") or {}
            if isinstance(o, dict):
                v = o.get("id")
                if isinstance(v, str) and v:
                    clerk_org_id = v
        clerk_user_id: str | None = claims.get("sub")  # type: ignore[assignment]

        if not clerk_user_id:
            return JSONResponse({"detail": "Invalid token: missing user ID"}, status_code=401)

        if not clerk_org_id:
            # Log the actual claim keys present so we can debug Clerk
            # template misconfiguration. Don't log values (PII).
            import logging as _logging
            _logging.getLogger(__name__).info(
                "No active org in Clerk JWT — claim keys present: %s",
                sorted(claims.keys()),
            )

        # Fall back to a user-scoped pseudo-org when no org is selected.
        # This lets solo users (no Clerk org) use the app — their tenant is keyed on their user ID.
        effective_org_id = clerk_org_id or f"user_{clerk_user_id}"

        # Bootstrap queries use skip_tenant_filter because current_tenant_id is not set yet.
        skip = {"skip_tenant_filter": True}
        async with AsyncSessionLocal() as session:
            tenant_result = await session.execute(
                select(Tenant).where(Tenant.clerk_org_id == effective_org_id),
                execution_options=skip,
            )
            tenant = tenant_result.scalar_one_or_none()

            # ── Soft-delete gate ────────────────────────────────────────────
            # A deleted workspace is inaccessible everywhere until its 30-day
            # grace window elapses and the purge job removes it. Block here —
            # before we provision a User row or run any business logic — so no
            # endpoint can read or mutate a deleted tenant's data. 410 Gone (not
            # 403) tells the frontend the resource is intentionally gone so it
            # can drop the org from the switcher rather than show a perms error.
            if tenant is not None and tenant.deleted_at is not None:
                return JSONResponse(
                    {
                        "detail": "This workspace has been deleted.",
                        "code": "tenant_deleted",
                        "purge_after": tenant.purge_after.isoformat()
                        if tenant.purge_after
                        else None,
                    },
                    status_code=410,
                )

            if tenant is None:
                # First time this org/user hits the API — provision their tenant record.
                tenant = Tenant(
                    id=uuid.uuid4(),
                    clerk_org_id=effective_org_id,
                    name=effective_org_id,
                )
                session.add(tenant)
                await session.flush()

            # Look up the User row PER (clerk_user_id, tenant_id), not by
            # clerk_user_id alone.
            #
            # The original lookup ignored tenant — which meant a user who
            # joined two workspaces shared a single User row across both,
            # and the role from the first one bled into the second. The
            # damage:
            #   - Founder pixelhouse signed in via Google -> Clerk auto-
            #     created a personal org -> User row created with
            #     tenant_id = personal-org, role = admin.
            #   - Later they created the real workspace "Apple Inc" ->
            #     when they signed into Apple Inc, middleware found the
            #     SAME User row (still tied to the personal org!) and
            #     reported role=admin. require_role("admin") passed in
            #     Apple Inc even though they had no membership record
            #     scoped to that tenant.
            #   - Worse: when a real preparer was invited and signed in,
            #     the "first user in tenant" check (existing_users == [])
            #     fired falsely (because the founder's row was bound to a
            #     different tenant) and the preparer got auto-promoted
            #     to admin of Apple Inc.
            #
            # Filtering by (clerk_user_id, tenant_id) gives each
            # workspace its own User row with its own role. Cross-org
            # role bleeding stops.
            user_result = await session.execute(
                select(User).where(
                    User.clerk_user_id == clerk_user_id,
                    User.tenant_id == tenant.id,
                ),
                execution_options=skip,
            )
            user = user_result.scalar_one_or_none()

            if user is None:
                # Try the JWT claim first (fast path). Clerk's default
                # JWT template does NOT include `email`, so this is
                # usually empty — in that case, fall back to a one-shot
                # Clerk REST lookup so the row has a real email from
                # day one (drives PDF preparer/approver names, audit
                # log "by" chips, etc.).
                email: str = claims.get("email", "")  # type: ignore[assignment]
                if not email:
                    try:
                        from core.auth.clerk_users import get_clerk_user
                        cu = await get_clerk_user(clerk_user_id)
                        if cu and cu.get("email"):
                            email = cu["email"]
                    except Exception:
                        # Don't block sign-in if Clerk lookup hiccups —
                        # the PDF render path has its own fallback.
                        pass
                # Provision the new user's role:
                # - First user in the tenant → admin (sole-owner case)
                # - Subsequent users → "preparer" by default; if the user
                #   was invited and their Clerk invitation carried a
                #   `nordavix_role` in public_metadata, honor it.
                existing_users = list((await session.execute(
                    select(User).where(User.tenant_id == tenant.id),
                    execution_options=skip,
                )).scalars().all())

                if not existing_users:
                    role = "admin"
                else:
                    role = "preparer"
                    # JWT claims sometimes include public_metadata for invited users.
                    pm = claims.get("public_metadata") or claims.get("user_public_metadata") or {}
                    if isinstance(pm, dict):
                        invited_role = (pm.get("nordavix_role") or "").strip().lower()
                        if invited_role in {"admin", "reviewer", "preparer"}:
                            role = invited_role

                user = User(
                    id=uuid.uuid4(),
                    tenant_id=tenant.id,
                    clerk_user_id=clerk_user_id,
                    email=email,
                    role=role,
                )
                session.add(user)

            # Heal legacy role values on every request — covers the case
            # where migration 011 hasn't run for an old workspace yet.
            # We do it here (not in /me) so the User stays attached to the
            # session that owns it; a remote commit from a different
            # endpoint session causes "detached instance" errors.
            if user.role in (None, "", "member"):
                user.role = "admin"

            # Heal empty email on the signed-in user (rows created
            # before middleware did the Clerk fallback above). Cheap:
            # one Clerk call per affected user, cached for 5 min, then
            # we never touch this path again for that user.
            if not user.email and user.clerk_user_id:
                try:
                    from core.auth.clerk_users import get_clerk_user
                    cu = await get_clerk_user(user.clerk_user_id)
                    if cu and cu.get("email"):
                        user.email = cu["email"]
                except Exception:
                    pass

            await session.commit()
            # Refresh to get server-side timestamps after commit
            await session.refresh(tenant)
            await session.refresh(user)

        # Set the ContextVar — all ORM queries from here forward are tenant-scoped.
        current_tenant_id.set(tenant.id)
        request.state.tenant_id = tenant.id
        request.state.tenant = tenant
        request.state.user = user

        return await call_next(request)
