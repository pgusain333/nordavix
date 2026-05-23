import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class Narrative(TenantBase):
    """
    AI-generated (or human-edited) flux narrative for one variance.

    cache_key is a SHA-256 hash of (account_number, current_balance, prior_balance, model).
    Before calling Anthropic, we check if a narrative with this cache_key already exists —
    same input data always produces the same cached response (idempotency + cost control).

    confidence_score: 0.0–1.0, derived from data quality heuristics (not from the model
    itself). A low score triggers a "review recommended" indicator in the UI.
    """
    __tablename__ = "narratives"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # One narrative per variance — enforced by unique constraint
    variance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, unique=True, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # SHA-256 of inputs — see core/ai/client.py:compute_cache_key
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    # Heuristic confidence: 1.0 = all data present and well-formed, <0.7 = review recommended
    confidence_score: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Set when a controller edits the AI-generated text
    edited_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
