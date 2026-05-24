import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_serializer


class TrialBalanceCreate(BaseModel):
    name: str
    period_current: date
    period_prior: date
    materiality_threshold: Decimal


class TrialBalanceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    period_current: date
    period_prior: date
    status: str
    materiality_threshold: Decimal
    error_detail: str | None = None
    created_at: datetime
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None


class UploadPreview(BaseModel):
    """Returned after a file is uploaded — shows headers and sample rows for column mapping."""
    headers: list[str]
    sample_rows: list[list[str | float | None]]
    detected_mapping: dict[str, str | None]


class ColumnMappingBody(BaseModel):
    """
    Column mapping from the user's header names to our canonical fields.

    Two shapes are supported (the parser figures out which from the keys present):
      A) {account_number, account_name, current_balance, prior_balance}
      B) {account_number, account_name, current_debit, current_credit,
          prior_debit?, prior_credit?}  ← QBO Compare Trial Balance shape

    Extra metadata keys like "layout" or "_filename" are tolerated and ignored.
    """
    mapping: dict[str, str]


class ParseResult(BaseModel):
    """Result of parsing the trial balance with confirmed column mapping."""
    accounts_created: int
    variances_created: int
    material_count: int


class VarianceResponse(BaseModel):
    """Flattened variance view combining Variance + Account + Narrative."""
    id: uuid.UUID
    account_id: uuid.UUID
    account_number: str
    account_name: str
    current_balance: Decimal
    prior_balance: Decimal
    dollar_variance: Decimal
    pct_variance: Decimal | None
    is_material: bool
    anomaly_flags: list[str]
    status: str
    fs_category: str | None
    narrative: str | None
    confidence_score: Decimal | None
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None

    @field_serializer("dollar_variance", "current_balance", "prior_balance",
                      "pct_variance", "confidence_score")
    def serialize_decimal(self, v: Decimal | None) -> str | None:
        return str(v) if v is not None else None

    @field_serializer("materiality_threshold", mode="plain", check_fields=False)
    def _ignore(self, v: object) -> object:
        return v


class NarrativeUpdate(BaseModel):
    content: str


class FluxRunResponse(BaseModel):
    trial_balance_id: uuid.UUID
    task_id: str
    status: str
    message: str
