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
    """A persisted advisory item — "we advised X; the client did Y; here's Z".

    It used to stop at Y. A recommendation was one AI sentence with a hardcoded
    priority, no reasoning, and no link to any metric — so the firm could record
    that it had given advice and never find out whether the advice worked. The
    KPI trend was on the same page, six months deep, and nothing joined them.

    The columns below are that join. A recommendation now names the metric it
    means to move, the value that metric had WHEN IT WAS GIVEN, and where it
    should get to by when — which is enough to grade itself every period from
    the KPI series that already exists. See service.grade_progress.
    """
    __tablename__ = "tracked_recommendations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # exec_report_ai | insights_heuristic | manual
    source: Mapped[str] = mapped_column(String(30), nullable=False, default="exec_report_ai")
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="medium")  # high|medium|low
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Which KPI this is meant to move, from service.KPI_CATALOG. The whole
    # tracking spine hangs off it: no key, no grade.
    kpi_key: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # ── The hypothesis ──────────────────────────────────────────────────
    # What the metric read when the advice was given. Captured at write time
    # rather than derived later, because "how far has this moved" has to be
    # measured from where it actually started — recomputing it from today's
    # history would quietly re-baseline every time the series changed.
    baseline_value: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    baseline_at:    Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Where it should get to, and by when. Both optional: some advice is
    # directional ("get this moving") and saying so is better than inventing a
    # number to satisfy a column.
    target_value: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    due_date:     Mapped[date | None] = mapped_column(Date, nullable=True)
    # What it's worth, in money, and the sentence that justifies the figure. A
    # number with no stated basis is the kind a client is right to distrust.
    expected_impact: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True)
    impact_note:     Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Who owns it. Free text, not a user id — the owner is frequently someone
    # at the CLIENT, who has no login here.
    owner: Mapped[str | None] = mapped_column(String(120), nullable=True)

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
