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
  posted     — the entry is in QBO (asserted by a human, or observed by the
               posting check — see posted_qbo_doc)
  dismissed  — rejected / not applicable, with a required reason
A reviewer/admin can reopen an `accepted` entry back to `open` (to change an
account, then re-approve) — even after it's been saved, which pulls it back
out of the saved batch.

Provenance. Every entry answers five questions, and the columns exist so that
it can: where it came from (source / source_ref), what it was computed from
(lines), who decided what and why (prepared_by, approved_by, dismiss_reason,
plus the audit log), what supports it (rationale, the Client Memory fact its
edit taught), and what it changed (posted_qbo_doc, the graph edges, and the
net effect derived from lines). See modules/adjustments/router.entry_trace.

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
    # The last human to touch the row, in any way. Kept for continuity, but it
    # is NOT the maker/checker input any more — see prepared_by below.
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # Why the reviewer chose not to book it. Required on dismiss: a passed
    # adjustment with no reason cannot be reviewed, cannot be defended to an
    # examiner, and teaches Client Memory nothing.
    dismiss_reason: Mapped[str | None] = mapped_column(String(500))

    # ── Who prepared, who approved ──────────────────────────────────────
    # These were one column (status_changed_by), which meant the row could not
    # say who prepared an entry once a reviewer had approved it — the approver's
    # id overwrote the preparer's. The maker/checker gate READ that column, so
    # the control's own action destroyed the control's input: a reviewer who
    # reopened an entry could no longer re-approve it, and after any transition
    # "who made this" survived only in the audit log.
    prepared_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Saved batch ─────────────────────────────────────────────────────
    # Stamped when a fully-approved period is "Saved": the entry is locked
    # (immutable, never deleted) and eligible for the QBO CSV export + posting
    # check. NULL = not yet saved. See modules/adjustments (save_batch).
    saved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    saved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Posting confirmation ────────────────────────────────────────────
    # Stamped when check_posted MATCHES this entry against a real journal entry
    # in QuickBooks: the doc number it was found as, and when we confirmed it.
    # Previously the match result was returned to the browser and never stored,
    # so the most audit-valuable fact in this module ("this adjustment is in the
    # books, as JE-1043, confirmed on 16 Aug") lived in React state until the
    # user changed the period dropdown. `mark-posted` leaves these NULL — that
    # is a human's assertion, not an observation, and the two are not the same
    # evidence.
    posted_qbo_doc:      Mapped[str | None] = mapped_column(String(100))
    posted_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # ── Audit ───────────────────────────────────────────────────────────
    # NULL = system / AI generated (deterministic bank, agentic AI runs)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
