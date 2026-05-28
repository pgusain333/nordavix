"""
MissedAccrualCandidate — AI-detected payments in the current period that
look like they were for prior-period services (i.e., an accrual was
missed at prior period-end).

When the user clicks "Scan for missed accruals" on the Accruals page,
the detector pulls GL transactions hitting expense accounts in the
month AFTER the viewed period_end (plus first ~15 days of the month
after that to catch late invoices), filters by materiality, and asks
Claude which ones look like they should have been accrued at the
viewed period_end.

Lifecycle (same shape as PrepaidCandidate):
  open       — fresh detection, awaiting user decision
  accepted   — user added a retroactive ScheduleAccrual + reversal;
               accepted_item_id points to it
  dismissed  — user said "not a missed accrual"; silenced for this txn

The (tenant_id, gl_txn_id) pair is the dedup key. A second scan of
the same period reuses existing rows — only NEW txns produce new
candidates.

Migration: 026_missed_accrual_candidates.py.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class MissedAccrualCandidate(TenantBase):
    __tablename__ = "missed_accrual_candidates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The period-end we're worried about missing accruals FOR (NOT the
    # month the txn was paid in). e.g., scanning April GL for items
    # that should've hit a March 31 accrual → period_end = 03-31.
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ── GL transaction context (the payment we noticed) ─────────────
    gl_account_id:   Mapped[str] = mapped_column(String(50),  nullable=False)
    gl_account_name: Mapped[str] = mapped_column(String(255), nullable=False)
    gl_txn_id:       Mapped[str | None] = mapped_column(String(50))
    gl_txn_date:     Mapped[date] = mapped_column(Date, nullable=False)
    gl_amount:       Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    gl_memo:         Mapped[str | None] = mapped_column(String(500))
    gl_vendor:       Mapped[str | None] = mapped_column(String(255))

    # ── AI suggestion fields ────────────────────────────────────────
    ai_vendor:         Mapped[str | None] = mapped_column(String(255))
    # When the AI thinks the service was performed — usually the
    # period_end itself, but for partial-period bills (e.g., utility
    # billing 3/15→4/14) the AI may suggest a different cutoff.
    ai_service_period_end: Mapped[date | None] = mapped_column(Date)
    # Amount the AI thinks should have been accrued. Differs from
    # gl_amount when only part of the bill applies to the prior period.
    ai_suggested_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    ai_confidence:       Mapped[Decimal] = mapped_column(Numeric(3, 2), nullable=False, default=Decimal("0.50"))
    ai_reasoning:        Mapped[str | None] = mapped_column(Text)
    # Suggested target accrued-liability GL account.
    ai_target_account_id: Mapped[str | None] = mapped_column(String(50))

    # ── Lifecycle ──────────────────────────────────────────────────
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open", index=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # When accepted, the resulting ScheduleAccrual id — links to the
    # live schedule row from the candidate.
    accepted_item_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Audit ──────────────────────────────────────────────────────
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
