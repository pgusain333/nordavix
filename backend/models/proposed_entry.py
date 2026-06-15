"""
ProposedEntry — an AI-drafted (or deterministically-derived) adjusting
journal entry that the user reviews and copies into QuickBooks.

Nordavix's AI already *explains* close differences — reconciliation
commentary, flux variance narratives, bank "money on the statement but not
in the GL" items. This model turns each explanation into a concrete,
reviewable journal entry so the last mile (booking the fix) is one approve +
copy away instead of a manual re-derivation.

We never write to QBO. A proposed entry is a draft the human posts; status
tracks the review lifecycle so the close has a record of what was suggested
and what happened to it.

Sources (where the draft came from):
  bank   — deterministic, from a bank_only reconciliation item. source_ref
           is the bank GL account's qbo_account_id.
  recon  — from the recon agentic commentary (modules/recons/agentic.py).
           source_ref is the reconciled account's qbo_account_id.
  flux   — from the flux deep-agentic run (modules/flux/deep_agentic.py).
           source_ref is the Variance id.

Lifecycle:
  open       — fresh draft, awaiting review
  accepted   — a reviewer approved it as the right entry to post
  posted     — the human booked it in QBO and marked it done
  dismissed  — rejected / not applicable

Idempotency: regenerating the source (re-run AI, re-pull bank GL) replaces
only the OPEN proposals for a given (tenant_id, source, source_ref,
period_end) — accepted / posted / dismissed rows are the human's decisions
and are never clobbered. See modules/adjustments/service.replace_open_proposals.

`lines` is a JSONB list of JE lines, each:
    {"account_qbo_id": str|None, "account_number": str|None,
     "account_name": str, "debit": "0.00", "credit": "0.00"}
Stored balanced (Σ debit == Σ credit) — the service refuses to persist an
unbalanced draft as `open`.

Migration: 040_proposed_entries.py.
"""
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class ProposedEntry(TenantBase):
    __tablename__ = "proposed_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # ── Provenance ──────────────────────────────────────────────────────
    # bank | recon | flux | gl_accuracy
    source:     Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # origin key: qbo_account_id (bank/recon) or Variance id (flux)
    source_ref: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ── The drafted entry ───────────────────────────────────────────────
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    lines:       Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    memo:        Mapped[str | None] = mapped_column(String(500))
    rationale:   Mapped[str | None] = mapped_column(Text)
    # high | medium | low
    confidence:  Mapped[str] = mapped_column(String(10), nullable=False, default="medium")

    # ── Lifecycle ───────────────────────────────────────────────────────
    # open | accepted | posted | dismissed
    status:            Mapped[str] = mapped_column(String(20), nullable=False, default="open", index=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Saved batch ─────────────────────────────────────────────────────
    # Stamped when a fully-approved period is "Saved": the entry is locked
    # (immutable, never deleted) and eligible for the QBO CSV export + posting
    # check. NULL = not yet saved. See modules/adjustments (save_batch).
    saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    saved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Audit ───────────────────────────────────────────────────────────
    # NULL = system / AI generated (deterministic bank, agentic AI runs)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
