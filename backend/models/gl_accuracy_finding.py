"""
GlAccuracyFinding — one flagged GL entry the accuracy watchdog believes may be
miscoded, with the evidence behind the accusation.

The watchdog is deterministic: it learns each vendor's account-posting habit from
this client's own history and flags a current-period entry that breaks a strong
habit (e.g. AWS posted to Office Supplies when 11 of its last 12 went to Hosting).
The accusation is arithmetic, never a guess — `dominant_count / total_count` is
stored so the UI can show the literal tally and the human can audit it.

Confirm-first, and Nordavix NEVER writes to QuickBooks:
  open           — fresh flag, awaiting review
  in_adjustments — accepted: a reclass ProposedEntry was filed in Adjustments
                   (linked_proposed_entry_id); the human posts it to QBO there
  dismissed      — reviewer judged the coding correct; a confirmed vendor→account
                   exception is recorded in Client Memory so it's never re-flagged

Idempotency: a re-scan replaces only `open` findings for a period; `in_adjustments`
and `dismissed` rows are the human's decisions and are never clobbered. finding_key
= "<qbo_txn_id>:<posted_account_id>" is unique per (tenant, period_end).

Migration: 054_gl_accuracy_findings.py.
"""
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class GlAccuracyFinding(TenantBase):
    __tablename__ = "gl_accuracy_findings"
    __table_args__ = (
        UniqueConstraint("tenant_id", "period_end", "finding_key",
                         name="uq_gl_accuracy_findings_tenant_period_key"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # Stable dedupe key for idempotent re-scan: "<qbo_txn_id>:<posted_account_id>".
    finding_key: Mapped[str] = mapped_column(String(160), nullable=False, index=True)

    # ── Risk Radar — which detector raised this + how it reads/resolves ──
    # kind:        misclassification | missing_recurring | duplicate | ... (registry)
    # severity:    cross-kind triage rank — high | medium | low
    # action_kind: how Accept resolves it — reclass | accrual | flag (review-only)
    kind:        Mapped[str] = mapped_column(String(40), nullable=False, default="misclassification", index=True)
    severity:    Mapped[str] = mapped_column(String(10), nullable=False, default="medium")
    action_kind: Mapped[str] = mapped_column(String(20), nullable=False, default="reclass")
    title:       Mapped[str | None] = mapped_column(String(200))
    detail:      Mapped[str | None] = mapped_column(Text)
    evidence:    Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    # ── The flagged transaction ─────────────────────────────────────────
    vendor:      Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    qbo_txn_id:  Mapped[str | None] = mapped_column(String(50))
    txn_type:    Mapped[str | None] = mapped_column(String(60))
    txn_number:  Mapped[str | None] = mapped_column(String(60))
    txn_date:    Mapped[date | None] = mapped_column(Date)
    # Signed (debit-positive), as QBO reports it — accept builds the reclass JE
    # in the matching direction.
    amount:      Mapped[Numeric] = mapped_column(Numeric(18, 2), nullable=False)
    memo:        Mapped[str | None] = mapped_column(String(500))

    # ── Accounts ────────────────────────────────────────────────────────
    posted_account_id:    Mapped[str | None] = mapped_column(String(50))   # the "wrong" account
    posted_account_name:  Mapped[str | None] = mapped_column(String(255))
    suggested_account_id: Mapped[str | None] = mapped_column(String(50))   # the dominant "right" account
    suggested_account_name: Mapped[str | None] = mapped_column(String(255))

    # ── Evidence (the arithmetic) ───────────────────────────────────────
    dominant_count: Mapped[int] = mapped_column(Integer, nullable=False)   # → suggested account
    total_count:    Mapped[int] = mapped_column(Integer, nullable=False)   # vendor's history count
    posted_count:   Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # history to posted acct
    # high | medium
    confidence:  Mapped[str] = mapped_column(String(10), nullable=False, default="medium")

    # ── Lifecycle ───────────────────────────────────────────────────────
    # open | in_adjustments | dismissed
    status:            Mapped[str] = mapped_column(String(20), nullable=False, default="open", index=True)
    linked_proposed_entry_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note:              Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
