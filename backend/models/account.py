import uuid
from decimal import Decimal

from sqlalchemy import Numeric, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class Account(TenantBase):
    """
    One row in the trial balance: an account with current and prior period balances.

    fs_category: coarse grouping (Assets, Liabilities, Equity, Revenue, Expenses)
    fs_line: finer grouping within category (e.g., "Current Assets", "Operating Expenses")
    Both are derived from account_number using GAAP ranges, overridable via tb.fs_line_mapping.
    """
    __tablename__ = "accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    trial_balance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    account_number: Mapped[str] = mapped_column(String(50), nullable=False)
    account_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Balances stored with 4 decimal places to handle any currency precision
    current_balance: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    prior_balance: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    # Assets | Liabilities | Equity | Revenue | Expenses
    fs_category: Mapped[str | None] = mapped_column(String(50))
    # Sub-line within category, e.g. "Current Assets", "Cost of Revenue"
    fs_line: Mapped[str | None] = mapped_column(String(100))
