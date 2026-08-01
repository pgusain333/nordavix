"""AllocSpaceMap — the square-footage document the client actually supplied.

The occupancy driver is a ratio of production square feet to total, and it moves
every occupancy-driven pool. The numbers in the Spaces registry are a preparer's
transcription of something a client sent: a floor plan, a surveyor's measurement
schedule, a lease exhibit. On examination the question is not "what did you
enter" but "what did you enter it FROM", and a figure with no source document
behind it is a figure the preparer produced.

So the source lives with the registry rather than in an email thread. The file
sits in R2 under the standard tenant-scoped key; this row is metadata plus the
key, mirroring SubledgerEvidence in the close app.

Effective dating is deliberately absent: a document is evidence of a fact as at a
date, not a rule that applies over a range. `as_of` records the date the plan
speaks to, and superseded plans stay on file rather than being replaced — a
re-measured facility is new evidence, not a correction of the old.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class AllocSpaceMap(TenantBase):
    __tablename__ = "alloc_space_map"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    # Tenant-scoped R2 key — see core.storage.r2.tenant_key()
    r2_key: Mapped[str] = mapped_column(String(500), nullable=False)

    # What the document IS — "Floor plan", "Surveyor's measurement schedule",
    # "Lease exhibit B". Free text, because the answer varies by client.
    label: Mapped[str | None] = mapped_column(String(200))
    # The date the plan speaks to. A facility re-measured in June is evidence
    # for June onward; the March plan is still the right support for March.
    as_of: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)

    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
