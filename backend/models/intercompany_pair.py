"""
IntercompanyPair — links an IC account in this tenant to an IC account
in another tenant the user has cross-org access to.

Pairs are written symmetrically — two rows per pair, one in each
tenant, sharing a pair_group_id. This keeps every read tenant-scoped
(no special cross-tenant query plumbing) while letting both sides see
the same logical pair.

Lifecycle:
  - Created via POST /intercompany/pairs (writes both halves in a single tx)
  - Deleted via DELETE /intercompany/pairs/{pair_group_id} (removes both halves)
  - Read via GET /intercompany/pairs (tenant-scoped — each side sees its own row)
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class IntercompanyPair(TenantBase):
    __tablename__ = "intercompany_pairs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Shared identifier for both halves of the pair. DELETE by pair_group_id
    # removes both rows.
    pair_group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)

    # "My side" — account in this tenant (the row's tenant_id)
    my_qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False)

    # "Other side" — counterparty tenant + account
    counterparty_tenant_id:      Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    counterparty_clerk_org_id:   Mapped[str] = mapped_column(String(255), nullable=False)
    counterparty_qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False)
    # Cached display label — "AcmeCo · 2150 Intercompany Payable" — written
    # at pair creation so the UI doesn't refetch the other-side metadata
    # on every render.
    counterparty_label:          Mapped[str] = mapped_column(String(500), nullable=False)

    notes: Mapped[str | None] = mapped_column(Text)

    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
