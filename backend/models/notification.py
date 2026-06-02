"""
In-app notification — one row per (recipient user, event).

Created alongside the actions that already write the audit log (e.g. a period
close). The bell badge counts rows where read_at IS NULL; the panel lists the
most recent. `link` is an in-app route the frontend navigates to on click.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class Notification(TenantBase):
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The internal User.id this notification is for.
    recipient_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    type:        Mapped[str] = mapped_column(String(50), nullable=False)
    title:       Mapped[str] = mapped_column(String(300), nullable=False)
    body:        Mapped[str | None] = mapped_column(Text, nullable=True)
    link:        Mapped[str | None] = mapped_column(String(500), nullable=True)
    entity_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    entity_id:   Mapped[str | None] = mapped_column(String(100), nullable=True)
    read_at:     Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at:  Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
