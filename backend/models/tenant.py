import uuid
from typing import Any

from sqlalchemy import String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import Base
from core.db.mixins import TimestampMixin


class Tenant(TimestampMixin, Base):
    """
    Represents one accounting firm or company using Nordavix.

    Inherits from Base (not TenantBase) because this table IS the tenant —
    it is not scoped by tenant_id. All other tables reference this via FK.
    """
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # clerk_org_id is the join key between Clerk's auth system and our tenant table
    clerk_org_id: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    # Flexible settings blob: materiality defaults, account range overrides, branding, etc.
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
