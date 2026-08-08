"""ReconConclusion — the frozen working paper behind an approved reconciliation.

`account_review_status` records what was CONCLUDED: the subledger total, the
reconciling items, who signed it. It does not record how that conclusion was
ARRIVED AT, and the recon screen pulls its GL balances live from QuickBooks on
every render. So a reconciliation approved in March and reopened in June can
show different numbers, because the source moved underneath. The approval was a
signature on a view that no longer exists.

This is that view, frozen at the moment of sign-off — the same discipline
`alloc_run` already applies by snapshotting its drivers, and the reason a
§471(c) workpaper still reproduces years later.

Each element of the derivation carries its ORIGIN:

    system  — pulled or computed deterministically; reproducible and sourced
    human   — entered by a named person
    ai      — proposed by a model, with its confidence AND who accepted it

That last distinction is where AI auditability actually lives. A fuzzy match a
model proposed and a preparer confirmed is a different evidentiary object from
one nobody looked at, and without the field they are identical rows.

SUPERSEDED, never replaced. Reopening a reconciliation writes a new conclusion
and retires the old one. "What did we approve in March, before it was reopened"
is precisely the question an examiner asks, so the answer has to survive the
reopen.

Hashed like the audit log (core/audit/chain.py): the snapshot is evidence, and
evidence that can be edited without trace is not evidence.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, Date, DateTime, Numeric, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class ReconConclusion(TenantBase):
    __tablename__ = "recon_conclusion"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    period_end:     Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ── The two sides, as they stood at sign-off ──────────────────────────────
    gl_balance:        Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    gl_source:         Mapped[str | None] = mapped_column(String(120))
    gl_as_of:          Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    subledger_total:   Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    subledger_origin:  Mapped[str] = mapped_column(String(20), nullable=False, default="human")
    # The document itself, not a description of it. No FK: evidence may be
    # removed later, and losing the file must not erase the record that the
    # conclusion rested on it.
    subledger_evidence_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    variance:     Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    reconciled:   Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ── The derivation ────────────────────────────────────────────────────────
    # [{label, amount, origin, note, ai_confidence, accepted_by}] — the
    # reconciling items with their provenance, exactly as approved.
    items: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]",
    )
    # Whatever the model contributed (commentary, suggested matches), kept
    # beside the figures rather than in place of them.
    ai_basis: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    # ── Sign-off ──────────────────────────────────────────────────────────────
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    prepared_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # active | superseded — a reopen retires, never overwrites.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", server_default="active", index=True,
    )
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # SHA-256 over the canonical snapshot. Evidence that can be edited without
    # trace isn't evidence.
    content_hash: Mapped[str | None] = mapped_column(String(64))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
