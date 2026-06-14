"""
Client Memory — the per-client "AI brain" that learns each workspace's
conventions and feeds them back into future AI runs.

Two tables, both tenant-scoped (TenantBase → auto tenant filter on SELECT):

ClientMemorySignal — the raw learning events. Every time a human edits or
dismisses an AI-proposed adjusting entry, we record what the AI proposed vs
what the human chose. These are the observations the system learns from.

ClientMemoryFact — distilled, durable conventions promoted from repeated
signals (e.g. "for adjustments on this account, the offset is 6120 · Bank
Fees"). A fact is only ever APPLIED once a human confirms it (status
`active`) — Nordavix suggests, the human approves. Nothing changes AI output
silently.

Slice 1 learns the offset-account correction on recon/bank adjusting entries;
the model is general enough for materiality, vendor-treatment, and tone facts
later.

Migration: 049_client_memory.py.
"""
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class ClientMemorySignal(TenantBase):
    """One learning observation: what the AI proposed vs what the human did."""
    __tablename__ = "client_memory_signals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # account_swap | memo_edit | dismissed | accepted_asis
    signal_type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    # bank | recon | flux — where the proposed entry came from
    source:     Mapped[str] = mapped_column(String(10), nullable=False)
    source_ref: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)

    # The bucket the distiller groups on — the account the entry reconciles
    # (== the proposed entry's source_ref). Indexed for the count query.
    account_key:       Mapped[str | None] = mapped_column(String(160), index=True)
    proposed_entry_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # The meaningful change, structured. For account_swap:
    #   before = {"account_number": "6000", "account_name": "Misc"}
    #   after  = {"account_number": "6120", "account_name": "Bank Fees",
    #             "account_qbo_id": "83"}
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after:  Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ClientMemoryFact(TenantBase):
    """A distilled, durable convention. Applied only when status == 'active'."""
    __tablename__ = "client_memory_facts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # offset_account (slice 1) | memo_phrase | materiality | ...
    kind:     Mapped[str] = mapped_column(String(30), nullable=False)
    # canonical grouping key, one per convention per tenant — the upsert target.
    #   e.g. "recon:offset:<qbo_account_id>"
    fact_key: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    title:    Mapped[str] = mapped_column(String(400), nullable=False)
    # structured payload the apply-step reads, e.g.
    #   {"to_account_number": "6120", "to_account_name": "Bank Fees",
    #    "to_account_qbo_id": "83", "from_account_number": "6000", ...}
    value:    Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")

    # how many times the underlying correction has been observed
    confidence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # suggested | active | dismissed | stale
    status:     Mapped[str] = mapped_column(String(20), nullable=False, default="suggested", index=True)
    # {"seen": 3, "signal_ids": [...]}
    provenance: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")

    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
