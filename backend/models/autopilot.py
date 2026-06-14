import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class AutopilotConfig(TenantBase):
    """
    Close Autopilot — the one-time setup, one row per workspace.

    When enabled, the monthly scheduler (or a manual "Run now") kicks off
    the close for the focus period: sync from QBO → AI agentic preparer on
    every open account → (optionally) flux analysis with AI commentary →
    (optionally, EXPLICIT opt-in) magic-link evidence requests to the
    client for bank/card accounts missing statements → a digest email.

    send_pbc_requests defaults OFF by design: many preparers already have
    the statements, and emailing clients is an outward-facing action that
    must be a deliberate choice, not a side effect.
    """
    __tablename__ = "autopilot_configs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Day of month (1-28) the scheduled run fires for this workspace.
    run_day: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # Optional step toggles. Sync + agentic preparer are the core and always
    # run when enabled; these gate the AI-spend / outward-facing extras.
    run_flux: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    send_pbc_requests: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    pbc_recipient_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # AI reviewing-partner (Close Review) pass after flux/evidence — surfaces
    # reconciliation-hygiene / completeness / anomaly exceptions in the digest.
    # On by default (read-only analysis); the run already performs it, this just
    # makes it controllable + visible.
    run_review: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true",
    )
    # Attach the Financial Package PDF (IS / BS / CF from the synced snapshot)
    # to the digest email. Off by default — keeps the digest light unless asked.
    attach_reports: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
    )

    updated_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )


class AutopilotRun(TenantBase):
    """One Autopilot execution for (workspace, period) — status + results."""
    __tablename__ = "autopilot_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)
    # running | completed | partial | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="running")
    # schedule | manual
    triggered_by: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")
    started_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # Per-step summary: {synced, accounts_total, prepared, ai_analyzed,
    # skipped, flagged, flux_created, flux_variances, flux_material,
    # flux_ai_queued, pbc_sent, errors: [str]}
    results: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
