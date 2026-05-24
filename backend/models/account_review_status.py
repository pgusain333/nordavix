"""
AccountReviewStatus — per-account, per-period reconciliation review state.

The reconciliations dashboard pulls data live from QBO, so we don't persist
the balances themselves. But we DO need to persist the human workflow on
top: "I've reviewed this account for April 2026, approved by me on
2026-05-15." That's what this table tracks.

Unique on (tenant_id, qbo_account_id, period_end) so each account+period
has exactly one status row.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class AccountReviewStatus(TenantBase):
    __tablename__ = "account_review_status"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    # pending | reviewed | approved | flagged
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
