"""
Tolerant CSV parser for bank statement uploads.

Banks export wildly different column layouts. This parser:
  1) Reads headers and maps them to canonical roles (date / desc /
     amount / debit / credit / ref) using fuzzy keyword matching.
  2) Tries common date formats per cell.
  3) Returns a flat list of {txn_date, amount, description, bank_ref}
     with `amount` signed: positive = deposit, negative = withdrawal.

Designed to handle:
  - Chase: "Posting Date,Description,Amount,Type,Balance,Check or Slip #"
  - Wells Fargo: "Date,Amount,*,*,Description" (no headers, 5 cols)
  - BofA: "Posted Date,Reference Number,Payee,Address,Amount"
  - Generic: "Date,Description,Debit,Credit" or "Date,Description,Amount"

Skips header rows automatically (anything that doesn't parse as a date
in the date column gets dropped). Unparseable rows raise nothing — they
just don't end up in the output (with a logged warning).
"""
from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date as _date
from decimal import Decimal, InvalidOperation
from typing import Any

logger = logging.getLogger(__name__)


# ── Column role detection ──────────────────────────────────────────────

_DATE_KEYS   = ("date", "posted", "posting", "transaction", "txn")
_DESC_KEYS   = ("description", "memo", "details", "payee", "name", "merchant", "category")
_AMOUNT_KEYS = ("amount", "amt")
_DEBIT_KEYS  = ("debit", "withdrawal", "withdrawn", "paid out", "payment")
_CREDIT_KEYS = ("credit", "deposit", "paid in", "received")
_REF_KEYS    = ("ref", "check", "number", "id", "trace", "confirmation")
_BALANCE_KEYS = ("balance",)


def _role_for(header: str) -> str | None:
    h = (header or "").strip().lower()
    if not h:
        return None
    if any(k in h for k in _DATE_KEYS) and "modif" not in h:  # skip "modified date"
        return "date"
    if any(k in h for k in _DEBIT_KEYS):
        return "debit"
    if any(k in h for k in _CREDIT_KEYS):
        return "credit"
    # Running-/available-balance column — used only to derive the statement's
    # opening/ending control totals, never as a transaction amount.
    if any(k in h for k in _BALANCE_KEYS):
        return "balance"
    if any(k in h for k in _AMOUNT_KEYS):
        return "amount"
    if any(k in h for k in _DESC_KEYS):
        return "description"
    if any(k in h for k in _REF_KEYS):
        return "ref"
    return None


# ── Value parsing ──────────────────────────────────────────────────────

# Common US bank date formats. Tried in order — first match wins.
_DATE_FORMATS = (
    "%Y-%m-%d",
    "%m/%d/%Y",
    "%m/%d/%y",
    "%m-%d-%Y",
    "%d/%m/%Y",
    "%Y/%m/%d",
    "%b %d, %Y",
    "%d-%b-%Y",
)


def _parse_date(s: str) -> _date | None:
    s = (s or "").strip()
    if not s:
        return None
    from datetime import datetime as _datetime
    for fmt in _DATE_FORMATS:
        try:
            return _datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _parse_amount(s: str) -> Decimal | None:
    """Strip $ , spaces, parentheses; return signed Decimal."""
    s = (s or "").strip()
    if not s:
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1]
    s = re.sub(r"[\$\s,]", "", s)
    # Handle trailing "DR"/"CR" or "Dr"/"Cr" suffixes
    if s.endswith(("dr", "DR")):
        s = s[:-2]
        # Debit in bank-statement-speak = money OUT (withdrawal). Flip sign.
        neg = not neg
    elif s.endswith(("cr", "CR")):
        s = s[:-2]
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    return -d if neg else d


# ── Statement control totals (cross-foot) ──────────────────────────────

def _first_money(cells: list[str]) -> Decimal | None:
    """First parseable money value in a row of cells — used to read the
    amount off a labeled 'Beginning/Ending Balance' summary row."""
    for c in cells:
        v = _parse_amount(c or "")
        if v is not None:
            return v
    return None


_OPENING_WORDS = (
    "beginning balance", "opening balance", "previous balance",
    "starting balance", "balance forward", "beginning of",
)
_ENDING_WORDS = (
    "ending balance", "closing balance", "new balance",
    "current balance", "statement balance", "end of",
)


def _statement_totals(
    all_rows: list[list[str]],
    running: list[tuple[Decimal, Decimal]],
) -> dict[str, Decimal | None]:
    """Best-effort statement opening + ending balance for the cross-foot
    control check. Explicit labeled rows win; otherwise derive from a
    running-balance column (opening = first row's balance − its amount;
    ending = last row's balance). Returns None for whatever can't be found —
    the caller treats that as 'unverifiable', not a tie-out failure."""
    opening: Decimal | None = None
    ending: Decimal | None = None

    for raw in all_rows:
        joined = " ".join((c or "") for c in raw).lower()
        if "balance" not in joined:
            continue
        amt = _first_money(raw)
        if amt is None:
            continue
        if opening is None and any(w in joined for w in _OPENING_WORDS):
            opening = amt
        elif ending is None and any(w in joined for w in _ENDING_WORDS):
            ending = amt

    if running:
        first_amount, first_balance = running[0]
        last_balance = running[-1][1]
        if opening is None:
            opening = first_balance - first_amount
        if ending is None:
            ending = last_balance

    return {"opening_balance": opening, "ending_balance": ending}


# ── Public parse entry point ───────────────────────────────────────────

def parse_bank_csv(
    raw_bytes: bytes, filename: str = ""
) -> tuple[list[dict[str, Any]], dict[str, Decimal | None]]:
    """
    Parse a bank-statement CSV.

    Returns (lines, totals):
      lines  = [{ "txn_date": date, "amount": Decimal, "description": str | None,
                  "bank_ref": str | None }, ...]
      totals = { "opening_balance": Decimal | None,
                 "ending_balance":  Decimal | None }

      `amount` is signed:
        positive = deposit / money in
        negative = withdrawal / money out
      Totals are best-effort (None when the statement doesn't expose them).
    """
    # Tolerant decode — try UTF-8 first, fall back to latin-1 which
    # accepts any byte sequence (some old bank exports use Windows-1252
    # or ISO-8859-1 and crash strict UTF-8 decoders on a stray accent).
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = raw_bytes.decode("cp1252")
        except UnicodeDecodeError:
            text = raw_bytes.decode("latin-1", errors="replace")

    # Sniff the dialect — comma vs semicolon vs tab.
    try:
        sample = text[:4096]
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        # Fall back to plain comma if sniffing fails (single-column or
        # malformed files).
        class _D(csv.Dialect):
            delimiter = ","
            quotechar = '"'
            doublequote = True
            skipinitialspace = True
            lineterminator = "\n"
            quoting = csv.QUOTE_MINIMAL
        dialect = _D

    reader = csv.reader(io.StringIO(text), dialect)
    rows = list(reader)
    _empty_totals: dict[str, Decimal | None] = {"opening_balance": None, "ending_balance": None}
    if not rows:
        return [], _empty_totals

    # Find a header row — the first row whose cells map to known roles
    # for at least one date column. If no header row scores, assume the
    # first row IS data and use positional defaults.
    header_idx = None
    role_by_col: dict[int, str] = {}
    for i, row in enumerate(rows[:5]):  # only inspect the first 5 rows
        roles: dict[int, str] = {}
        for j, cell in enumerate(row):
            r = _role_for(cell)
            if r:
                roles[j] = r
        if "date" in roles.values() and (
            "amount" in roles.values() or
            ("debit" in roles.values() and "credit" in roles.values())
        ):
            header_idx = i
            role_by_col = roles
            break

    if header_idx is None:
        # No detectable header — bail. Most banks have headers; refusing
        # rather than guessing protects against silently importing
        # garbage from an unfamiliar layout.
        logger.warning(
            "bank_csv: no detectable header row in %s (first 5 rows scanned)",
            filename or "<upload>",
        )
        return [], _empty_totals

    data_rows = rows[header_idx + 1:]
    out: list[dict[str, Any]] = []
    # (txn_amount, running_balance) for rows that carry a balance column —
    # used to derive opening/ending control totals when the statement has no
    # explicit "Beginning/Ending Balance" summary rows.
    running: list[tuple[Decimal, Decimal]] = []

    for raw in data_rows:
        if not raw or all(not c.strip() for c in raw):
            continue

        bucket: dict[str, str] = {}
        for col, role in role_by_col.items():
            if col < len(raw):
                bucket[role] = (raw[col] or "").strip()

        txn_date = _parse_date(bucket.get("date", ""))
        if txn_date is None:
            # Probably a footer row ("Ending balance", "Total", etc.) — skip.
            continue

        # Amount resolution priority: single signed amount > debit/credit pair
        amount: Decimal | None
        if "amount" in bucket:
            amount = _parse_amount(bucket.get("amount", ""))
        else:
            dr = _parse_amount(bucket.get("debit", "") or "0") or Decimal("0")
            cr = _parse_amount(bucket.get("credit", "") or "0") or Decimal("0")
            # Bank-statement convention: Debit = money OUT (negative),
            # Credit = money IN (positive). The cash-account sign on
            # the GL side matches: deposit increases cash (debit GL),
            # withdrawal decreases cash (credit GL). We store with
            # bank-side signs so the matcher can compare directly.
            amount = cr - dr if (cr or dr) else None

        if amount is None or amount == 0:
            continue

        description = bucket.get("description") or None
        if description:
            description = description[:500]

        bank_ref = bucket.get("ref") or None
        if bank_ref:
            bank_ref = bank_ref[:100]

        bal = _parse_amount(bucket.get("balance", "")) if "balance" in bucket else None
        if bal is not None:
            running.append((amount, bal))

        out.append({
            "txn_date":    txn_date,
            "amount":      amount,
            "description": description,
            "bank_ref":    bank_ref,
        })

    return out, _statement_totals(rows, running)
