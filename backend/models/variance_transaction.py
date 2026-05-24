"""
VarianceTransaction — evidence row attached to a single variance.

Populated on demand when the user clicks "Find reasons" on a MATERIAL
variance. Each row represents one QBO transaction (JE, invoice, payment,
etc.) that hit the variance's account during the current period. The
`is_checked` flag is the reviewer-controlled "I've looked at this and
it's approved" toggle.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class VarianceTransaction(TenantBase):
    __tablename__ = "variance_transactions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    variance_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    qbo_txn_id: Mapped[str | None] = mapped_column(String(50))
    txn_type: Mapped[str] = mapped_column(String(50), nullable=False)
    txn_number: Mapped[str | None] = mapped_column(String(100))
    txn_date: Mapped[date | None] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    memo: Mapped[str | None] = mapped_column(String(500))
    entity_name: Mapped[str | None] = mapped_column(String(255))
    is_checked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    checked_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
