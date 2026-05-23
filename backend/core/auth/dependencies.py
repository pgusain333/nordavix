import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from models.user import User


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


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentTenantId = Annotated[uuid.UUID, Depends(get_current_tenant_id)]
