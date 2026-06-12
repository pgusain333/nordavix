import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Date, DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class EvidenceRequest(TenantBase):
    """
    A PBC ("Prepared By Client") document request.

    The preparer asks the client for a specific document (bank statement,
    invoice, agreement) for one (account, period). The client receives a
    magic link — a single-purpose, expiring URL — and uploads without an
    account. Files land as ordinary SubledgerEvidence rows on the same
    account + period, so the maker/checker flow and audit trail pick them
    up with zero extra steps.

    Security: the raw token is NEVER stored — only its SHA-256 hash. The
    link is the credential, so possession of the database alone can't
    forge a working upload URL. Lifecycle: pending → fulfilled (first
    client upload) | cancelled; expiry is enforced at read time.
    """
    __tablename__ = "evidence_requests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    period_end: Mapped[datetime] = mapped_column(Date, nullable=False, index=True)

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    note: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    account_label: Mapped[str | None] = mapped_column(String(255), nullable=True)

    recipient_email: Mapped[str] = mapped_column(String(255), nullable=False)
    recipient_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # pending | fulfilled | cancelled
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # [{file_name, file_size, uploaded_at, evidence_id}] — the client's uploads.
    files: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)

    send_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )
