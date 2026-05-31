"""
Shared QBO GeneralLedger helper.

Used by both flux (variance txn drill-in) and recons (subledger detail +
variance reason). One canonical pull per (account, window) so flux and
recons stay consistent and the per-account totals always tie out.
"""
from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from models.qbo_connection import QboConnection

logger = logging.getLogger(__name__)


def _dec(val: Any) -> Decimal:
    if val is None or val == "":
        return Decimal("0")
    s = str(val).strip().replace(",", "").replace("$", "")
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        d = Decimal(s)
        return -d if neg else d
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _parse_date(s: Any) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:
        return None


async def pull_gl_transactions(
    conn: QboConnection,
    db: AsyncSession,
    qbo_account_id: str,
    period_start: date,
    period_end: date,
) -> list[dict]:
    """
    Pull every transaction posted to `qbo_account_id` between period_start
    and period_end (inclusive) from QBO's GeneralLedger report.

    Returns a list of dicts shaped like:
      {
        "qbo_txn_id": "1234",
        "txn_type":   "Invoice",
        "txn_number": "INV-001",
        "txn_date":   date(2026, 4, 5),
        "amount":     Decimal("1500.00"),   # signed (debit positive)
        "memo":       "...",
        "entity_name":"Acme Inc"
      }
    Sorted newest-first. Empty if QBO returns nothing or the call fails.
    """
    from modules.recons.service import _qbo_get  # lazy: shared helper lives there

    try:
        report = await _qbo_get(conn, db, "/reports/GeneralLedger", params={
            "start_date":       period_start.isoformat(),
            "end_date":         period_end.isoformat(),
            "account":          qbo_account_id,
            "accounting_method":"Accrual",
            "columns":          "tx_date,txn_type,doc_num,name,memo,subt_nat_amount,split_acc",
            "minorversion":     "65",
        })
    except Exception:
        logger.exception("GeneralLedger pull failed for account=%s", qbo_account_id)
        return []

    return _parse_gl_report(report)


def _parse_gl_report(report: dict) -> list[dict]:
    """Walk the GL report's nested rows and emit one dict per data row."""
    cols = report.get("Columns", {}).get("Column", []) or []
    role_by_idx: dict[int, str] = {}
    for i, c in enumerate(cols):
        coltype = (c.get("ColType") or "").strip().lower()
        title   = (c.get("ColTitle") or "").strip().lower()
        role = _coltype_to_role(coltype, title)
        if role:
            role_by_idx[i] = role

    out: list[dict] = []

    def walk(rows: list[dict]) -> None:
        for r in rows:
            sub = r.get("Rows", {}).get("Row", []) or []
            cd  = r.get("ColData") or []
            if cd and (r.get("type") == "Data" or not r.get("group")):
                first_val = (cd[0].get("value", "") if cd else "").strip().lower()
                if first_val not in ("", "beginning balance", "total", "ending balance"):
                    parsed = _row_to_dict(cd, role_by_idx)
                    if parsed is not None:
                        out.append(parsed)
            if sub:
                walk(sub)

    walk(report.get("Rows", {}).get("Row", []) or [])
    out.sort(key=lambda r: (r.get("txn_date") or date.min), reverse=True)
    return out


# ── Multi-account variant ──────────────────────────────────────────────────
#
# pull_gl_transactions covers the canonical single-account case (variance
# drill-in, subledger detail). For features that need to scan dozens of
# accounts at once (prepaid detector, missed-accrual scan) doing one call
# per account is wasteful — QBO's GeneralLedger report accepts a comma-
# separated `account` parameter and groups the response by account-Section
# rows. The functions below pull and parse that grouped shape so the
# caller gets one flat list of txns each tagged with qbo_account_id +
# qbo_account_name. Batched at 50 accounts per call to stay under URL
# length limits.

# Max account IDs per call. ~50 × 5-char IDs = ~250 chars in the query
# string — well under QBO's URL limit. If a tenant has more expense
# accounts than this we split into multiple calls.
_GL_MULTI_BATCH = 50


async def pull_gl_transactions_multi(
    conn: QboConnection,
    db: AsyncSession,
    qbo_account_ids: list[str],
    period_start: date,
    period_end: date,
) -> list[dict]:
    """
    Pull every transaction posted to ANY of `qbo_account_ids` between
    period_start and period_end (inclusive) in one (or a few batched)
    GeneralLedger report call(s).

    Returns the same shape as pull_gl_transactions PLUS two fields per
    row:
      qbo_account_id   — the account the txn was posted to
      qbo_account_name — that account's name (from the report header)

    Empty list if no IDs given or every call fails.
    """
    if not qbo_account_ids:
        return []

    # Batch to stay under QBO's URL length limit on the `account` param.
    if len(qbo_account_ids) > _GL_MULTI_BATCH:
        out: list[dict] = []
        for i in range(0, len(qbo_account_ids), _GL_MULTI_BATCH):
            out.extend(await pull_gl_transactions_multi(
                conn, db,
                qbo_account_ids[i : i + _GL_MULTI_BATCH],
                period_start, period_end,
            ))
        return out

    from modules.recons.service import _qbo_get  # lazy: shared helper lives there

    try:
        report = await _qbo_get(conn, db, "/reports/GeneralLedger", params={
            "start_date":        period_start.isoformat(),
            "end_date":          period_end.isoformat(),
            "account":           ",".join(qbo_account_ids),
            "accounting_method": "Accrual",
            "columns":           "tx_date,txn_type,doc_num,name,memo,subt_nat_amount,split_acc",
            "minorversion":      "65",
        })
    except Exception:
        logger.exception(
            "Multi-account GeneralLedger pull failed for %d accounts",
            len(qbo_account_ids),
        )
        return []

    return _parse_gl_report_with_account(report)


def _parse_gl_report_with_account(report: dict) -> list[dict]:
    """
    Like _parse_gl_report but tags each row with the enclosing Section's
    account_id + account_name (extracted from Section.Header.ColData).
    Required for multi-account pulls where the same report contains
    activity for many accounts and the caller needs to know which is
    which.
    """
    cols = report.get("Columns", {}).get("Column", []) or []
    role_by_idx: dict[int, str] = {}
    for i, c in enumerate(cols):
        coltype = (c.get("ColType") or "").strip().lower()
        title   = (c.get("ColTitle") or "").strip().lower()
        role = _coltype_to_role(coltype, title)
        if role:
            role_by_idx[i] = role

    out: list[dict] = []

    def walk(rows: list[dict], acct_id: str | None, acct_name: str | None) -> None:
        for r in rows:
            # When entering an Account-grouped Section, swap context to
            # that section's account so any data rows inside inherit it.
            new_id, new_name = acct_id, acct_name
            if r.get("type") == "Section":
                hdr = (r.get("Header") or {}).get("ColData") or []
                if hdr:
                    hid = hdr[0].get("id")
                    hval = (hdr[0].get("value") or "").strip()
                    if hid:
                        new_id = str(hid)
                    if hval:
                        new_name = hval

            sub = r.get("Rows", {}).get("Row", []) or []
            cd  = r.get("ColData") or []
            if cd and (r.get("type") == "Data" or not r.get("group")):
                first_val = (cd[0].get("value", "") if cd else "").strip().lower()
                if first_val not in ("", "beginning balance", "total", "ending balance"):
                    parsed = _row_to_dict(cd, role_by_idx)
                    if parsed is not None:
                        parsed["qbo_account_id"]   = new_id or ""
                        parsed["qbo_account_name"] = new_name or ""
                        out.append(parsed)
            if sub:
                walk(sub, new_id, new_name)

    walk(report.get("Rows", {}).get("Row", []) or [], None, None)
    out.sort(key=lambda r: (r.get("txn_date") or date.min), reverse=True)
    return out


def _coltype_to_role(coltype: str, title: str) -> str | None:
    if coltype in ("tx_date", "txndate", "date"):           return "date"
    if coltype in ("txn_type",):                            return "type"
    if coltype in ("doc_num",):                             return "number"
    if coltype in ("name", "customer", "vendor", "payee"):  return "entity"
    if coltype in ("memo", "description"):                  return "memo"
    if coltype in ("subt_nat_amount", "amount", "subt_amount"):
                                                            return "amount"
    if coltype in ("split_acc", "split"):                   return "split"
    t = title
    if "date" in t and "modify" not in t:                   return "date"
    if "type" in t:                                         return "type"
    if "num" in t:                                          return "number"
    if "memo" in t or "description" in t:                   return "memo"
    if "amount" in t:                                       return "amount"
    if "split" in t:                                        return "split"
    if "name" in t or "customer" in t or "vendor" in t:     return "entity"
    return None


def _row_to_dict(coldata: list[dict], role_by_idx: dict[int, str]) -> dict | None:
    bucket: dict[str, str] = {}
    qbo_txn_id: str | None = None
    for i, c in enumerate(coldata):
        role = role_by_idx.get(i)
        if not role:
            continue
        bucket[role] = (c.get("value", "") or "").strip()
        if not qbo_txn_id and c.get("id"):
            qbo_txn_id = str(c.get("id"))

    amount = _dec(bucket.get("amount", ""))
    if amount == 0 and not bucket.get("number") and not bucket.get("entity") and not bucket.get("memo"):
        return None

    return {
        "qbo_txn_id":  qbo_txn_id,
        "txn_type":    bucket.get("type") or "Transaction",
        "txn_number":  bucket.get("number") or "",
        "txn_date":    _parse_date(bucket.get("date", "")),
        "amount":      amount,
        "memo":        bucket.get("memo") or "",
        "entity_name": bucket.get("entity") or "",
    }
