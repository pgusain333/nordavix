"""
Canonical QuickBooks TrialBalance fetcher + parser.

Both Reconciliations and Flux Analysis call this so they're guaranteed to
hit QBO with the same parameters and parse the response the same way. If
either module ever has its own TB code, balances will silently drift —
this module exists to make that impossible.

The fetch parameters were tuned for accuracy:
  - start_date + end_date         → forces "as-of snapshot" mode for BS
                                     accounts; without start_date QBO
                                     sometimes returns empty cells.
  - accounting_method = Accrual   → matches what QBO TB reports show by
                                     default and aligns with how AR / AP
                                     are computed for reconciliation.
  - summarize_column_by = Total   → single Debit/Credit column pair, not
                                     month-by-month breakdown.
  - minorversion = 65             → modern API behavior; ensures `id` is
                                     populated on the Account column row.
"""
from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from typing import TypedDict

import httpx

from core.config import settings
from core.qbo_http import request_with_retry
from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)


class TbBalances(TypedDict):
    """Result of parse_trial_balance(report)."""
    by_id:   dict[str, Decimal]    # Canonical: QBO Account.Id → balance
    by_name: dict[str, Decimal]    # Fallback: name variants → balance
    rows:    int                    # Total non-summary rows we recorded
    debit_total:  Decimal          # Σ of parsed debit columns (integrity check)
    credit_total: Decimal          # Σ of parsed credit columns (integrity check)


async def fetch_trial_balance(
    conn: QboConnection,
    period_end: date,
    *,
    period_start: date | None = None,
    accounting_method: str = "Accrual",
) -> dict:
    """
    Pull the QBO TrialBalance report. Returns the raw QBO JSON.

    `period_start` defaults to Jan 1 of the period_end year — that's the
    standard "year-to-date as of period_end" snapshot. Pass a different
    start date when you want a true range (e.g. month activity for P&L).

    Raises RuntimeError on any non-2xx response; callers wrap it in their
    own HTTPException to surface a user-friendly message.
    """
    # We need a fresh db session for the token refresh helper. Use a
    # short-lived one to avoid coupling the public signature to whatever
    # session the caller is in.
    from core.db.session import AsyncSessionLocal
    from modules.recons.service import _refresh_token_if_needed

    async with AsyncSessionLocal() as session:
        token = await _refresh_token_if_needed(conn, session)

    start = period_start or date(period_end.year, 1, 1)
    params = {
        "start_date":          start.isoformat(),
        "end_date":            period_end.isoformat(),
        "accounting_method":   accounting_method,
        "summarize_column_by": "Total",
        "minorversion":        "65",
    }
    url = f"{settings.qbo_base_url}/v3/company/{conn.realm_id}/reports/TrialBalance"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await request_with_retry(
            lambda: client.get(url, headers=headers, params=params),
            label="QBO TrialBalance",
        )
    if resp.status_code == 401:
        raise RuntimeError("QBO returned 401 — reconnect QuickBooks.")
    if resp.status_code != 200:
        raise RuntimeError(f"QBO TrialBalance pull failed ({resp.status_code}): {resp.text[:500]}")
    return resp.json()


def _dec(val: object) -> Decimal:
    """Parse a numeric value from QBO report text. Handles parens for negatives."""
    if val is None or val == "":
        return Decimal("0")
    s = str(val).strip().replace(",", "").replace("$", "")
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        d = Decimal(s)
        return -d if neg else d
    except Exception:
        return Decimal("0")


def parse_trial_balance(report: dict) -> TbBalances:
    """
    Walk a QBO TrialBalance JSON report and return canonical balance maps.

    Keys recorded for each non-summary row:
      - QBO Account.Id (when present in cols[0].id) → balance        [by_id]
      - account display name (raw)                  → balance        [by_name]
      - same name with collapsed whitespace         → balance        [by_name]
      - bare sub-account name (after "Parent:Sub" split) → balance   [by_name]
      - leading number-like token of the name      → balance         [by_name]

    Callers should look up by_id first (canonical) and only fall back to
    by_name when the id wasn't recorded — old QBO instances may not always
    include id, but newer ones reliably do with minorversion=65.
    """
    out_id: dict[str, Decimal] = {}
    out_name: dict[str, Decimal] = {}
    count = 0
    debit_sum = Decimal("0")
    credit_sum = Decimal("0")

    def walk(rows: list[dict]) -> None:
        nonlocal count, debit_sum, credit_sum
        for r in rows:
            cols = r.get("ColData") or []
            sub  = r.get("Rows", {}).get("Row", []) or []
            if cols and cols[0].get("value"):
                name    = str(cols[0]["value"]).strip()
                acct_id = cols[0].get("id") or ""
                low     = name.lower()
                # Skip summary rows that aren't real accounts
                if name and not low.startswith(("total", "subtotal", "net income", "net loss")):
                    debit  = _dec(cols[1].get("value", "")) if len(cols) > 1 else Decimal("0")
                    credit = _dec(cols[2].get("value", "")) if len(cols) > 2 else Decimal("0")
                    bal = debit - credit
                    count += 1
                    debit_sum += debit
                    credit_sum += credit
                    if acct_id:
                        out_id[str(acct_id)] = bal
                    out_name[name] = bal
                    out_name[" ".join(name.split())] = bal
                    if ":" in name:
                        out_name[name.split(":")[-1].strip()] = bal
                    if " " in name:
                        first_tok = name.split(" ", 1)[0]
                        if first_tok.replace("-", "").replace(".", "").isdigit():
                            out_name[first_tok] = bal
            if sub:
                walk(sub)

    walk(report.get("Rows", {}).get("Row", []) or [])
    return {
        "by_id": out_id, "by_name": out_name, "rows": count,
        "debit_total": debit_sum, "credit_total": credit_sum,
    }


def tb_imbalance(tb: TbBalances) -> Decimal:
    """Σdebits − Σcredits across the parsed rows. A real QBO trial balance always
    balances to 0, so a non-zero result means OUR parse dropped or misread a cell
    (e.g. _dec coerced a bad value to 0) — the ingest is incomplete, not that QBO
    is wrong. Callers treat a material imbalance as 'don't trust this snapshot'.
    Uses .get() so a partial/legacy TbBalances (no totals) reads as 0."""
    d = tb.get("debit_total", Decimal("0"))
    c = tb.get("credit_total", Decimal("0"))
    return (d - c).quantize(Decimal("0.01"))


def lookup_balance(
    tb: TbBalances,
    *,
    qbo_id: str = "",
    acct_num: str = "",
    name: str = "",
) -> Decimal | None:
    """
    Resolve a single account's balance using id → number → name variants.

    Returns None on a clean miss so the caller decides what to do (a 0,
    a warning, etc.) — DO NOT fall back to QBO's CurrentBalance because
    that's today's value, not the period-end value.
    """
    if qbo_id and qbo_id in tb["by_id"]:
        return tb["by_id"][qbo_id]
    if acct_num and acct_num in tb["by_name"]:
        return tb["by_name"][acct_num]
    candidates = [
        f"{acct_num} {name}".strip() if acct_num else name,
        name,
        f"{name} ({acct_num})".strip() if acct_num else "",
        name.split(":")[-1].strip() if ":" in name else "",
    ]
    for k in candidates:
        if k and k in tb["by_name"]:
            return tb["by_name"][k]
    return None
