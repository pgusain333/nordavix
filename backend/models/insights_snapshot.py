"""
Cached Insights overview per (tenant, period).

Insights are snapshot-first + a live AR/AP aging pull, so recomputing on every
visit is wasteful and slow. We persist the full computed payload here and serve
it instantly on revisit; a "Sync" recomputes and upserts this row.
"""
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class InsightsSnapshot(TenantBase):
    """One cached Insights overview per (tenant_id, period_end, period_start)."""

    __tablename__ = "insights_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end:   Mapped[date] = mapped_column(Date, nullable=False)
    period_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    # The full /overview JSON blob the frontend renders.
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # Bumped on every (re)compute — surfaced as "Synced {time}" in the UI.
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
