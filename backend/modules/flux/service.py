"""
Flux analysis service: variance calculation and materiality logic.

This module contains pure business logic with no HTTP concerns.
All functions receive an AsyncSession and tenant_id explicitly.
"""
import uuid
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account import Account
from models.trial_balance import TrialBalance
from models.variance import Variance

# Standard GAAP 4-digit account number ranges for FS categorization.
# These are defaults — overridable via TrialBalance.fs_line_mapping.
# See ADR 004 for the decision to use GAAP ranges as the default.
_FS_CATEGORY_RANGES: list[tuple[int, int, str, str]] = [
    (1000, 1999, "Assets", "Current Assets"),
    (2000, 2499, "Assets", "Long-Term Assets"),
    (2500, 2999, "Assets", "Other Assets"),
    (3000, 3999, "Liabilities", "Liabilities"),
    (4000, 4999, "Equity", "Equity"),
    (5000, 5999, "Revenue", "Revenue"),
    (6000, 6999, "Expenses", "Cost of Revenue"),
    (7000, 7999, "Expenses", "Operating Expenses"),
    (8000, 8999, "Expenses", "Other Expenses"),
    (9000, 9999, "Expenses", "Other Income/Expense"),
]


def classify_account(account_number: str, overrides: dict[str, str]) -> tuple[str | None, str | None]:
    """Return (fs_category, fs_line) for an account number using GAAP ranges."""
    if account_number in overrides:
        parts = overrides[account_number].split("|", 1)
        return parts[0], parts[1] if len(parts) > 1 else None

    try:
        num = int(account_number.split(".")[0].strip())
    except (ValueError, AttributeError):
        return None, None

    for low, high, category, line in _FS_CATEGORY_RANGES:
        if low <= num <= high:
            return category, line
    return None, None


def compute_variance(current: Decimal, prior: Decimal) -> tuple[Decimal, Decimal | None]:
    """
    Returns (dollar_variance, pct_variance).

    pct_variance is None when prior is zero to avoid divide-by-zero.
    Dollar variance: positive = increase (may be fav or unfav depending on account type).
    """
    dollar = current - prior
    if prior == Decimal(0):
        return dollar, None
    pct = (dollar / abs(prior) * 100).quantize(Decimal("0.0001"))
    return dollar, pct


def detect_anomalies(
    current: Decimal,
    prior: Decimal,
    dollar_variance: Decimal,
    pct_variance: Decimal | None,
) -> list[str]:
    """
    Returns a list of anomaly flag strings for a variance row.

    Flags:
        new_account         prior balance is zero, current is non-zero
        dormant_reactivated prior balance is zero, current is non-zero (after being active before)
        sign_flip           balance changed from positive to negative or vice versa
        large_pct_change    absolute percentage change > 50%
    """
    flags: list[str] = []

    if prior == Decimal(0) and current != Decimal(0):
        flags.append("new_account")

    if prior != Decimal(0) and current != Decimal(0):
        if (prior > 0) != (current > 0):
            flags.append("sign_flip")

    if pct_variance is not None and abs(pct_variance) > Decimal(50):
        flags.append("large_pct_change")

    return flags


async def create_variances_for_tb(
    session: AsyncSession,
    trial_balance: TrialBalance,
    tenant_id: uuid.UUID,
) -> list[Variance]:
    """
    Calculate variances for all accounts in a trial balance and persist them.

    Called after the TB has been parsed and accounts are loaded. Creates one
    Variance row per account; marks is_material based on the TB threshold.
    """
    accounts_result = await session.execute(
        select(Account).where(Account.trial_balance_id == trial_balance.id)
    )
    accounts = list(accounts_result.scalars().all())

    variances: list[Variance] = []
    for account in accounts:
        dollar, pct = compute_variance(account.current_balance, account.prior_balance)
        is_material = abs(dollar) >= trial_balance.materiality_threshold
        flags = detect_anomalies(account.current_balance, account.prior_balance, dollar, pct)

        variance = Variance(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            account_id=account.id,
            dollar_variance=dollar,
            pct_variance=pct,
            is_material=is_material,
            anomaly_flags=flags,
            status="pending",
        )
        session.add(variance)
        variances.append(variance)

    return variances
