"""
Relationship — one directed edge in the Nordavix accounting knowledge graph.

Nordavix already stores the objects of a close (reconciliations, journal
entries, accounts, findings, schedules, tasks, memos…); their *relationships*
have lived implicitly, as foreign keys scattered across modules. This table
records those relationships as first-class, queryable data so that — over time —
the AI can follow the links to understand the full story behind a number, a
variance, a reconciliation, or the whole close.

One generic edge table connects heterogeneous objects polymorphically:

    (src_type, src_id) --relation--> (dst_type, dst_id)

e.g. ("journal_entry", <id>) --explains--> ("reconciliation", <id>).

Design notes:
  * Polymorphic refs (string type + string id), NOT foreign keys: a single
    table must join objects of many kinds, so DB-level FK integrity to the
    target row isn't possible. The allowed (src_type, relation, dst_type)
    vocabulary is enforced in code by core/graph/schema.py instead, and the
    existing per-object FKs remain the integrity-bearing source of truth — an
    edge is an additive relationship *index*, never the system of record.
  * Provenance is first-class (`origin`): the graph must distinguish a
    human-asserted link from an AI-inferred one, both for trust and for audit.
  * Soft delete (`deleted_at`): edges are reversible without losing history.
  * Idempotency: one *live* edge per (tenant, src, relation, dst). Enforced by
    a partial unique index (migration 062) AND by service.link() find-or-create,
    so re-running a producer never duplicates an edge.

Tenant isolation: TenantBase adds the indexed `tenant_id` + the fail-closed
SELECT auto-filter; both endpoints of an edge are always the same tenant. The
Tier-2 RLS `tenant_isolation` policy is attached in migration 062.

Migration: 062_relationships.py.
"""
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class Relationship(TenantBase):
    __tablename__ = "relationships"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # ── The edge: (src_type, src_id) --relation--> (dst_type, dst_id) ────────
    # Types + relation are governed by core/graph/schema.py. `*_id` holds the
    # most stable identifier of the referenced object as text (a UUID, a
    # qbo_account_id, or an ISO period date) — see schema.py for the per-type
    # id convention.
    src_type: Mapped[str] = mapped_column(String(40), nullable=False)
    src_id:   Mapped[str] = mapped_column(String(64), nullable=False)
    relation: Mapped[str] = mapped_column(String(40), nullable=False)
    dst_type: Mapped[str] = mapped_column(String(40), nullable=False)
    dst_id:   Mapped[str] = mapped_column(String(64), nullable=False)

    # ── Edge metadata + provenance ──────────────────────────────────────────
    # Optional attributes on the edge itself (confidence, amount, short note).
    attributes: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # How the edge was created: user | ai | system | backfill.
    origin:     Mapped[str] = mapped_column(String(12), nullable=False, default="system")
    # NULL = system / AI / backfill (no specific user).
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    # Soft delete — unlink() stamps this rather than deleting the row, so the
    # edge is reversible and the history of what-was-linked-when is preserved.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
