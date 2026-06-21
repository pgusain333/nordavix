"""
Flux analysis service: variance calculation, Excel parsing, and materiality logic.

All functions receive an AsyncSession and tenant_id explicitly.
This module has no HTTP concerns — it's pure business logic.
"""
import io
import logging
import uuid
from decimal import Decimal, InvalidOperation

import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account import Account
from models.trial_balance import TrialBalance
from models.variance import Variance
from modules.memory.service import active_expectation_facts_map, evaluate_expectation

logger = logging.getLogger(__name__)

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
    qbo_account_type: str | None = None,
) -> tuple[str | None, str | None]:
    """
    Return (fs_category, fs_line) for an account.

    Priority order:
      1. Explicit overrides dict ({acctnum: "Category|FS Line"})
      2. GAAP 4-digit account number ranges (works for numbered CoAs)
      3. QBO AccountType fallback — required for unnumbered defaults
         (e.g. "Design income", "Sales of Product Income") that don't
         classify via account number.
    """
    if account_number in overrides:
        parts = overrides[account_number].split("|", 1)
        return parts[0], parts[1] if len(parts) > 1 else None

    # Try GAAP ranges first
    try:
        num = int(account_number.split(".")[0].strip())
        for low, high, category, line in _FS_CATEGORY_RANGES:
            if low <= num <= high:
                return category, line
    except (ValueError, AttributeError):
        pass

    # Fall back to QBO AccountType
    if qbo_account_type:
        return _CATEGORY_FROM_QBO_TYPE.get(qbo_account_type, (None, None))
    return None, None


# QBO AccountType → (FS category, FS sub-line). Covers every AccountType
# QBO exposes today. Lines stay GAAP-ish so the AI prompt + UI grouping
# read consistently across companies.
_CATEGORY_FROM_QBO_TYPE: dict[str, tuple[str, str]] = {
    "Bank":                       ("Assets",      "Current Assets"),
    "Accounts Receivable":        ("Assets",      "Current Assets"),
    "Other Current Asset":        ("Assets",      "Current Assets"),
    "Fixed Asset":                ("Assets",      "Long-Term Assets"),
    "Other Asset":                ("Assets",      "Other Assets"),
    "Accounts Payable":           ("Liabilities", "Current Liabilities"),
    "Credit Card":                ("Liabilities", "Current Liabilities"),
    "Other Current Liability":    ("Liabilities", "Current Liabilities"),
    "Long Term Liability":        ("Liabilities", "Long-Term Liabilities"),
    "Equity":                     ("Equity",      "Equity"),
    "Income":                     ("Revenue",     "Revenue"),
    "Other Income":               ("Revenue",     "Other Income"),
    "Cost of Goods Sold":         ("Expenses",    "Cost of Revenue"),
    "Expense":                    ("Expenses",    "Operating Expenses"),
    "Other Expense":              ("Expenses",    "Other Expenses"),
}


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
_DEBIT_HINTS  = ["debit",  "dr"]
_CREDIT_HINTS = ["credit", "cr"]


def _guess_column(headers: list[str], hints: list[str]) -> str | None:
    """Find the first header that contains any of the hint strings (case-insensitive)."""
    for hint in hints:
        for h in headers:
            if hint in h.lower().strip():
                return h
    return None


def _find_debit_credit_pairs(headers: list[str]) -> list[tuple[str, str]]:
    """
    Walk headers left→right collecting consecutive (debit, credit) pairs.
    QBO 'Compare Trial Balance' exports as Account | Debit | Credit | Debit | Credit.
    Returns the pairs in column order so caller can treat the first as current,
    the second as prior (QBO's default ordering).
    """
    pairs: list[tuple[str, str]] = []
    last_debit: str | None = None
    for h in headers:
        low = h.lower().strip()
        is_debit = any(t in low for t in _DEBIT_HINTS) and not any(t in low for t in _CREDIT_HINTS)
        is_credit = any(t in low for t in _CREDIT_HINTS) and not any(t in low for t in _DEBIT_HINTS)
        if is_debit:
            last_debit = h
        elif is_credit and last_debit is not None:
            pairs.append((last_debit, h))
            last_debit = None
    return pairs


def auto_detect_mapping(headers: list[str]) -> dict[str, str | None]:
    """
    Detect column roles. Supports three QBO trial-balance shapes:

      A) Two-period side-by-side (QBO 'Compare TB' export):
            Account | Debit (Curr) | Credit (Curr) | Debit (Prior) | Credit (Prior)
         → emits current_debit / current_credit / prior_debit / prior_credit.
      B) Single-period debit/credit:
            Account | Debit | Credit
         → emits current_debit / current_credit only (prior treated as zero).
      C) Pre-netted balance columns (legacy / custom CSV):
            Account | Current | Prior
         → emits current_balance / prior_balance.

    Always emits account_number and account_name keys (may be None if not
    confidently detected — the UI lets the user confirm).
    """
    mapping: dict[str, str | None] = {
        "account_number":  _guess_column(headers, _ACCOUNT_NUMBER_HINTS),
        "account_name":    _guess_column(headers, _ACCOUNT_NAME_HINTS),
        "current_balance": None,
        "prior_balance":   None,
        "current_debit":   None,
        "current_credit":  None,
        "prior_debit":     None,
        "prior_credit":    None,
        "layout":          "single_balance_pair",
    }

    dc_pairs = _find_debit_credit_pairs(headers)
    if len(dc_pairs) >= 2:
        mapping["current_debit"],  mapping["current_credit"] = dc_pairs[0]
        mapping["prior_debit"],    mapping["prior_credit"]   = dc_pairs[1]
        mapping["layout"] = "qbo_two_period_dc"
    elif len(dc_pairs) == 1:
        mapping["current_debit"], mapping["current_credit"] = dc_pairs[0]
        mapping["layout"] = "qbo_single_period_dc"
    else:
        mapping["current_balance"] = _guess_column(headers, _CURRENT_HINTS)
        mapping["prior_balance"]   = _guess_column(headers, _PRIOR_HINTS)
        mapping["layout"] = "balance_pair"

    return mapping


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


def _to_decimal(val: object) -> Decimal:
    """Tolerant parser: handles "$1,234.56", "(123)", "—", blanks."""
    try:
        cleaned = (
            str(val).replace(",", "").replace("$", "")
            .replace("(", "-").replace(")", "")
            .replace("—", "").replace("–", "").strip()
        )
        if not cleaned or cleaned.lower() in ("nan", "none", "n/a"):
            return Decimal(0)
        return Decimal(cleaned)
    except (InvalidOperation, ValueError):
        return Decimal(0)


def _balance_from_row(
    row: pd.Series,
    debit_col: str | None,
    credit_col: str | None,
    balance_col: str | None,
) -> Decimal:
    """
    Return one signed balance value, regardless of file layout:
      - If both debit + credit columns are provided, balance = debit - credit.
      - Otherwise read the pre-netted balance column.
    """
    if debit_col and credit_col:
        return _to_decimal(row.get(debit_col, 0)) - _to_decimal(row.get(credit_col, 0))
    if balance_col:
        return _to_decimal(row.get(balance_col, 0))
    return Decimal(0)


def parse_accounts_from_file(
    file_bytes: bytes,
    filename: str,
    mapping: dict[str, str],
    overrides: dict[str, str],
) -> list[dict]:
    """
    Parse the file with a confirmed column mapping.

    Accepts EITHER pre-netted balance columns OR raw debit/credit columns
    (one or two period pairs, QBO-style). The mapping dict tells us which
    columns to use; missing keys are treated as None.
    """
    ext = filename.rsplit(".", 1)[-1].lower()
    if ext == "csv":
        df = pd.read_csv(io.BytesIO(file_bytes))
    else:
        df = pd.read_excel(io.BytesIO(file_bytes))

    df.dropna(how="all", inplace=True)

    acct_num_col  = mapping.get("account_number")
    acct_name_col = mapping.get("account_name")

    # Pull both possible layouts from the mapping; whichever has data wins.
    curr_balance  = mapping.get("current_balance")
    prior_balance = mapping.get("prior_balance")
    curr_debit    = mapping.get("current_debit")
    curr_credit   = mapping.get("current_credit")
    prior_debit   = mapping.get("prior_debit")
    prior_credit  = mapping.get("prior_credit")

    accounts: list[dict] = []
    for _, row in df.iterrows():
        acct_num = str(row.get(acct_num_col, "")).strip() if acct_num_col else ""
        if not acct_num or acct_num.lower() in ("nan", "none", ""):
            continue

        # Skip QBO subtotal/total rows defensively
        if acct_num.lower().startswith("total"):
            continue

        acct_name = str(row.get(acct_name_col, "")).strip() if acct_name_col else ""

        current = _balance_from_row(row, curr_debit, curr_credit, curr_balance)
        prior   = _balance_from_row(row, prior_debit, prior_credit, prior_balance)

        # Skip entirely-zero rows — they're not informative
        if current == 0 and prior == 0:
            continue

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


def _account_key(qbo_account_id: str | None, account_number: str | None) -> str:
    """Stable cross-period key for an account: QBO id if present (canonical),
    else the account number. Lets us line an account up across past closes."""
    return (qbo_account_id or "").strip() or (account_number or "").strip()


async def _expectation_history(
    session: AsyncSession,
    tenant_id: uuid.UUID,
    current_pe,
    *,
    lookback: int = 6,
) -> dict[str, list[Decimal]]:
    """Map each account key → its most-recent (up to `lookback`) current
    balances from PRIOR trial balances of this tenant (period_current <
    current_pe), newest first. The basis for a trailing run-rate expectation.

    SELECT is tenant-auto-filtered by TenantBase; the explicit tenant_id WHERE
    is belt-and-suspenders and keeps intent obvious."""
    rows = (await session.execute(
        select(
            Account.qbo_account_id,
            Account.account_number,
            Account.current_balance,
        )
        .join(TrialBalance, Account.trial_balance_id == TrialBalance.id)
        .where(
            TrialBalance.tenant_id == tenant_id,
            TrialBalance.period_current < current_pe,
        )
        .order_by(TrialBalance.period_current.desc())
    )).all()
    hist: dict[str, list[Decimal]] = {}
    for qbo_id, acct_num, bal in rows:
        key = _account_key(qbo_id, acct_num)
        if not key or bal is None:
            continue
        bucket = hist.setdefault(key, [])
        if len(bucket) < lookback:
            bucket.append(bal)
    return hist


def _expected_from_history(balances: list[Decimal]) -> tuple[Decimal | None, str | None]:
    """Trailing run-rate expectation: average of the recent closes. Requires at
    least 2 prior closes so a single noisy month can't masquerade as a baseline.
    Returns (expected_value, human-readable basis) or (None, None)."""
    n = len(balances)
    if n < 2:
        return None, None
    avg = (sum(balances) / Decimal(n)).quantize(Decimal("0.01"))
    return avg, f"Run-rate: average of the last {n} closes"


async def create_accounts_and_variances(
    session: AsyncSession,
    trial_balance: TrialBalance,
    tenant_id: uuid.UUID,
    account_dicts: list[dict],
) -> tuple[int, int, int]:
    """
    Persist Account and Variance rows from parsed account data.
    Returns (accounts_created, variances_created, material_count).

    Alongside the actual-vs-prior variance, computes an actual-vs-EXPECTED
    variance per account, where "expected" is a trailing run-rate of the
    account's recent closes. Both deltas are stored; the UI toggles which lens
    it shows. Materiality + default behavior stay anchored on the prior delta,
    so nothing changes for analyses viewed in the (default) prior mode.
    """
    accounts_created  = 0
    variances_created = 0
    material_count    = 0

    # One history pass for the whole chart (avoids a query per account).
    hist = await _expectation_history(session, tenant_id, trial_balance.period_current)
    # Confirmed (reviewer-approved) expectation rules for this tenant, keyed by
    # account. Best-effort: a memory hiccup must never block the close — we just
    # fall back to the run-rate baseline.
    try:
        exp_facts = await active_expectation_facts_map(session)
    except Exception:
        logger.warning("flux: expectation facts unavailable; using run-rate only", exc_info=True)
        exp_facts = {}

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
            qbo_account_id=ad.get("qbo_account_id"),
        )
        session.add(account)
        accounts_created += 1

        dollar, pct = compute_variance(ad["current_balance"], ad["prior_balance"])
        is_material = abs(dollar) >= trial_balance.materiality_threshold
        flags = detect_anomalies(ad["current_balance"], ad["prior_balance"], dollar, pct)

        # Actual-vs-expected lens. A CONFIRMED client-memory expectation rule
        # (captured judgment) takes precedence over the statistical run-rate; it
        # only pre-explains when the actual is within the rule's tolerance and
        # the rule fires this period (recurrence-aware). Otherwise we fall back
        # to the trailing run-rate baseline.
        key = _account_key(ad.get("qbo_account_id"), ad.get("account_number"))
        expected: Decimal | None = None
        basis: str | None = None
        pre_explained = False
        rule = exp_facts.get(key)
        if rule:
            # Best-effort, per the memory module's contract: a malformed stored
            # fact must degrade to the run-rate baseline for THIS account only,
            # never crash the whole flux build. (evaluate_expectation is hardened
            # to return None on malformed input; this try/except is the backstop
            # so any future field can't fail the close.)
            try:
                ev = evaluate_expectation(rule, trial_balance.period_current, ad["current_balance"])
            except Exception:
                logger.warning("flux: expectation eval failed for %s; using run-rate", key, exc_info=True)
                ev = None
            if ev:
                expected = ev["expected_value"]
                basis = ev["basis"]
                pre_explained = ev["pre_explained"]
        if expected is None:
            expected, basis = _expected_from_history(hist.get(key, []))
        if expected is not None:
            d_exp, p_exp = compute_variance(ad["current_balance"], expected)
        else:
            d_exp, p_exp = None, None

        variance = Variance(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            account_id=account.id,
            dollar_variance=dollar,
            pct_variance=pct,
            is_material=is_material,
            anomaly_flags=flags,
            status="pending",
            expected_value=expected,
            expected_basis=basis,
            dollar_variance_expected=d_exp,
            pct_variance_expected=p_exp,
            pre_explained=pre_explained,
        )
        session.add(variance)
        variances_created += 1
        if is_material:
            material_count += 1

    return accounts_created, variances_created, material_count


# Income-statement QBO account types. For a single-period flux, these get their
# TrialBalance fiscal-YTD figure replaced with true period activity from the
# ProfitAndLoss report (see parse_qbo_pl_amounts + the override below).
_PL_QBO_TYPES = {"Income", "Other Income", "Cost of Goods Sold", "Expense", "Other Expense"}
_PL_CREDIT_NATURAL = {"Income", "Other Income"}


def _is_pl_type(qbo_acct_type: str | None) -> bool:
    return qbo_acct_type in _PL_QBO_TYPES


def _pl_to_signed(qbo_acct_type: str | None, amount: Decimal | None) -> Decimal:
    """Convert a ProfitAndLoss report amount (income +, expense +) into the
    TrialBalance's debit-positive convention used everywhere else in flux:
    income / other income are credit-natural → flip negative; COGS / expense /
    other expense stay positive. Keeps variance, classification, and display
    identical to the TB path — only the magnitude (period vs YTD) changes."""
    a = amount if amount is not None else Decimal(0)
    return -a if qbo_acct_type in _PL_CREDIT_NATURAL else a


def parse_qbo_pl_amounts(report: dict) -> dict[str, Decimal]:
    """{qbo_account_id: amount} from a QBO ProfitAndLoss report (single period).

    Amount is the account's activity over the report's date range exactly as QBO
    presents it (income positive, expense positive). Leaf rows carry the
    Account.Id in ColData[0].id; section / total / subtotal / Net Income /
    Gross Profit summary rows are skipped. The amount is the last column (the
    single period total)."""
    def to_decimal(v: str) -> Decimal:
        try:
            s = (v or "").replace(",", "").replace("$", "").replace("(", "-").replace(")", "").strip()
            return Decimal(s) if s else Decimal(0)
        except (InvalidOperation, ValueError):
            return Decimal(0)

    out: dict[str, Decimal] = {}

    def walk(rows: list[dict]) -> None:
        for r in rows:
            cols = r.get("ColData") or []
            if cols:
                acct_id = cols[0].get("id")
                first = (cols[0].get("value") or "").strip()
                if acct_id and first and not first.lower().startswith(
                    ("total", "subtotal", "net income", "net loss", "gross profit", "net operating")
                ):
                    amt = to_decimal(cols[-1].get("value", "")) if len(cols) > 1 else Decimal(0)
                    out[str(acct_id)] = amt
            sub = r.get("Rows", {}).get("Row", []) or []
            if sub:
                walk(sub)

    walk(report.get("Rows", {}).get("Row", []) or [])
    return out


def parse_qbo_trial_balance_report(
    report_current: dict,
    report_prior: dict,
    overrides: dict[str, str],
    *,
    qbo_acct_lookup: dict[str, dict] | None = None,
    pl_current: dict[str, Decimal] | None = None,
    pl_prior: dict[str, Decimal] | None = None,
) -> list[dict]:
    """
    Convert two QBO TrialBalance report JSON payloads (current + prior period)
    into the same account_dicts shape `parse_accounts_from_file` returns.

    QBO TrialBalance rows look like:
        { ColData: [{value: "1010 Cash", id: "57"}, {value: "12,500.00"}, {value: ""}] }
    The Account column carries the QBO Account.Id in `id`. We use that to
    look up the canonical AcctNum + Name from `qbo_acct_lookup` (built by the
    caller from a separate Account query) — that's much more reliable than
    splitting "<acctnum> <name>" out of the report row label, since many QBO
    instances render only the name in TB rows.
    """
    qbo_acct_lookup = qbo_acct_lookup or {}
    def walk(rows: list[dict], out: list[dict]) -> None:
        for r in rows:
            sub = r.get("Rows", {}).get("Row", []) or []
            cols = r.get("ColData") or []
            # Skip section / summary rows that don't have actual data
            if cols and cols[0].get("value", "").strip():
                first = cols[0].get("value", "").strip()
                # Skip if it's a header / total row
                if not first.lower().startswith(("total", "subtotal", "net income", "net loss")):
                    # The QBO TrialBalance report puts the Account ref in col 0's
                    # `id` attribute. Capturing it lets us drill into per-account
                    # transactions later (without re-resolving by name).
                    out.append({
                        "name_raw": first,
                        "cols":     cols,
                        "qbo_id":   cols[0].get("id"),
                    })
            if sub:
                walk(sub, out)

    def to_decimal(v: str) -> Decimal:
        try:
            s = v.replace(",", "").replace("$", "").replace("(", "-").replace(")", "").strip()
            return Decimal(s) if s else Decimal(0)
        except (InvalidOperation, ValueError):
            return Decimal(0)

    def extract(report: dict) -> dict[str, Decimal]:
        """
        Return {account_key: net_balance_decimal} for the report.
        Keys are the QBO Account.Id when available (canonical, no collisions),
        falling back to the displayed name. This is critical when two accounts
        share a name across different parents — keying by name alone would
        cause one to clobber the other and silently mis-report balances.
        """
        flat: list[dict] = []
        rows = report.get("Rows", {}).get("Row", []) or []
        walk(rows, flat)
        out: dict[str, Decimal] = {}
        for row in flat:
            cols = row["cols"]
            if len(cols) < 2:
                continue
            debit  = to_decimal(cols[1].get("value", "")) if len(cols) > 1 else Decimal(0)
            credit = to_decimal(cols[2].get("value", "")) if len(cols) > 2 else Decimal(0)
            net = debit - credit
            qbo_id = row.get("qbo_id")
            key = f"id:{qbo_id}" if qbo_id else row["name_raw"]
            out[key] = net
        return out

    current = extract(report_current)
    prior   = extract(report_prior)

    # Build {key → (display_name, qbo_id)} so we can resolve the qbo_acct_lookup
    # record after merging the period dicts. Keys here match what extract()
    # produced (id-prefixed when QBO gave us an id).
    def _extract_meta(report: dict) -> dict[str, tuple[str, str | None]]:
        flat: list[dict] = []
        walk(report.get("Rows", {}).get("Row", []) or [], flat)
        out: dict[str, tuple[str, str | None]] = {}
        for row in flat:
            qbo_id = row.get("qbo_id")
            key = f"id:{qbo_id}" if qbo_id else row["name_raw"]
            out[key] = (row["name_raw"], qbo_id)
        return out

    meta: dict[str, tuple[str, str | None]] = {}
    meta.update(_extract_meta(report_prior))
    meta.update(_extract_meta(report_current))  # current overrides prior

    accounts: list[dict] = []
    for key in set(current) | set(prior):
        cur_bal = current.get(key, Decimal(0))
        pri_bal = prior.get(key, Decimal(0))

        display_name, qbo_id = meta.get(key, (key, None))
        qbo_record = qbo_acct_lookup.get(str(qbo_id)) if qbo_id else None
        qbo_acct_type = (qbo_record or {}).get("AccountType") if qbo_record else None

        # Income-statement accounts: a TrialBalance reports them as fiscal-YTD, so
        # for a single-period (month / quarter) flux we swap in the TRUE period
        # activity from the ProfitAndLoss report (which ranges to the exact dates).
        # Balance-sheet accounts keep the TB point-in-time balance. Signed to the
        # TB's debit-positive convention so variance / classification / display are
        # unaffected — only the magnitude changes. Done before the zero-skip so an
        # account with YTD activity but none THIS period correctly drops out.
        if qbo_id and pl_current is not None and _is_pl_type(qbo_acct_type):
            cur_bal = _pl_to_signed(qbo_acct_type, pl_current.get(str(qbo_id)))
            pri_bal = _pl_to_signed(qbo_acct_type, (pl_prior or {}).get(str(qbo_id)))

        if cur_bal == 0 and pri_bal == 0:
            continue

        if qbo_record:
            # Trust the canonical QBO record — it has the proper AcctNum + Name.
            acct_num  = str(qbo_record.get("AcctNum") or "").strip()
            acct_name = str(qbo_record.get("Name") or "").strip() or display_name
        else:
            # No QBO record available — fall back to splitting the display name.
            # Use display_name (the human-readable label) instead of key — key
            # now starts with "id:..." when QBO provided an Id, which would
            # confuse the number-vs-name split below.
            parts = display_name.split(None, 1)
            if parts and parts[0].replace(".", "").replace("-", "").isdigit():
                acct_num  = parts[0].strip()
                acct_name = parts[1].strip() if len(parts) > 1 else acct_num
            else:
                acct_num  = ""           # genuinely no account number
                acct_name = display_name

        # account_number is NOT NULL in the schema — fall back to the qbo id
        # so rows stay unique even when AcctNum is blank for this account.
        # The frontend will render "" → "—" so the user doesn't see this token.
        if not acct_num:
            acct_num = f"qbo-{qbo_id}" if qbo_id else acct_name[:50]

        fs_category, fs_line = classify_account(acct_num, overrides, qbo_acct_type)
        accounts.append({
            "account_number": acct_num,
            "account_name":   acct_name,
            "current_balance":cur_bal,
            "prior_balance":  pri_bal,
            "fs_category":    fs_category,
            "fs_line":        fs_line,
            "qbo_account_id": qbo_id,        # may be None for upload-sourced
            "qbo_account_type": qbo_acct_type,  # for downstream txn filter
        })
    return accounts


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
