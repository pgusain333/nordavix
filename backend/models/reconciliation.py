"""
Reconciliation models.

A Reconciliation is the header for one AR / AP / Bank / CC reconciliation run.
ReconciliationItem is one customer/vendor/account row within it.
ReconTransaction holds evidence rows used by the detail page (unmatched,
unapplied cash, duplicates, manual JEs).
ReconNote is the audit trail of human commentary.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Date, DateTime, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase
from core.db.mixins import TimestampMixin

# AR | AP | BANK | CC | OTHER
ReconType = str


class Reconciliation(TimestampMixin, TenantBase):
    __tablename__ = "reconciliations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    recon_type: Mapped[ReconType] = mapped_column(String(20), nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)

    gl_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    subledger_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    difference: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))

    # pending | syncing | computing | in_review | approved | error
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending")

    ai_summary: Mapped[str | None] = mapped_column(Text)
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    error_detail: Mapped[str | None] = mapped_column(String(1000))


class ReconciliationItem(TenantBase):
    __tablename__ = "reconciliation_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reconciliation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)

    entity_name: Mapped[str] = mapped_column(String(255), nullable=False)
    entity_qbo_id: Mapped[str | None] = mapped_column(String(50))

    gl_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    subledger_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    difference: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))

    aging_current: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    aging_1_30: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    aging_31_60: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    aging_61_90: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    aging_over_90: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))

    risk_level: Mapped[str] = mapped_column(String(10), nullable=False, default="low")
    # pending | reviewed | approved | flagged | resolved
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")

    ai_commentary: Mapped[str | None] = mapped_column(Text)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ReconTransaction(TenantBase):
    """
    Evidence row attached to a ReconciliationItem.

    `category` drives which detail-page section it shows under:
        unmatched | unapplied_cash | duplicate | manual_je
    `meta` carries free-form details (e.g. {"duplicate_of": "INV-1234"}).
    """
    __tablename__ = "recon_transactions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reconciliation_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    txn_type: Mapped[str] = mapped_column(String(50), nullable=False)
    txn_number: Mapped[str | None] = mapped_column(String(100))
    txn_date: Mapped[date | None] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    memo: Mapped[str | None] = mapped_column(String(500))
    category: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ReconNote(TenantBase):
    __tablename__ = "recon_notes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reconciliation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    reconciliation_item_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    author_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
