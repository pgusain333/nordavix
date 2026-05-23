import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import Date, Numeric, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase
from core.db.mixins import TimestampMixin


class TrialBalance(TimestampMixin, TenantBase):
    """
    One trial balance upload: current period + prior period side by side.

    Status progression:
        pending → processing → parsed → ready_for_review → complete
                                                          ↘ error (any stage)
    """
    __tablename__ = "trial_balances"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    period_current: Mapped[date] = mapped_column(Date, nullable=False)
    period_prior: Mapped[date] = mapped_column(Date, nullable=False)
    # pending | processing | parsed | ready_for_review | generating | complete | error
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="pending")
    # R2 object key for the original uploaded file; null until upload completes
    r2_key: Mapped[str | None] = mapped_column(String(500))
    # Dollar threshold for materiality — variances above this are flagged for AI generation
    materiality_threshold: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    # Maps user's column headers to our canonical fields (stored so re-parse is possible)
    column_mapping: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    # Overrides for account-number-to-FS-line mapping (default is GAAP 4-digit ranges)
    fs_line_mapping: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # Error detail stored here when status = "error" — no client data, only technical message
    error_detail: Mapped[str | None] = mapped_column(String(1000))
