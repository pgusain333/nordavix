import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, field_serializer


class TrialBalanceCreate(BaseModel):
    name: str
    period_current: date         # Current period END date
    period_prior: date           # Prior period END date (defaults to period_current minus 1 year)
    materiality_threshold: Decimal
    # Optional period START dates. When provided alongside the end dates, the
    # QBO TrialBalance pull is range-scoped (gives P&L activity for the
    # window; balance-sheet accounts still come out as snapshots at end_date).
    # The frontend defaults period_start_current to the first day of the
    # period_current's month and computes period_start_prior automatically.
    period_start_current: date | None = None
    period_start_prior:   date | None = None


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
    # "prior" (actual vs same month last year) | "expected" (actual vs run-rate)
    comparison_mode: str = "prior"


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
    # QBO account id when the TB was pulled from QBO (null on Excel-uploaded
    # TBs). Drives the per-row "Sync from QBO" button — without an id we
    # can't ask QBO for that account's balance.
    qbo_account_id: str | None = None
    account_number: str
    account_name: str
    current_balance: Decimal
    prior_balance: Decimal
    dollar_variance: Decimal
    pct_variance: Decimal | None
    is_material: bool
    anomaly_flags: list[str]
    status: str
    # ── Expectation Engine (actual-vs-expected lens) ──────────────────────────
    expected_value: Decimal | None = None
    expected_basis: str | None = None
    dollar_variance_expected: Decimal | None = None
    pct_variance_expected: Decimal | None = None
    pre_explained: bool = False
    fs_category: str | None
    narrative: str | None
    confidence_score: Decimal | None
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    # Structured AI commentary from the deeper Agentic Mode.
    # Schema documented in migration 021. NULL for variances that
    # only have the legacy Narrative.content prose.
    ai_commentary: dict | None = None

    @field_serializer("dollar_variance", "current_balance", "prior_balance",
                      "pct_variance", "confidence_score",
                      "expected_value", "dollar_variance_expected", "pct_variance_expected")
    def serialize_decimal(self, v: Decimal | None) -> str | None:
        return str(v) if v is not None else None

    @field_serializer("materiality_threshold", mode="plain", check_fields=False)
    def _ignore(self, v: object) -> object:
        return v


class ComparisonModeBody(BaseModel):
    """Body for POST /trial-balances/{id}/comparison-mode — flips the flux lens
    between 'prior' (actual vs same month last year) and 'expected' (actual vs
    NDVX's trailing run-rate). Persisted on the analysis."""
    mode: str


class SaveExpectationBody(BaseModel):
    """Body for POST .../variances/{id}/save-expectation — captures this
    variance's explanation as a recurring client-memory expectation (confirm-
    first; a reviewer must confirm it before it ever applies).

      recurrence      'monthly' (every close) | 'quarterly' (this month + every
                      3rd) | 'annual' (this calendar month only) | 'one_off'
                      (this period only, never recurs)
      expected_amount overrides the expected balance (defaults to the account's
                      current balance)
      tolerance_mode  'pct' (default) or 'abs' — percent band vs absolute ±$ band
      tolerance_pct   percent band a future actual counts as 'as expected'
                      (default 15%; clamped 1..200 server-side); used when mode=pct
      tolerance_abs   absolute ±$ band; used when mode=abs
      explanation     the reason in the user's words; falls back to the variance's
                      AI commentary / written narrative when omitted
    """
    recurrence: str
    tolerance_pct: float | None = None
    tolerance_mode: str | None = None
    tolerance_abs: float | None = None
    expected_amount: float | None = None
    explanation: str | None = None


class NarrativeUpdate(BaseModel):
    content: str


class VarianceStatusUpdate(BaseModel):
    """
    Body for POST /variances/{id}/status — used by the bulk action bar
    (Mark prepared / Flag / Reset to pending) on the Flux variance table.

    Allowed values mirror the Variance.status enum: pending | generating |
    generated | edited | approved | flagged. The endpoint will refuse
    other strings to keep audit trails clean.
    """
    status: str


class FluxRunResponse(BaseModel):
    trial_balance_id: uuid.UUID
    task_id: str
    status: str
    message: str
