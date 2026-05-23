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
    created_at: datetime


class VarianceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

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

    @field_serializer("dollar_variance", "current_balance", "prior_balance")
    def serialize_decimal(self, v: Decimal) -> str:
        # Return as string to preserve precision across JSON serialization
        return str(v)


class NarrativeUpdate(BaseModel):
    content: str


class FluxRunResponse(BaseModel):
    trial_balance_id: uuid.UUID
    task_id: str
    status: str
    message: str
