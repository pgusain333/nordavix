"""
Live reconciliation overview — single-source dashboard view.

This module is intentionally STATELESS. Everything pulls live from QuickBooks
when the dashboard refreshes (or the user changes the period). Results aren't
persisted into reconciliations / reconciliation_items — those tables are for
the deeper, persistent workflow (notes, approvals, AI summary on a single
reconciliation).

The overview is what the user sees when they open /app/reconciliations:

  Per balance-sheet account:
    - Account number, name, type
    - GL balance as of period_end (from QBO TrialBalance report)
    - Subledger balance as of period_end (depends on account type)
    - Variance = GL - Subledger

  Subledger source by account type:
    - Bank, Credit Card       → matches GL (no separate subledger)
    - Accounts Receivable     → sum of customer balances on AR aging report
                                (proportional split when multiple AR accounts)
    - Accounts Payable        → sum of vendor balances on AP aging report
    - All other account types → matches GL (no QBO subledger exists)

Detail endpoints exposed alongside this build the subledger detail rows
and variance evidence rows on demand.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from models.qbo_connection import QboConnection
from modules.recons.service import (
    _dec,
    _flatten_report_rows,
    _qbo_get,
    _refresh_token_if_needed,  # noqa: F401  re-used indirectly via _qbo_get
)

logger = logging.getLogger(__name__)


# ── QBO AccountType → display group ──────────────────────────────────────────

# Tells the UI how to label/group the row + which subledger logic to apply.
ACCOUNT_TYPE_GROUPS: dict[str, str] = {
    "Bank":                       "Bank",
    "Credit Card":                "Credit Card",
    "Accounts Receivable":        "AR",
    "Accounts Payable":           "AP",
    "Fixed Asset":                "Fixed Assets",
    "Other Current Asset":        "Other Current Assets",
    "Other Asset":                "Other Assets",
    "Other Current Liability":    "Other Current Liabilities",
    "Long Term Liability":        "Long Term Liabilities",
    "Equity":                     "Equity",
}

# Account types we never reconcile (income statement accounts)
SKIP_ACCOUNT_TYPES = {"Income", "Cost of Goods Sold", "Expense", "Other Income", "Other Expense"}


# ── Public functions ─────────────────────────────────────────────────────────

async def fetch_overview(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> dict:
    """
    Pull every balance-sheet account + its GL + subledger balance + variance.

    Returns:
      {
        "period_end": "YYYY-MM-DD",
        "accounts": [
          {
            "qbo_id": "12",
            "account_number": "1010",
            "account_name": "Cash - BofA",
            "account_type": "Bank",
            "group_label": "Bank",
            "gl_balance": "10000.00",
            "subledger_balance": "10000.00",
            "subledger_source": "Matches GL (no separate subledger)",
            "has_subledger_detail": false,
            "variance": "0.00",
          }, ...
        ],
        "totals": { "gl": "...", "subledger": "...", "variance": "..." },
        "by_group": [ { "group": "Bank", "count": 2, "gl": "...", ...}, ... ],
      }
    """
    accounts_meta = await _list_balance_sheet_accounts(conn, session)
    if not accounts_meta:
        return _empty_overview(period_end)

    tb_balances = await _qbo_trial_balance_by_account(conn, session, period_end)

    # Pull AR / AP aging once each — used to derive per-AR-account subledger
    ar_aging_sum = await _aging_total(conn, session, "AgedReceivables", period_end)
    ap_aging_sum = await _aging_total(conn, session, "AgedPayables", period_end)

    # Sum of GL balances across all AR accounts (and AP accounts) so we can
    # apportion when there are multiple AR/AP accounts.
    ar_gl_total = sum(
        _tb_lookup(tb_balances, a) for a in accounts_meta if a["AccountType"] == "Accounts Receivable"
    )
    ap_gl_total = sum(
        _tb_lookup(tb_balances, a) for a in accounts_meta if a["AccountType"] == "Accounts Payable"
    )

    # Load persisted per-account review status for this period (one query).
    # The dashboard merges this into each account row so the user sees their
    # own approval state for the period they're looking at.
    from models.account_review_status import AccountReviewStatus
    from sqlalchemy import select
    status_rows = list((await session.execute(
        select(AccountReviewStatus).where(AccountReviewStatus.period_end == period_end)
    )).scalars().all())
    status_by_acct: dict[str, AccountReviewStatus] = {
        s.qbo_account_id: s for s in status_rows
    }

    out_accounts: list[dict] = []
    for a in accounts_meta:
        acct_type = a.get("AccountType", "")
        group = ACCOUNT_TYPE_GROUPS.get(acct_type)
        if group is None:
            # Unknown or skip-list — don't surface
            continue

        gl_balance = _tb_lookup(tb_balances, a)
        qbo_id = str(a.get("Id"))
        review = status_by_acct.get(qbo_id)

        # Manual override beats the QBO default. Lets users plug in balances
        # from external sources (bank statements, FA register, prepaid
        # schedule) for account types where QBO has no separate subledger.
        is_manual = review is not None and review.subledger_total is not None
        if is_manual:
            subledger_balance = review.subledger_total
            source = review.subledger_source or "Manually entered"
            has_detail = True  # users can re-edit
        else:
            subledger_balance, source, has_detail = _subledger_for_account(
                acct_type=acct_type,
                gl_balance=gl_balance,
                ar_aging_sum=ar_aging_sum,
                ap_aging_sum=ap_aging_sum,
                ar_gl_total=ar_gl_total,
                ap_gl_total=ap_gl_total,
            )

        variance = (gl_balance - subledger_balance).quantize(Decimal("0.01"))

        out_accounts.append({
            "qbo_id":              qbo_id,
            "account_number":      a.get("AcctNum") or "",
            "account_name":        a.get("Name") or "",
            "account_type":        acct_type,
            "group_label":         group,
            "gl_balance":          str(gl_balance.quantize(Decimal("0.01"))),
            "subledger_balance":   str(subledger_balance.quantize(Decimal("0.01"))),
            "subledger_source":    source,
            "subledger_is_manual": is_manual,
            "subledger_entered_at": review.subledger_entered_at.isoformat()
                                    if (review and review.subledger_entered_at) else None,
            "has_subledger_detail":has_detail,
            "variance":            str(variance),
            "review_status":       review.status if review else "pending",
            "reviewed_by":         str(review.reviewed_by) if review and review.reviewed_by else None,
            "reviewed_at":         review.reviewed_at.isoformat() if review and review.reviewed_at else None,
            "review_notes":        review.notes if review else None,
        })

    # Sort: by group, then by account number
    out_accounts.sort(key=lambda x: (x["group_label"], x["account_number"]))

    totals_gl  = sum((_dec(a["gl_balance"]) for a in out_accounts), Decimal("0"))
    totals_sub = sum((_dec(a["subledger_balance"]) for a in out_accounts), Decimal("0"))
    totals_var = (totals_gl - totals_sub).quantize(Decimal("0.01"))

    # Group rollups
    by_group_map: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "count": 0, "gl": Decimal("0"), "subledger": Decimal("0"),
    })
    for a in out_accounts:
        g = by_group_map[a["group_label"]]
        g["count"] += 1
        g["gl"]        += _dec(a["gl_balance"])
        g["subledger"] += _dec(a["subledger_balance"])

    by_group = [
        {
            "group":     name,
            "count":     v["count"],
            "gl":        str(v["gl"].quantize(Decimal("0.01"))),
            "subledger": str(v["subledger"].quantize(Decimal("0.01"))),
            "variance":  str((v["gl"] - v["subledger"]).quantize(Decimal("0.01"))),
        }
        for name, v in sorted(by_group_map.items())
    ]

    return {
        "period_end": period_end.isoformat(),
        "accounts":   out_accounts,
        "totals": {
            "gl":        str(totals_gl.quantize(Decimal("0.01"))),
            "subledger": str(totals_sub.quantize(Decimal("0.01"))),
            "variance":  str(totals_var),
        },
        "by_group": by_group,
    }


async def fetch_subledger_detail(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> dict:
    """
    Per-account subledger explanation. The shape depends on AccountType:

      AR  → list of customers with aging buckets that roll up to this account's
            apportioned share of total AR (or full AR aging if only one AR
            account).
      AP  → list of vendors with aging buckets (same logic).
      Bank/CC → list of last-90-day transactions touching the account.
      Other  → list of last-90-day journal entry lines touching the account.

    Returns:
      {
        "account": { qbo_id, name, account_type, gl_balance, subledger_balance },
        "rows": [ { label, qbo_id?, current, 1-30, 31-60, 61-90, over_90, total, ... } ],
        "source": "human-readable label",
      }
    """
    accts = await _list_balance_sheet_accounts(conn, session)
    acct = next((a for a in accts if str(a.get("Id")) == str(qbo_account_id)), None)
    if acct is None:
        return {"account": None, "rows": [], "source": "Account not found in QuickBooks."}

    acct_type = acct.get("AccountType", "")
    tb_balances = await _qbo_trial_balance_by_account(conn, session, period_end)
    gl_balance = _tb_lookup(tb_balances, acct)

    base = {
        "account": {
            "qbo_id":         acct.get("Id"),
            "name":           acct.get("Name"),
            "account_number": acct.get("AcctNum") or "",
            "account_type":   acct_type,
            "gl_balance":     str(gl_balance.quantize(Decimal("0.01"))),
        },
    }

    if acct_type == "Accounts Receivable":
        rows, label = await _ar_subledger_rows(conn, session, period_end)
        return {**base, "rows": rows, "source": label}
    if acct_type == "Accounts Payable":
        rows, label = await _ap_subledger_rows(conn, session, period_end)
        return {**base, "rows": rows, "source": label}
    if acct_type in ("Bank", "Credit Card"):
        rows, label = await _txn_rows_for_account(conn, session, acct.get("Id"), period_end)
        return {**base, "rows": rows, "source": label}

    # Generic — show JE lines + any other txns that hit the account
    rows, label = await _je_rows_for_account(conn, session, acct.get("Id"), period_end)
    return {**base, "rows": rows, "source": label}


async def fetch_variance_detail(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> dict:
    """
    Show every transaction posted to this account in the last 90 days, via
    QBO's GeneralLedger report. Same approach as flux variance drill-in so
    totals reconcile uniformly across both modules.

    For AR/AP accounts we also annotate JEs that lack a customer/vendor ref
    — those are the canonical drivers of an aging-vs-GL gap.
    """
    from core.qbo_gl import pull_gl_transactions
    from datetime import timedelta

    accts = await _list_balance_sheet_accounts(conn, session)
    acct = next((a for a in accts if str(a.get("Id")) == str(qbo_account_id)), None)
    if acct is None:
        return {"rows": [], "source": "Account not found.", "total": "0"}

    period_start = period_end - timedelta(days=90)
    gl_rows = await pull_gl_transactions(conn, session, qbo_account_id, period_start, period_end)

    target_ar_ap = acct.get("AccountType") in ("Accounts Receivable", "Accounts Payable")
    rows: list[dict] = []
    total = Decimal("0")
    for r in gl_rows:
        amount = r["amount"]
        total += amount
        # For AR/AP, JEs without a customer/vendor in the entity column are
        # the most likely cause of an aging-vs-GL gap — flag them.
        is_je = r["txn_type"].lower() in ("journal entry", "journalentry")
        no_entity = not r["entity_name"]
        flag = "no_entity_ref" if (target_ar_ap and is_je and no_entity) else None
        rows.append({
            "txn_id":     r["qbo_txn_id"] or "",
            "txn_type":   r["txn_type"],
            "txn_number": r["txn_number"] or "",
            "txn_date":   r["txn_date"].isoformat() if r["txn_date"] else "",
            "amount":     str(amount),
            "memo":       r["memo"] or "",
            "entity":     r["entity_name"] or "",
            "flag":       flag,
        })

    label = (
        "Last 90 days of activity on this account from QuickBooks. "
        "JEs flagged as 'no customer/vendor ref' typically explain the GL-vs-subledger gap."
        if target_ar_ap
        else "Last 90 days of activity on this account from QuickBooks (GeneralLedger report)."
    )
    return {
        "rows":   rows,
        "source": label,
        "total":  str(total.quantize(Decimal("0.01"))),
    }


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _list_balance_sheet_accounts(
    conn: QboConnection,
    session: AsyncSession,
) -> list[dict]:
    """Return active accounts whose AccountType is reconcilable."""
    types = list(ACCOUNT_TYPE_GROUPS.keys())
    quoted = ", ".join(f"'{t}'" for t in types)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType, CurrentBalance "
        f"FROM Account WHERE AccountType IN ({quoted}) AND Active = true "
        f"MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("Account list pull failed")
        return []
    return data.get("QueryResponse", {}).get("Account", []) or []


async def _qbo_trial_balance_by_account(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> dict[str, Decimal]:
    """Period-end balance per account name, from the TrialBalance report."""
    try:
        report = await _qbo_get(
            conn, session, "/reports/TrialBalance",
            params={"end_date": period_end.isoformat(), "accounting_method": "Accrual"},
        )
    except Exception:
        logger.exception("TrialBalance pull failed for %s", period_end)
        return {}
    out: dict[str, Decimal] = {}

    def walk(rows: list[dict]) -> None:
        for r in rows:
            cols = r.get("ColData") or []
            sub = r.get("Rows", {}).get("Row", []) or []
            if cols and cols[0].get("value"):
                name = str(cols[0]["value"]).strip()
                low = name.lower()
                if name and not low.startswith(("total", "subtotal", "net income", "net loss")):
                    debit  = _dec(cols[1].get("value", "")) if len(cols) > 1 else Decimal("0")
                    credit = _dec(cols[2].get("value", "")) if len(cols) > 2 else Decimal("0")
                    out[name] = debit - credit
                    # Also try with normalized whitespace
                    out[" ".join(name.split())] = debit - credit
            if sub:
                walk(sub)

    walk(report.get("Rows", {}).get("Row", []) or [])
    return out


def _tb_lookup(tb_balances: dict[str, Decimal], acct: dict) -> Decimal:
    """Look up a QBO account's period-end balance by trying several name forms."""
    name = acct.get("Name", "") or ""
    acct_num = acct.get("AcctNum", "") or ""
    # QBO TrialBalance keys are usually "<acctnum> <name>" or just "<name>"
    candidates = [
        f"{acct_num} {name}".strip(),
        name,
        f"{name} ({acct_num})".strip() if acct_num else "",
    ]
    for c in candidates:
        if c and c in tb_balances:
            return tb_balances[c]
    # Last-ditch: fall back to CurrentBalance (which is as-of-now, not period_end)
    return _dec(acct.get("CurrentBalance", "0"))


async def _aging_total(
    conn: QboConnection,
    session: AsyncSession,
    report_name: str,
    period_end: date,
) -> Decimal:
    """Total of the aging report (AR or AP) at period_end."""
    try:
        report = await _qbo_get(
            conn, session, f"/reports/{report_name}",
            params={"report_date": period_end.isoformat(), "aging_method": "Current"},
        )
    except Exception:
        logger.exception("%s pull failed for %s", report_name, period_end)
        return Decimal("0")

    rows = _flatten_report_rows(report)
    total = Decimal("0")
    aliases = ["Total", "Amount", "Balance"]
    for r in rows:
        name = r.get("col_0", "") or ""
        if str(name).strip().upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        v = None
        for a in aliases:
            if a in r:
                v = r[a]; break
        if v is None:
            v = r.get("col_6", "")  # positional fallback (aging Total column)
        total += _dec(v)
    return total


def _subledger_for_account(
    *,
    acct_type: str,
    gl_balance: Decimal,
    ar_aging_sum: Decimal,
    ap_aging_sum: Decimal,
    ar_gl_total: Decimal,
    ap_gl_total: Decimal,
) -> tuple[Decimal, str, bool]:
    """
    Decide the subledger balance + source label + whether a detail view exists.

    Sign convention:
      - QBO TrialBalance returns BALANCES (debit - credit). Liability/Equity
        accounts have credit balances, so GL comes back NEGATIVE.
      - QBO AgedReceivables / AgedPayables reports always return POSITIVE
        amounts (the balance owed/due as a magnitude).
      - To get a meaningful variance via simple subtraction we must align
        the signs: for natural-credit account types (AP, Credit Card,
        liabilities) we negate the subledger to match GL's natural sign.
    """
    if acct_type == "Accounts Receivable":
        # Apportion the AR aging across multiple AR accounts proportionally.
        # AR is a natural debit — subledger stays positive.
        if ar_gl_total != 0:
            share = gl_balance / ar_gl_total
            return (ar_aging_sum * share).quantize(Decimal("0.01")), \
                   "QuickBooks AgedReceivables report (proportionally allocated when multiple AR accounts exist).", \
                   True
        return ar_aging_sum, "QuickBooks AgedReceivables report.", True

    if acct_type == "Accounts Payable":
        # AP is a natural credit — flip the sign so it lines up with GL's
        # negative balance. Otherwise GL=-1603 vs Sub=+1603 nets to a phantom
        # -3206 variance even though the books actually reconcile.
        if ap_gl_total != 0:
            # ap_gl_total here is also negative (sum of credit balances) —
            # use absolute value for the proportional split so the share
            # itself is positive, then negate the resulting subledger.
            denom = abs(ap_gl_total) or Decimal("1")
            share = abs(gl_balance) / denom
            return (-ap_aging_sum * share).quantize(Decimal("0.01")), \
                   "QuickBooks AgedPayables report (proportionally allocated when multiple AP accounts exist).", \
                   True
        return -ap_aging_sum, "QuickBooks AgedPayables report.", True

    if acct_type in ("Bank", "Credit Card"):
        return gl_balance, "Matches GL — no separate subledger in QuickBooks.", True

    return gl_balance, "Matches GL — this account type has no separate subledger.", True


def _empty_overview(period_end: date) -> dict:
    return {
        "period_end": period_end.isoformat(),
        "accounts":   [],
        "totals":     {"gl": "0.00", "subledger": "0.00", "variance": "0.00"},
        "by_group":   [],
    }


async def _ar_subledger_rows(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> tuple[list[dict], str]:
    """Customer-level aging from AgedReceivables, formatted for the detail drawer."""
    try:
        report = await _qbo_get(
            conn, session, "/reports/AgedReceivables",
            params={"report_date": period_end.isoformat(), "aging_method": "Current"},
        )
    except Exception:
        return [], "Could not fetch AgedReceivables from QuickBooks."

    rows = _flatten_report_rows(report)
    POS = {"current": 1, "1_30": 2, "31_60": 3, "61_90": 4, "over_90": 5, "total": 6}

    def cell(r: dict, key: str) -> str:
        v = _try_titles(r, key)
        if v in (None, ""):
            v = r.get(f"col_{POS[key]}", "")
        return str(v or "0")

    out: list[dict] = []
    for r in rows:
        name = r.get("Customer") or r.get("col_0", "")
        s = str(name or "").strip()
        if not s or s.upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        total = _dec(cell(r, "total"))
        if total == 0:
            continue
        out.append({
            "label":         s,
            "qbo_id":        r.get("Customer_id") or r.get("_entity_id"),
            "current":       cell(r, "current"),
            "1_30":          cell(r, "1_30"),
            "31_60":         cell(r, "31_60"),
            "61_90":         cell(r, "61_90"),
            "over_90":       cell(r, "over_90"),
            "total":         cell(r, "total"),
        })
    out.sort(key=lambda x: _dec(x["total"]), reverse=True)
    return out, "QuickBooks AgedReceivables report at period end."


async def _ap_subledger_rows(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> tuple[list[dict], str]:
    """Vendor-level aging from AgedPayables, formatted for the detail drawer."""
    try:
        report = await _qbo_get(
            conn, session, "/reports/AgedPayables",
            params={"report_date": period_end.isoformat(), "aging_method": "Current"},
        )
    except Exception:
        return [], "Could not fetch AgedPayables from QuickBooks."

    rows = _flatten_report_rows(report)
    POS = {"current": 1, "1_30": 2, "31_60": 3, "61_90": 4, "over_90": 5, "total": 6}

    def cell(r: dict, key: str) -> str:
        v = _try_titles(r, key)
        if v in (None, ""):
            v = r.get(f"col_{POS[key]}", "")
        return str(v or "0")

    out: list[dict] = []
    for r in rows:
        name = r.get("Vendor") or r.get("col_0", "")
        s = str(name or "").strip()
        if not s or s.upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        total = _dec(cell(r, "total"))
        if total == 0:
            continue
        out.append({
            "label":     s,
            "qbo_id":    r.get("Vendor_id") or r.get("_entity_id"),
            "current":   cell(r, "current"),
            "1_30":      cell(r, "1_30"),
            "31_60":     cell(r, "31_60"),
            "61_90":     cell(r, "61_90"),
            "over_90":   cell(r, "over_90"),
            "total":     cell(r, "total"),
        })
    out.sort(key=lambda x: _dec(x["total"]), reverse=True)
    return out, "QuickBooks AgedPayables report at period end."


def _try_titles(r: dict, bucket: str) -> Any:
    """Find an aging value by trying common column-title variants."""
    aliases = {
        "current":   ["Current", "0-30", "0 - 30", "current", "Current Due"],
        "1_30":      ["1 - 30", "1-30", "1 to 30", "Days1to30", "Age1_30"],
        "31_60":     ["31 - 60", "31-60", "31 to 60", "Days31to60", "Age31_60"],
        "61_90":     ["61 - 90", "61-90", "61 to 90", "Days61to90", "Age61_90"],
        "over_90":   ["91 and over", "> 90", "Over 90", "Days90Plus", "Over90Days"],
        "total":     ["Total", "Amount", "Balance"],
    }
    for k in aliases[bucket]:
        if k in r and r[k] not in (None, ""):
            return r[k]
    return None


async def _txn_rows_for_account(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> tuple[list[dict], str]:
    """Bank/CC: recent transactions touching this account (last 90 days)."""
    cutoff = (period_end - timedelta(days=90)).isoformat()
    end = period_end.isoformat()
    out: list[dict] = []

    # Deposits and Purchases hit Bank/CC accounts directly via AccountRef
    for entity, name_field in [("Purchase", "DocNumber"), ("Deposit", "DocNumber")]:
        try:
            q = (
                f"SELECT Id, {name_field}, TotalAmt, TxnDate, PrivateNote, AccountRef "
                f"FROM {entity} WHERE TxnDate >= '{cutoff}' AND TxnDate <= '{end}' "
                f"MAXRESULTS 100"
            )
            data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        except Exception:
            continue
        for t in data.get("QueryResponse", {}).get(entity, []) or []:
            if (t.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            out.append({
                "txn_id":      t.get("Id"),
                "txn_type":    entity,
                "txn_number":  str(t.get(name_field) or ""),
                "txn_date":    t.get("TxnDate") or "",
                "amount":      str(t.get("TotalAmt") or "0"),
                "memo":        (t.get("PrivateNote") or "")[:200],
            })

    out.sort(key=lambda x: x["txn_date"], reverse=True)
    return out, "Recent deposits and purchases hitting this account (last 90 days)."


async def _je_rows_for_account(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> tuple[list[dict], str]:
    """Generic: list recent JE lines hitting the account."""
    cutoff = (period_end - timedelta(days=90)).isoformat()
    end = period_end.isoformat()
    try:
        q = (
            f"SELECT Id, DocNumber, TxnDate, PrivateNote, Line "
            f"FROM JournalEntry WHERE TxnDate >= '{cutoff}' AND TxnDate <= '{end}' "
            f"MAXRESULTS 100"
        )
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        jes = data.get("QueryResponse", {}).get("JournalEntry", []) or []
    except Exception:
        return [], "Could not fetch journal entries from QuickBooks."

    out: list[dict] = []
    for je in jes:
        amount = Decimal("0")
        for line in je.get("Line", []) or []:
            d = line.get("JournalEntryLineDetail") or {}
            if (d.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            line_amt = _dec(line.get("Amount"))
            amount += line_amt if d.get("PostingType") == "Debit" else -line_amt
        if amount == 0:
            continue
        out.append({
            "txn_id":      je.get("Id"),
            "txn_type":    "JournalEntry",
            "txn_number":  str(je.get("DocNumber") or ""),
            "txn_date":    je.get("TxnDate") or "",
            "amount":      str(amount),
            "memo":        (je.get("PrivateNote") or "")[:200],
        })
    out.sort(key=lambda x: x["txn_date"], reverse=True)
    return out, "Recent journal entry activity on this account (last 90 days)."
