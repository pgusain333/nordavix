"""Pydantic schemas for the reconciliations API."""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


ReconType = Literal[
    # Specialized with sub-ledger detail
    "AR", "AP", "BANK", "CC",
    # Generic balance-sheet account reconciliations, keyed to QBO AccountType
    "FIXED_ASSETS",
    "OTHER_CURRENT_ASSET",     # Prepaids, inventory, etc.
    "OTHER_ASSET",             # Misc long-term assets
    "OTHER_CURRENT_LIABILITY", # Accruals, deferred revenue, etc.
    "LONG_TERM_LIABILITY",     # Loans, notes payable, etc.
    "EQUITY",
    "OTHER",
]
ReconStatus = Literal["pending", "syncing", "computing", "in_review", "approved", "error"]
ItemStatus = Literal["pending", "reviewed", "approved", "flagged", "resolved"]
RiskLevel = Literal["low", "medium", "high"]
TxnCategory = Literal["unmatched", "unapplied_cash", "duplicate", "manual_je"]


# ── Create ────────────────────────────────────────────────────────────────────

class ReconciliationCreate(BaseModel):
    """Caller chooses the type + period; everything else is computed on sync."""
    name: str = Field(..., min_length=1, max_length=255)
    recon_type: ReconType
    period_end: date


# ── Read ──────────────────────────────────────────────────────────────────────

class ReconciliationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    recon_type: ReconType
    period_end: date
    gl_total: Decimal
    subledger_total: Decimal
    difference: Decimal
    status: ReconStatus
    ai_summary: str | None
    assigned_to: uuid.UUID | None
    approved_by: uuid.UUID | None
    approved_at: datetime | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    error_detail: str | None


class ReconciliationItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    reconciliation_id: uuid.UUID
    entity_name: str
    entity_qbo_id: str | None
    gl_balance: Decimal
    subledger_balance: Decimal
    difference: Decimal
    aging_current: Decimal
    aging_1_30: Decimal
    aging_31_60: Decimal
    aging_61_90: Decimal
    aging_over_90: Decimal
    risk_level: RiskLevel
    status: ItemStatus
    ai_commentary: str | None
    approved_by: uuid.UUID | None
    approved_at: datetime | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class ReconTransactionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    reconciliation_item_id: uuid.UUID
    txn_type: str
    txn_number: str | None
    txn_date: date | None
    amount: Decimal
    memo: str | None
    category: TxnCategory
    meta: dict
    created_at: datetime


class ReconNoteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    reconciliation_id: uuid.UUID
    reconciliation_item_id: uuid.UUID | None
    author_id: uuid.UUID
    body: str
    created_at: datetime


# ── Detail / aggregate views ──────────────────────────────────────────────────

class ReconciliationDetail(BaseModel):
    """Composite payload for the detail page: recon + items + grouped txns + notes."""
    recon: ReconciliationResponse
    items: list[ReconciliationItemResponse]
    transactions: list[ReconTransactionResponse]
    notes: list[ReconNoteResponse]


class ReconciliationDashboardStats(BaseModel):
    """KPI cards on the dashboard."""
    total: int
    completed: int
    pending_review: int
    high_risk_accounts: int
    unresolved_difference: Decimal
    overdue_aging_total: Decimal


class ActivityFeedEntry(BaseModel):
    """One row in the recent-activity feed."""
    kind: Literal["created", "synced", "approved", "noted", "assigned", "ai_commentary"]
    recon_id: uuid.UUID
    recon_name: str
    happened_at: datetime
    actor_id: uuid.UUID | None
    summary: str


class ReconciliationDashboard(BaseModel):
    stats: ReconciliationDashboardStats
    recent: list[ReconciliationResponse]
    activity: list[ActivityFeedEntry]
    ai_insights: list[str]


# ── Actions ───────────────────────────────────────────────────────────────────

class NoteCreate(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)
    reconciliation_item_id: uuid.UUID | None = None


class AssignBody(BaseModel):
    user_id: uuid.UUID | None  # null clears assignment


class ItemStatusUpdate(BaseModel):
    status: ItemStatus
