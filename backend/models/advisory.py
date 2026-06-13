import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class KpiTarget(TenantBase):
    """A firm-set target for one KPI, used to grade the longitudinal trend
    (met / missed). One active target per (workspace, kpi_key)."""
    __tablename__ = "kpi_targets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    kpi_key: Mapped[str] = mapped_column(String(60), nullable=False)
    # gte (at least) | lte (at most) | between
    comparator: Mapped[str] = mapped_column(String(10), nullable=False, default="gte")
    target_value: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    target_value_upper: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)

    updated_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )


class TrackedRecommendation(TenantBase):
    """A persisted, status-trackable advisory item — turns the exec report's
    ephemeral recommendations into "we advised X; the client did Y"."""
    __tablename__ = "tracked_recommendations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # exec_report_ai | insights_heuristic | manual
    source: Mapped[str] = mapped_column(String(30), nullable=False, default="exec_report_ai")
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="medium")  # high|medium|low
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    kpi_key: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # open | in_progress | done | dismissed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open", index=True)
    client_action: Mapped[str | None] = mapped_column(Text, nullable=True)   # "what the client did"
    outcome_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )
