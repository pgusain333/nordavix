"""
Schedule item models — Prepaids, Accruals, Fixed Assets, Leases, Loans
plus the ScheduleSnapshot header that links a schedule to a recon.

Each schedule type gets its own SQLAlchemy model for type-safe queries
and clean per-type validation. They share a common shape via mixin-
free inheritance from TenantBase (no hidden magic — each class lists
its columns so future readers see exactly what's stored).

The qbo_account_id on every item ties the schedule line back to the
GL account it rolls up to. The snapshot pivots type+account+period
into the single subledger value the recon module reads from
account_review_status.

Migration: 023_schedules.py.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class _ScheduleItemBase(TenantBase):
    """Shared columns. Concrete subclasses set __tablename__ + add type-specific cols."""
    __abstract__ = True

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    vendor: Mapped[str | None] = mapped_column(String(255))
    reference: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class SchedulePrepaid(_ScheduleItemBase):
    """One prepaid invoice. Amortized over [start_date, end_date].

    amortization_method controls the recognition pattern:
      daily_rate    — total / inclusive day count, applied per day
                      (precise for mid-month policies; legacy default)
      straight_line — total / N per calendar month touched, recognized
                      at month-end (CPA-conventional "even monthly")
    """
    __tablename__ = "schedule_prepaids"

    invoice_date: Mapped[date | None] = mapped_column(Date)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    amortization_method: Mapped[str] = mapped_column(String(20), nullable=False, default="daily_rate")


class ScheduleAccrual(_ScheduleItemBase):
    """One accrued expense entry. Active until reverses_on; flagged when paid."""
    __tablename__ = "schedule_accruals"

    accrual_date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    reverses_on: Mapped[date | None] = mapped_column(Date)
    is_reversed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ScheduleFixedAsset(_ScheduleItemBase):
    """One capitalized asset. Straight-line depreciation over useful_life_months."""
    __tablename__ = "schedule_fixed_assets"

    category: Mapped[str | None] = mapped_column(String(100))
    in_service_date: Mapped[date] = mapped_column(Date, nullable=False)
    cost: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    salvage_value: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    useful_life_months: Mapped[int] = mapped_column(Integer, nullable=False)
    depreciation_method: Mapped[str] = mapped_column(String(20), nullable=False, default="straight_line")
    accumulated_dep_qbo_account_id: Mapped[str | None] = mapped_column(String(50))
    disposed_on: Mapped[date | None] = mapped_column(Date)
    disposal_proceeds: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))


class ScheduleLease(_ScheduleItemBase):
    """
    One lease. Tracks payments by default; if ASC 842 fields are filled
    (discount_rate_pct, initial_rou_asset, initial_liability), also rolls
    forward ROU asset + lease liability per period.
    """
    __tablename__ = "schedule_leases"

    lessor: Mapped[str | None] = mapped_column(String(255))
    lease_start: Mapped[date] = mapped_column(Date, nullable=False)
    lease_end: Mapped[date] = mapped_column(Date, nullable=False)
    monthly_payment: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    discount_rate_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    initial_rou_asset: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    initial_liability: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    rou_qbo_account_id: Mapped[str | None] = mapped_column(String(50))


class ScheduleLoan(_ScheduleItemBase):
    """
    One loan. payment_type:
      amortizing      — fixed monthly P+I, principal paydown computed
      interest_only   — interest each month; full principal due at maturity
      balloon         — partial principal each month; remainder due at maturity
    """
    __tablename__ = "schedule_loans"

    lender: Mapped[str | None] = mapped_column(String(255))
    loan_date: Mapped[date] = mapped_column(Date, nullable=False)
    original_principal: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    interest_rate_pct: Mapped[Decimal] = mapped_column(Numeric(6, 4), nullable=False)
    term_months: Mapped[int] = mapped_column(Integer, nullable=False)
    monthly_payment: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    payment_type: Mapped[str] = mapped_column(String(20), nullable=False, default="amortizing")


class ScheduleSnapshot(TenantBase):
    """
    Period-end roll-forward for a (schedule_type, qbo_account_id) pair.

    Computed from the current schedule items at /preview time; persisted
    on commit. Commit also upserts account_review_status.subledger_total
    to the snapshot's ending_balance, so the reconciliations module
    surfaces the schedule value as the subledger without any module-level
    coupling.

    Unique on (tenant, type, account, period_end) — rerunning the roll-
    forward upserts in place.
    """
    __tablename__ = "schedule_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    schedule_type: Mapped[str] = mapped_column(String(20), nullable=False)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)

    beginning_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    additions:         Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    period_expense:    Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    payments:          Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    other:             Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    ending_balance:    Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    item_count:        Mapped[int]     = mapped_column(Integer, nullable=False, default=0)

    # draft | committed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    committed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
