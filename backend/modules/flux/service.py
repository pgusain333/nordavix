"""
Flux analysis service: variance calculation, Excel parsing, and materiality logic.

All functions receive an AsyncSession and tenant_id explicitly.
This module has no HTTP concerns — it's pure business logic.
"""
import io
import uuid
from decimal import Decimal, InvalidOperation

import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account import Account
from models.trial_balance import TrialBalance
from models.variance import Variance

# Standard GAAP 4-digit account number ranges for FS categorization.
_FS_CATEGORY_RANGES: list[tuple[int, int, str, str]] = [
    (1000, 1999, "Assets",      "Current Assets"),
    (2000, 2499, "Assets",      "Long-Term Assets"),
    (2500, 2999, "Assets",      "Other Assets"),
    (3000, 3999, "Liabilities", "Liabilities"),
    (4000, 4999, "Equity",      "Equity"),
    (5000, 5999, "Revenue",     "Revenue"),
    (6000, 6999, "Expenses",    "Cost of Revenue"),
    (7000, 7999, "Expenses",    "Operating Expenses"),
    (8000, 8999, "Expenses",    "Other Expenses"),
    (9000, 9999, "Expenses",    "Other Income/Expense"),
]


def classify_account(
    account_number: str,
    overrides: dict[str, str],
) -> tuple[str | None, str | None]:
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


def compute_variance(
    current: Decimal,
    prior: Decimal,
) -> tuple[Decimal, Decimal | None]:
    """
    Returns (dollar_variance, pct_variance).
    pct_variance is None when prior is zero.
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
    """Returns anomaly flag strings for a variance row."""
    flags: list[str] = []

    if prior == Decimal(0) and current != Decimal(0):
        flags.append("new_account")

    if prior != Decimal(0) and current != Decimal(0):
        if (prior > 0) != (current > 0):
            flags.append("sign_flip")

    if pct_variance is not None and abs(pct_variance) > Decimal(50):
        flags.append("large_pct_change")

    return flags


# ── Excel / CSV parsing ────────────────────────────────────────────────────────

_ACCOUNT_NUMBER_HINTS = [
    "account no", "account number", "account #", "acct no", "acct number",
    "acct #", "account_no", "acct_no", "gl code", "account code", "code",
    "number", "no.",
]
_ACCOUNT_NAME_HINTS = [
    "account name", "account description", "description", "name",
    "account_name", "title",
]
_CURRENT_HINTS = [
    "current period", "current", "this period", "ytd", "curr",
    "period 2", "month end", "ending",
]
_PRIOR_HINTS = [
    "prior period", "prior", "previous", "last period", "prev",
    "period 1", "prior year", "py",
]


def _guess_column(headers: list[str], hints: list[str]) -> str | None:
    """Find the first header that contains any of the hint strings (case-insensitive)."""
    for hint in hints:
        for h in headers:
            if hint in h.lower().strip():
                return h
    return None


def auto_detect_mapping(headers: list[str]) -> dict[str, str | None]:
    """Auto-detect column roles from header names."""
    return {
        "account_number":  _guess_column(headers, _ACCOUNT_NUMBER_HINTS),
        "account_name":    _guess_column(headers, _ACCOUNT_NAME_HINTS),
        "current_balance": _guess_column(headers, _CURRENT_HINTS),
        "prior_balance":   _guess_column(headers, _PRIOR_HINTS),
    }


def parse_file_to_preview(
    file_bytes: bytes,
    filename: str,
) -> tuple[list[str], list[list[str | float | None]], dict[str, str | None]]:
    """
    Parse an Excel or CSV file and return (headers, sample_rows, detected_mapping).

    sample_rows: up to 5 rows of data as lists of primitive values.
    detected_mapping: best-guess column roles based on header names.
    """
    ext = filename.rsplit(".", 1)[-1].lower()

    if ext == "csv":
        df = pd.read_csv(io.BytesIO(file_bytes), nrows=200, dtype=str)
    else:
        df = pd.read_excel(io.BytesIO(file_bytes), nrows=200, dtype=str)

    # Drop completely empty rows/cols
    df.dropna(how="all", inplace=True)
    df.dropna(axis=1, how="all", inplace=True)

    headers = [str(c) for c in df.columns.tolist()]
    # Sample: first 5 non-empty rows
    sample_df = df.head(5).fillna("")
    sample_rows: list[list[str | float | None]] = [
        [v if v != "" else None for v in row]
        for row in sample_df.values.tolist()
    ]

    detected_mapping = auto_detect_mapping(headers)
    return headers, sample_rows, detected_mapping


def parse_accounts_from_file(
    file_bytes: bytes,
    filename: str,
    mapping: dict[str, str],
    overrides: dict[str, str],
) -> list[dict]:
    """
    Parse the file with a confirmed column mapping.
    Returns a list of account dicts ready for DB insertion.
    """
    ext = filename.rsplit(".", 1)[-1].lower()

    if ext == "csv":
        df = pd.read_csv(io.BytesIO(file_bytes))
    else:
        df = pd.read_excel(io.BytesIO(file_bytes))

    df.dropna(how="all", inplace=True)

    acct_num_col  = mapping["account_number"]
    acct_name_col = mapping["account_name"]
    curr_col      = mapping["current_balance"]
    prior_col     = mapping["prior_balance"]

    accounts = []
    for _, row in df.iterrows():
        # Skip rows with missing account number
        acct_num = str(row.get(acct_num_col, "")).strip()
        if not acct_num or acct_num.lower() in ("nan", "none", ""):
            continue

        acct_name = str(row.get(acct_name_col, "")).strip()

        def to_decimal(val: object) -> Decimal:
            try:
                # Remove currency formatting characters
                cleaned = str(val).replace(",", "").replace("$", "").replace("(", "-").replace(")", "").strip()
                return Decimal(cleaned) if cleaned and cleaned not in ("nan", "") else Decimal(0)
            except (InvalidOperation, ValueError):
                return Decimal(0)

        current = to_decimal(row.get(curr_col, 0))
        prior   = to_decimal(row.get(prior_col, 0))

        fs_category, fs_line = classify_account(acct_num, overrides)

        accounts.append({
            "account_number": acct_num,
            "account_name":   acct_name or acct_num,
            "current_balance":current,
            "prior_balance":  prior,
            "fs_category":    fs_category,
            "fs_line":        fs_line,
        })

    return accounts


async def create_accounts_and_variances(
    session: AsyncSession,
    trial_balance: TrialBalance,
    tenant_id: uuid.UUID,
    account_dicts: list[dict],
) -> tuple[int, int, int]:
    """
    Persist Account and Variance rows from parsed account data.
    Returns (accounts_created, variances_created, material_count).
    """
    accounts_created  = 0
    variances_created = 0
    material_count    = 0

    for ad in account_dicts:
        account = Account(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            trial_balance_id=trial_balance.id,
            account_number=ad["account_number"],
            account_name=ad["account_name"],
            current_balance=ad["current_balance"],
            prior_balance=ad["prior_balance"],
            fs_category=ad["fs_category"],
            fs_line=ad["fs_line"],
        )
        session.add(account)
        accounts_created += 1

        dollar, pct = compute_variance(ad["current_balance"], ad["prior_balance"])
        is_material = abs(dollar) >= trial_balance.materiality_threshold
        flags = detect_anomalies(ad["current_balance"], ad["prior_balance"], dollar, pct)

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
        variances_created += 1
        if is_material:
            material_count += 1

    return accounts_created, variances_created, material_count


async def create_variances_for_tb(
    session: AsyncSession,
    trial_balance: TrialBalance,
    tenant_id: uuid.UUID,
) -> list[Variance]:
    """
    Calculate variances for all accounts in a trial balance and persist them.
    Called after the TB has been parsed and accounts are loaded.
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
