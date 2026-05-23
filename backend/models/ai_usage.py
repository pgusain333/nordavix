import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Integer, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class AIUsage(TenantBase):
    """
    One record per Anthropic API call, for per-tenant token and cost tracking.

    cost_usd_estimate uses the pricing at time of the call — actual Anthropic
    invoices may differ. This table is for usage visibility and future
    usage-based billing tiers, not for reconciling Anthropic invoices.

    Index on (tenant_id, created_at) supports the common query:
        "How many tokens did tenant X use this month?"
    """
    __tablename__ = "ai_usage"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    cost_usd_estimate: Mapped[Decimal] = mapped_column(Numeric(10, 6), nullable=False)
    # The feature that triggered this call, e.g. "flux_narrative", "flux_regenerate"
    operation: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
