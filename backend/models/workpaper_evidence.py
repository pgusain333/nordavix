"""
WorkpaperEvidence — a supporting document attached to any workpaper in a period.

Generalizes the per-account [[SubledgerEvidence]] pattern to the whole close: the
file lives in R2, this row is metadata + the R2 key, tied to
(tenant_id, period_end, ref_type, ref_id). `ref_type` names the workpaper kind —
account | schedule | adjustment | flux | financials | general — and `ref_id`
points at it (the qbo_account_id, schedule id, …); a free-form "general"
supporting document has a null ref_id.

The Workpapers workspace lists these per binder row, and the Close Binder folds
them in as a referenced evidence appendix. These are user-uploaded support —
never QuickBooks data (the QBO connection stays read-only).

Migration: 056_workpaper_evidence.py.
"""
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class WorkpaperEvidence(TenantBase):
    __tablename__ = "workpaper_evidence"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # Which workpaper this supports. account | schedule | adjustment | flux |
    # financials | general.
    ref_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # The workpaper id (qbo_account_id, schedule id, …); null for general docs.
    ref_id: Mapped[str | None] = mapped_column(String(80), index=True)

    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    # Tenant-scoped R2 key — see core.storage.r2.tenant_key()
    r2_key: Mapped[str] = mapped_column(String(500), nullable=False)
    # Optional short caption shown on the workpaper + in the binder appendix.
    note: Mapped[str | None] = mapped_column(Text)

    uploaded_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Optional cached AI read of the document (deferred — populated by a later
    # "verify" pass that reuses the recon ai_verify helper).
    verification: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
