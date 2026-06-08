"""
BankStatement — header row for one bank / credit-card reconciliation
(qbo_account_id, period_end). Complements bank_statement_txns (the parsed
statement lines); this row holds the statement's own control totals and the
cached GL pull used by the auto-matcher.

Why a header table:
  - Cross-foot control: store the statement's opening + ending balance so we
    can verify (opening + Σ line activity = ending). A parse that drops or
    misreads a line then FAILS the tie-out instead of silently under-reporting
    activity while the rec still appears to balance.
  - GL cache: the matcher needs the period's GL transactions. Pulling them from
    QBO on every worksheet open was a live API call each time; we cache the pull
    here (JSON-safe) so re-opening the worksheet is a DB read. An explicit
    refresh (or a re-upload) re-pulls.

Unique on (tenant_id, qbo_account_id, period_end) — one header per
account+period; re-uploads overwrite it.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class BankStatement(TenantBase):
    __tablename__ = "bank_statements"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "qbo_account_id", "period_end",
            name="uq_bank_statement_acct_period",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    statement_filename: Mapped[str | None] = mapped_column(String(255))

    # ── Statement control totals (parsed from the upload; None if not found) ──
    opening_balance: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    ending_balance:  Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    # Σ of the parsed line amounts (signed). Stored so the tie-out is auditable.
    line_sum:        Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    # opening + line_sum == ending ?  None = couldn't verify (totals not parsed).
    tie_out_ok:      Mapped[bool | None] = mapped_column(Boolean)
    tie_out_diff:    Mapped[Decimal | None] = mapped_column(Numeric(18, 2))

    # ── Cached GL pull (avoids hitting QBO on every worksheet open) ───────────
    # JSON-safe list of GL txn dicts (amount as str, txn_date as ISO date).
    gl_txns_cache:   Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb"), default=list,
    )
    gl_refreshed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
