import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class CloseReview(TenantBase):
    """
    AI Close Review — the reviewing-partner pass over one (workspace, period).

    Autopilot prepares the close; Close Review signs off on it. A run executes
    a battery of deterministic checks (reconciliation hygiene, completeness,
    analytical review, anomalies) plus a bounded AI analytical narrative, and
    records the exceptions as CloseReviewFinding rows. One review per period;
    re-running refreshes the open findings while keeping the reviewer's
    cleared / actioned / accepted decisions sticky.
    """
    __tablename__ = "close_reviews"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # open | signed_off
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    # AI analytical-review narrative ("do these books make sense?"). Null when
    # the AI step was skipped (cap reached / disabled).
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Denormalized snapshot of the last run's exception counts (the open set),
    # so dashboards/digests don't have to aggregate findings.
    high_count:    Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    review_count:  Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    info_count:    Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cleared_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    checks_run:    Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Reassurance list — human strings for the checks that PASSED ("TB balanced",
    # "all bank evidence on file"), so the UI can show what's healthy, not just
    # what's wrong.
    passed: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    generated_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )
    signed_off_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    signed_off_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )


class CloseReviewFinding(TenantBase):
    """One exception raised by a Close Review run, with its own clear/action lifecycle."""
    __tablename__ = "close_review_findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    review_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # Denormalized so findings can be queried per period without the review join.
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # Stable check id, e.g. "recon.not_tied" — together with qbo_account_id /
    # entity_ref it forms the dedupe key that keeps human decisions sticky on re-run.
    code: Mapped[str] = mapped_column(String(60), nullable=False)
    # control | completeness | analytical | anomaly | hygiene
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    # high | review | info
    severity: Mapped[str] = mapped_column(String(10), nullable=False, index=True)

    title:  Mapped[str] = mapped_column(String(300), nullable=False)
    detail: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    recommended_action: Mapped[str | None] = mapped_column(String(300), nullable=True)

    qbo_account_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    account_label:  Mapped[str | None] = mapped_column(String(300), nullable=True)
    # variance id / schedule id / proposed-entry id, when the finding points at one.
    entity_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # frontend nav hint: recon | flux | adjustments | schedules | sync
    link_hint:  Mapped[str | None] = mapped_column(String(60), nullable=True)

    # Structured extras for rich rendering — e.g. a manual-JE anomaly carries
    # {lines:[{account,debit,credit}], amount, txn_date, flags, memo} so the UI
    # shows the entry's account breakdown. Null on findings that don't need it.
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # open | cleared | actioned | accepted
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open", index=True)
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )
