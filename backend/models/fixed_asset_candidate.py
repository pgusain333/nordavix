"""
FixedAssetCandidate — AI-detected potential fixed-asset capitalizations
found by scanning expense-account GL.

When the user clicks "Scan GL for missed capitalizations" on the Fixed
Assets page, the detector pulls recent expense-account transactions
(Repairs & Maintenance, Office Supplies, Computer Expense, Tools,
generic Other Expense — anywhere a capitalizable asset might hide as
a one-shot expense entry) above the company's capitalization threshold
and asks Claude which ones meet capitalization criteria under US GAAP:

  1. Acquisition (or substantial improvement) of a TANGIBLE asset
  2. Useful life > 1 year (provides future benefit beyond current period)
  3. Cost ≥ company cap threshold (typ. $1K-$5K; we default to $1K)

Each surviving "should be capitalized" suggestion becomes a
FixedAssetCandidate row carrying the asset class (Computer Hardware,
Office Furniture, Machinery & Equipment, Vehicles, Leasehold
Improvements, Tools, Perpetual Software) and a useful-life estimate
in months based on standard class lives.

Lifecycle:
  open       — fresh detection, awaiting user decision
  accepted   — user clicked "Capitalize"; accepted_item_id points to
               the resulting ScheduleFixedAsset row (so re-scans don't
               re-suggest it)
  dismissed  — user clicked "Not a fixed asset"; permanently silenced
               for this txn (matched by gl_txn_id)

The (tenant_id, gl_txn_id) pair is the dedup key. A second scan of the
same period reuses existing candidates — only NEW txns produce new rows.

Migration: 028_fixed_asset_candidates.py.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class FixedAssetCandidate(TenantBase):
    __tablename__ = "fixed_asset_candidates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    period_end: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ── GL transaction context (the source row in QBO) ──────────────────
    gl_account_id:   Mapped[str] = mapped_column(String(50),  nullable=False)
    gl_account_name: Mapped[str] = mapped_column(String(255), nullable=False)
    gl_txn_id:       Mapped[str | None] = mapped_column(String(50))
    gl_txn_date:     Mapped[date] = mapped_column(Date, nullable=False)
    gl_amount:       Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    gl_memo:         Mapped[str | None] = mapped_column(String(500))
    gl_vendor:       Mapped[str | None] = mapped_column(String(255))

    # ── AI suggestion fields ────────────────────────────────────────────
    # Clean asset description for the FA item (Claude rewrites the memo
    # into a proper asset name, e.g. "Dell XPS 15 laptop — engineering").
    ai_description:       Mapped[str | None] = mapped_column(String(255))
    ai_vendor:            Mapped[str | None] = mapped_column(String(255))
    # Asset class — drives the typical useful-life suggestion. Stored as
    # free text (Claude picks from: Computer Hardware, Office Furniture,
    # Machinery & Equipment, Vehicles, Leasehold Improvements, Tools,
    # Perpetual Software, Other).
    ai_category:          Mapped[str | None] = mapped_column(String(100))
    # When the asset was placed in service. Defaults to the GL txn date
    # if Claude can't infer something better from the memo.
    ai_in_service_date:   Mapped[date | None] = mapped_column(Date)
    # Total cost to capitalize. Usually the GL amount; rarely Claude
    # suggests less if part of the txn is non-capitalizable
    # (e.g. installation + 1-year service plan bundled).
    ai_cost:              Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    # Salvage value (usually 0 for small businesses; we let Claude
    # suggest a value if the asset has a clear secondary market).
    ai_salvage_value:     Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    # Useful life in MONTHS — Claude picks from standard class lives:
    #   Computer Hardware       36
    #   Office Furniture        84
    #   Machinery & Equipment   60-84
    #   Vehicles                60
    #   Leasehold Improvements  84 (conservative; real GAAP uses shorter
    #                            of lease term or asset life — Claude
    #                            picks 84 unless memo names lease term)
    #   Tools (above threshold) 60
    #   Perpetual Software      36
    ai_useful_life_months: Mapped[int | None] = mapped_column(Integer)
    # 0.00 to 1.00 — how sure the model is. Displayed as a chip in the UI.
    ai_confidence:        Mapped[Decimal] = mapped_column(Numeric(3, 2), nullable=False, default=Decimal("0.50"))
    ai_reasoning:         Mapped[str | None] = mapped_column(Text)
    # Suggested target asset GL account (where the new ScheduleFixedAsset
    # should be posted). Often left null in v1 — Claude doesn't reliably
    # know the chart's Asset accounts. The user picks the right
    # "Computer Hardware Asset" / "Office Equipment" account on accept.
    ai_target_account_id: Mapped[str | None] = mapped_column(String(50))

    # ── Lifecycle ──────────────────────────────────────────────────────
    # open | accepted | dismissed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open", index=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # When accepted, the resulting ScheduleFixedAsset id — lets the UI
    # link back from a candidate row to the live schedule item.
    accepted_item_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Audit ──────────────────────────────────────────────────────────
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
