"""
QBO (QuickBooks Online) OAuth connection record.

Stores the OAuth2 tokens for a tenant's QuickBooks connection.
One record per tenant (unique on tenant_id).
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase
from core.security.crypto import EncryptedString


class QboConnection(TenantBase):
    """OAuth2 connection to QuickBooks Online for a tenant."""

    __tablename__ = "qbo_connections"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # QuickBooks company realm ID (returned during OAuth callback)
    realm_id: Mapped[str] = mapped_column(String(100), nullable=False)
    # Company name from QBO token introspection
    company_name: Mapped[str | None] = mapped_column(String(255))
    # OAuth2 access token (short-lived, ~1 hour). Encrypted at rest via
    # EncryptedString (TEXT-backed, so no migration). Legacy plaintext rows
    # are read transparently and re-encrypted on their next write/refresh.
    access_token: Mapped[str] = mapped_column(EncryptedString, nullable=False)
    # OAuth2 refresh token (long-lived, ~100 days) — encrypted at rest.
    refresh_token: Mapped[str] = mapped_column(EncryptedString, nullable=False)
    # When the access token expires
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
