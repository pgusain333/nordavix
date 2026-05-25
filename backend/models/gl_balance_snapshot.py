"""
GL balance snapshot — one row per (account, period_end).

Persisted on every recons sync so the Financial Package's
"Nordavix synced" source can build IS / BS / CF from our own data
without re-hitting QBO reports per render. Signed (debit-positive)
to match QBO's TrialBalance convention.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class GlBalanceSnapshot(TenantBase):
    __tablename__ = "gl_balance_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False)
    period_end:     Mapped[date] = mapped_column(Date, nullable=False)
    account_number: Mapped[str | None] = mapped_column(String(50))
    account_name:   Mapped[str] = mapped_column(String(255), nullable=False)
    account_type:   Mapped[str] = mapped_column(String(50),  nullable=False)
    balance:        Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    captured_at:    Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
