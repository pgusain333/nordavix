"""One row per Risk Radar scan — the evidence that we are actually watching.

Continuous close is a claim about time, and a claim about time needs a record.
This table is what lets a screen say "last checked 12 minutes ago · 1,847
transactions reviewed · 2 open" instead of the word "real-time", which a client
has to take on faith and a partner will (rightly) push back on.

`ok` stays NULL until the run finishes. A scan that crashed or is still going
must never be read as "we checked and everything was fine" — the absence of
findings is only reassuring when the check completed.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class GlScanRun(TenantBase):
    __tablename__ = "gl_scan_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    # 'sync' | 'scheduled' | 'manual'. "We check hourly" and "it ran because you
    # pressed sync" are different claims; only one is continuous monitoring.
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, default="sync")

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ok: Mapped[bool | None] = mapped_column(Boolean)
    error: Mapped[str | None] = mapped_column(Text)

    transactions_reviewed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    accounts_scanned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    findings_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Findings whose first_seen_at was set by THIS run.
    findings_new: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
