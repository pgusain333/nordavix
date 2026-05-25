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
# Path prefixes that are always public (e.g. OAuth callbacks from third parties)
_PUBLIC_PREFIXES = {"/api/oauth/"}


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

        clerk_org_id: str | None = claims.get("org_id")  # type: ignore[assignment]
        clerk_user_id: str | None = claims.get("sub")  # type: ignore[assignment]

        if not clerk_user_id:
            return JSONResponse({"detail": "Invalid token: missing user ID"}, status_code=401)

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

            if tenant is None:
                # First time this org/user hits the API — provision their tenant record.
                tenant = Tenant(
                    id=uuid.uuid4(),
                    clerk_org_id=effective_org_id,
                    name=effective_org_id,
                )
                session.add(tenant)
                await session.flush()

            user_result = await session.execute(
                select(User).where(User.clerk_user_id == clerk_user_id),
                execution_options=skip,
            )
            user = user_result.scalar_one_or_none()

            if user is None:
                email: str = claims.get("email", "")  # type: ignore[assignment]
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
