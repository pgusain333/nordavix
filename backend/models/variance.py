import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, DateTime, Numeric, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class Variance(TenantBase):
    """
    Calculated variance for one account row in a trial balance.

    pct_variance is NULL when prior_balance is zero (new account or dormant).
    is_material is set by the service against the TB's materiality_threshold.
    anomaly_flags: list of strings from {"new_account", "dormant_reactivated",
                   "sign_flip", "large_pct_change"}.
    Status: pending | approved | edited | flagged | skipped
    """
    __tablename__ = "variances"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    dollar_variance: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    # NULL when prior balance is zero — avoids divide-by-zero and misleading percentages
    pct_variance: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    is_material: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    anomaly_flags: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="pending")
    # ── Expectation Engine (actual-vs-expected lens) ──────────────────────────
    # expected_value is what NDVX expected this account's balance to be, from a
    # trailing run-rate of recent closes (or, later, a confirmed client-memory
    # rule). expected_basis is the human-readable "why" (e.g. "Run-rate: avg of
    # last 4 closes"). The _expected deltas mirror dollar_/pct_variance but
    # measure actual-vs-expected instead of actual-vs-prior. All NULL on older
    # analyses and whenever there isn't enough history to form an expectation.
    expected_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    expected_basis: Mapped[str | None] = mapped_column(String(200))
    dollar_variance_expected: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    pct_variance_expected: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    # True once a confirmed expectation rule explains this variance up-front
    # (set by the captured-judgment loop — Slice 2). Default False.
    pre_explained: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
    )
    # Per-line sign-off: which user approved this specific variance, and when
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Structured AI analysis from the deeper Agentic Mode:
    #   narrative + risk_level + justified + key_entities + recommendations.
    # NULL for variances that only have the legacy Narrative.content
    # prose. Schema documented in migration 021.
    ai_commentary: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
