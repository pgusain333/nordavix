"""
PrepaidCandidate — AI-detected potential prepaid items found in the GL.

When the user clicks "Scan GL for prepaids" on the Prepaids page, the
detector pulls recent expense-account transactions (Insurance, Software,
Rent, Subscriptions, etc.), filters by materiality, and asks Claude to
identify which ones look like prepaid items that should be amortized
rather than expensed immediately. Each surviving suggestion becomes a
PrepaidCandidate row.

Lifecycle:
  open       — fresh detection, awaiting user decision
  accepted   — user clicked "Add to schedule"; accepted_item_id points
               to the resulting SchedulePrepaid row (so re-scans don't
               re-suggest it)
  dismissed  — user clicked "Not a prepaid"; permanently silenced for
               this txn (matched by gl_txn_id)

The (tenant_id, gl_txn_id) pair is the dedup key. A second scan of the
same period reuses existing candidates — only NEW txns produce new rows.

Migration: 024_prepaid_candidates.py.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class PrepaidCandidate(TenantBase):
    __tablename__ = "prepaid_candidates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ── GL transaction context (the source row in QBO) ──────────────────
    gl_account_id:   Mapped[str] = mapped_column(String(50),  nullable=False)
    gl_account_name: Mapped[str] = mapped_column(String(255), nullable=False)
    gl_txn_id:       Mapped[str | None] = mapped_column(String(50))
    gl_txn_date:     Mapped[date] = mapped_column(Date, nullable=False)
    gl_amount:       Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    gl_memo:         Mapped[str | None] = mapped_column(String(500))
    gl_vendor:       Mapped[str | None] = mapped_column(String(255))

    # ── AI suggestion fields ────────────────────────────────────────────
    ai_vendor:           Mapped[str | None] = mapped_column(String(255))
    ai_service_start:    Mapped[date | None] = mapped_column(Date)
    ai_service_months:   Mapped[int | None]  = mapped_column(Integer)
    ai_method:           Mapped[str] = mapped_column(String(20), nullable=False, default="straight_line")
    # 0.00 to 1.00 — how sure the model is. Displayed as a chip in the UI.
    ai_confidence:       Mapped[Decimal] = mapped_column(Numeric(3, 2), nullable=False, default=Decimal("0.50"))
    ai_reasoning:        Mapped[str | None] = mapped_column(Text)
    # Suggested target prepaid GL account (where the new SchedulePrepaid
    # should be posted). Often inferred from the expense account's name
    # (e.g. "Insurance Expense" → suggest "Prepaid Insurance" if it
    # exists in the chart).
    ai_target_account_id: Mapped[str | None] = mapped_column(String(50))

    # ── Lifecycle ──────────────────────────────────────────────────────
    # open | accepted | dismissed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open", index=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # When accepted, the resulting SchedulePrepaid id — lets the UI link
    # back from a candidate row to the live schedule item.
    accepted_item_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Audit ──────────────────────────────────────────────────────────
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
