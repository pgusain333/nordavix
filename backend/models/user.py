import uuid

from sqlalchemy import String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase
from core.db.mixins import TimestampMixin


class User(TimestampMixin, TenantBase):
    """
    A Clerk user provisioned within a tenant.

    Roles in v1: "admin" (full access) or "member" (can approve/edit narratives).
    Granular permission enforcement is deferred to a future release — the data
    model supports it from day one via the `role` field.
    """
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    # role: "admin" | "member" — enforced at application layer (not DB constraint) for flexibility
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="member")
