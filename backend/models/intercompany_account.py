"""
IntercompanyAccount — flags a GL account as an intercompany account
(transactions with a related entity). Auto-detected by name pattern
on first scan; persisted across syncs so manual classifications
survive.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class IntercompanyAccount(TenantBase):
    __tablename__ = "intercompany_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False)
    counterparty:   Mapped[str | None] = mapped_column(String(200))
    # 'receivable' | 'payable' | 'unknown'
    kind:           Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    auto_detected:  Mapped[bool] = mapped_column(Boolean(), nullable=False, default=False)
    notes:          Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
