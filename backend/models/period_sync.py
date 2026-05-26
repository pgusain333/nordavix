"""
PeriodSync — one row per (tenant, period_end). Holds the QBO-derived
data that we used to fetch live on every overview render: AR/AP aging
totals and YTD Net Income (for the trial-balance check). Written by
the explicit Sync action; the overview endpoint reads it instead of
calling QBO. Pairs with `gl_balance_snapshots` (per-account GL balances)
to make navigation between months instant.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Numeric, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class PeriodSync(TenantBase):
    __tablename__ = "period_sync"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    # Natural-positive magnitudes — sign handling for AP happens in the
    # subledger derivation, not at storage.
    ar_aging_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    ap_aging_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    # Cross-check value — nullable because P&L pulls can fail without
    # invalidating the rest of the sync; the UI just hides the TB-check
    # card when this is None.
    actual_net_income: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    pl_error: Mapped[str | None] = mapped_column(Text)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
