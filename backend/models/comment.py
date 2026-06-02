"""
Comment — one message in a discussion thread attached to an entity.

Threads are addressed polymorphically by (entity_type, entity_id), e.g.
a reconciliation ("reconciliation", "<qbo_account_id>:<period_end>") or a flux
variance ("variance", "<variance_uuid>"). `mentions` is the list of internal
user-id strings @mentioned in the body; each drives a notification. Soft-deleted
via `deleted_at` so a removed comment leaves no gap in the audit trail.
"""
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class Comment(TenantBase):
    __tablename__ = "comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_type:    Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id:      Mapped[str] = mapped_column(String(100), nullable=False)
    author_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    body:           Mapped[str] = mapped_column(Text, nullable=False)
    # List of internal user-id strings @mentioned in the body.
    mentions:       Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    # In-app deep link the mention notification opens (set by the composer).
    link:           Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at:     Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    edited_at:      Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at:     Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
