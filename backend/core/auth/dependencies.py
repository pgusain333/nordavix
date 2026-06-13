import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from models.user import User

# Role hierarchy — higher index = more privilege.
# admin can do everything; reviewer can approve; preparer can enter/edit but
# not approve.
ROLE_ORDER = {"preparer": 0, "reviewer": 1, "admin": 2}


def get_current_user(request: Request) -> User:
    """
    FastAPI dependency: returns the authenticated user set by TenantMiddleware.

    Raises 401 if middleware did not populate request.state.user (should not
    happen in practice since middleware blocks unauthenticated requests first).
    """
    user: User | None = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


def get_current_tenant_id(request: Request) -> uuid.UUID:
    """FastAPI dependency: returns the active tenant_id from request state."""
    tenant_id: uuid.UUID | None = getattr(request.state, "tenant_id", None)
    if tenant_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return tenant_id


def require_role(min_role: str):
    """
    Build a dependency that 403s unless the current user's role is at least
    `min_role` in the ROLE_ORDER hierarchy. Use as:

        @router.post("/something", dependencies=[Depends(require_role("admin"))])
    """
    threshold = ROLE_ORDER.get(min_role, 0)

    def _check(user: User = Depends(get_current_user)) -> User:
        actual = ROLE_ORDER.get(user.role or "preparer", 0)
        if actual < threshold:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"This action requires the {min_role} role. "
                    f"Your role is {user.role or 'preparer'}."
                ),
            )
        return user

    return _check


# Admin-powers an admin can delegate to a non-admin member, beyond their role.
# The role (preparer/reviewer) still governs prepare vs approve (segregation of
# duties); these are the cross-cutting governance actions that are admin-only by
# default but can be handed out one at a time on the Team access panel.
DELEGATABLE_POWERS = {"autopilot", "pbc", "period_lock", "qbo"}


def require_capability(power: str):
    """
    Build a dependency that 403s unless the user can perform `power`.

    Admins always pass (master access). Any other member passes only if `power`
    is in their delegated_powers grant. Role-based prepare/approve gates are
    unaffected — this layers on top for the delegatable admin-powers.
    """
    def _check(user: User = Depends(get_current_user)) -> User:
        if (user.role or "preparer") == "admin":
            return user
        if power in (getattr(user, "delegated_powers", None) or []):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "You don't have permission for this action. Ask an admin to grant "
                f"you the '{power}' power on the Team page."
            ),
        )

    return _check


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentTenantId = Annotated[uuid.UUID, Depends(get_current_tenant_id)]
RequireAdmin    = Annotated[User, Depends(require_role("admin"))]
RequireReviewer = Annotated[User, Depends(require_role("reviewer"))]
