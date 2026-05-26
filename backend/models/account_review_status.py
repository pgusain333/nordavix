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
from decimal import Decimal
from typing import Any

from sqlalchemy import Date, DateTime, Numeric, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
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
    # Preparer / reviewer split — tracked independently so the Tasks
    # UI can show both actors without overwriting each other. Migration
    # 014 added these; older rows get backfilled from reviewed_*.
    prepared_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    prepared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    # Manual subledger override: when set, the overview uses this value as the
    # subledger balance for this account+period (overrides the QBO default).
    # Lets users reconcile against external sources (bank statements, FA
    # registers, prepaid schedules) that QBO doesn't expose.
    subledger_total: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    subledger_source: Mapped[str | None] = mapped_column(String(255))
    subledger_entered_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    subledger_entered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Selected current-period transactions that explain the GL-vs-subledger
    # variance. Classic bank-rec "outstanding items" pattern: GL has a check
    # the bank hasn't cleared yet → user selects that check → its amount sums
    # toward closing the gap. Stored as a JSON list, not a join table, because
    # the items are snapshots (we never need to query "all overrides that
    # reconciled against txn X").
    reconciling_items: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb"), default=list,
    )
    # Structured commentary written by the agentic preparer when it ties
    # out a reconciliation. NULL on human-prepared rows or when AI couldn't
    # tie out. See modules/recons/agentic.build_ai_commentary() for shape:
    # { generated_at, confidence, checks[], recommendation, narrative }.
    ai_commentary: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
