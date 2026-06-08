"""
PDF bank-statement parser.

Mirrors the contract of bank_csv.py: takes raw bytes, returns
[{txn_date, amount, description, bank_ref}, ...] with `amount` signed
(positive = deposit, negative = withdrawal). Downstream code (persist +
auto-match) doesn't care which format the user uploaded.

Two extraction strategies, tried in order:

  1. extract_tables() — preferred. Modern bank PDFs (Chase, BofA, Wells
     Fargo, Citi, Capital One, most credit unions) render transactions
     as a grid; pdfplumber's table detector finds them reliably.
     Header-row roles are mapped using the same _role_for() heuristic
     as the CSV parser, so a "Posting Date" column maps to "date", a
     "Deposit" column maps to "credit", etc.

  2. Text-line regex fallback — for statements that render as flowing
     text (some smaller banks, exports from PDF viewers that flatten
     tables to text). Looks for lines that start with a date and end
     with an amount, anything in between is the description.

Both strategies skip:
  - Header / footer rows ("Statement period", "Page 1 of 3")
  - Balance-only rows ("Ending balance: $12,345.67")
  - Summary rows ("Total deposits: $5,000.00")
  - Anything where the date column doesn't parse as a real date

Scanned/image-only PDFs (no text layer) return [] with a logged warning
— the router then surfaces a user-friendly "PDF appears to be scanned —
please use the bank's CSV export instead" error.
"""
from __future__ import annotations

import io
import logging
import re
from decimal import Decimal
from typing import Any

from modules.recons.bank_csv import (
    _ENDING_WORDS,
    _OPENING_WORDS,
    _parse_amount,
    _parse_date,
    _role_for,
)

logger = logging.getLogger(__name__)


# ── Table-based extraction (the primary path) ──────────────────────────


def _table_is_transactions(rows: list[list[str | None]]) -> tuple[bool, dict[int, str]]:
    """Check whether a pdfplumber-extracted table looks like a
    transaction grid. Returns (True, col→role map) if yes, else
    (False, {}).

    Heuristic: scan the first 3 rows for a header that maps to at
    least a "date" column AND either an "amount" column or a
    "debit"+"credit" pair.
    """
    for row in rows[:3]:
        if not row:
            continue
        roles: dict[int, str] = {}
        for j, cell in enumerate(row):
            r = _role_for(cell or "")
            if r:
                roles[j] = r
        if "date" in roles.values() and (
            "amount" in roles.values()
            or ("debit" in roles.values() and "credit" in roles.values())
        ):
            return True, roles
    return False, {}


def _extract_from_tables(pdf) -> list[dict[str, Any]]:
    """Walk every page, find transaction tables, extract rows. Returns
    [] if no transaction-shaped tables were found at all."""
    out: list[dict[str, Any]] = []
    for page_idx, page in enumerate(pdf.pages):
        try:
            tables = page.extract_tables() or []
        except Exception:
            # Some PDFs throw on extract_tables (bad embedded fonts,
            # encrypted streams, etc.). Skip the page and let the text
            # fallback try later.
            logger.exception("bank_pdf: extract_tables failed on page %d", page_idx + 1)
            continue
        for tbl_idx, table in enumerate(tables):
            if not table or len(table) < 2:
                continue  # need at least header + 1 data row
            is_txn, role_by_col = _table_is_transactions(table)
            if not is_txn:
                continue
            # Find which row index the header was on so we skip it
            header_idx = 0
            for i, row in enumerate(table[:3]):
                if row and any(_role_for(c or "") for c in row):
                    header_idx = i
                    break
            for raw in table[header_idx + 1:]:
                if not raw or all(not (c or "").strip() for c in raw):
                    continue
                bucket: dict[str, str] = {}
                for col, role in role_by_col.items():
                    if col < len(raw):
                        bucket[role] = (raw[col] or "").strip()
                txn_date = _parse_date(bucket.get("date", ""))
                if txn_date is None:
                    continue  # footer / summary / not a real txn row
                amount = _amount_from_bucket(bucket)
                if amount is None or amount == 0:
                    continue
                out.append({
                    "txn_date":    txn_date,
                    "amount":      amount,
                    "description": (bucket.get("description") or "")[:500] or None,
                    "bank_ref":    (bucket.get("ref") or "")[:100] or None,
                })
            logger.info(
                "bank_pdf: extracted %d rows from page %d table %d",
                len([r for r in table[header_idx + 1:] if r]),
                page_idx + 1, tbl_idx + 1,
            )
    return out


def _amount_from_bucket(bucket: dict[str, str]) -> Decimal | None:
    """Same priority as the CSV parser: single signed amount, else
    debit/credit pair (credit positive, debit negative)."""
    if "amount" in bucket:
        return _parse_amount(bucket.get("amount", ""))
    dr = _parse_amount(bucket.get("debit", "") or "0") or Decimal("0")
    cr = _parse_amount(bucket.get("credit", "") or "0") or Decimal("0")
    if not (dr or cr):
        return None
    return cr - dr


# ── Text-line regex fallback ───────────────────────────────────────────


# Matches a US-formatted date at the START of a line — MM/DD, MM/DD/YY,
# MM/DD/YYYY, MM-DD-YYYY, or "Mon DD" / "Mon DD, YYYY".
_LINE_DATE_RE = re.compile(
    r"""
    ^\s*
    (?P<date>
        (?:\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)   # 4/3, 4-3-2026, 04/03/2026
      | (?:[A-Z][a-z]{2}\s+\d{1,2}(?:,?\s+\d{4})?)   # Apr 3, Apr 3 2026, Apr 3, 2026
    )
    \s+
    """,
    re.VERBOSE,
)

# Matches a money value — handles leading sign, parens, $, commas, and
# trailing DR/CR. Word-boundary anchors prevent matching digits embedded
# inside other tokens like "INVOICE1234" or "REF-4521". The number must
# include a decimal portion so we don't pick up txn IDs, check numbers,
# zip codes, etc.
_LINE_MONEY_RE = re.compile(
    r"""
    (?<![\w.])                                    # left boundary — no word/dot before
    (?P<amt>
        \(?                                       # optional opening paren
        \s*[-+]?\s*\$?\s*                         # optional sign + $
        (?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}         # 1,234.56 or 5000.00 (with required decimals)
        \s*\)?                                    # optional closing paren
        \s*(?:[Dd][Rr]|[Cc][Rr])?                 # optional DR/CR suffix
    )
    (?![\w])                                      # right boundary — no word after
    """,
    re.VERBOSE,
)


def _extract_from_text(pdf, statement_year_hint: int | None = None) -> list[dict[str, Any]]:
    """Walk every page's text, regex match transaction lines. The hint
    is used to backfill year when the date column shows "MM/DD" only —
    we infer from the statement period printed at the top of page 1."""
    out: list[dict[str, Any]] = []

    # Try to find a year hint on page 1 if not provided
    if statement_year_hint is None and pdf.pages:
        first_text = pdf.pages[0].extract_text() or ""
        m = re.search(r"\b(20\d{2})\b", first_text)
        if m:
            statement_year_hint = int(m.group(1))

    for page_idx, page in enumerate(pdf.pages):
        try:
            text = page.extract_text() or ""
        except Exception:
            logger.exception("bank_pdf: extract_text failed on page %d", page_idx + 1)
            continue
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            m_date = _LINE_DATE_RE.match(line)
            if not m_date:
                continue
            date_str = m_date.group("date")
            # Backfill year if just MM/DD
            if statement_year_hint and not re.search(r"\d{4}", date_str):
                date_str = f"{date_str}/{statement_year_hint}"
            txn_date = _parse_date(date_str)
            if txn_date is None:
                continue
            remainder = line[m_date.end():].strip()
            # Find all money tokens, take the FIRST (transaction amount).
            # Banks that include running balance put it LAST, so taking
            # the first picks the transaction amount.
            money_matches = list(_LINE_MONEY_RE.finditer(remainder))
            if not money_matches:
                continue
            first_money = money_matches[0]
            amt = _parse_amount(first_money.group("amt"))
            if amt is None or amt == 0:
                continue
            # Description = everything between date and amount.
            desc = remainder[: first_money.start()].strip(" \t-")
            if not desc:
                desc = None
            out.append({
                "txn_date":    txn_date,
                "amount":      amt,
                "description": desc[:500] if desc else None,
                "bank_ref":    None,    # rarely recoverable from flowing text
            })
    return out


# ── Statement control totals (cross-foot) ──────────────────────────────


def _extract_totals_text(pdf) -> dict[str, Decimal | None]:
    """Scan page text for labeled 'Beginning/Ending Balance' lines and read
    the balance figure (the last money token on the line). Best-effort —
    returns None for whatever isn't found."""
    opening: Decimal | None = None
    ending: Decimal | None = None
    for page in pdf.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            continue
        for raw_line in text.splitlines():
            low = raw_line.strip().lower()
            if "balance" not in low:
                continue
            moneys = list(_LINE_MONEY_RE.finditer(raw_line))
            if not moneys:
                continue
            # The balance figure is the last money token on the line
            # ("Beginning Balance .... 10,000.00").
            amt = _parse_amount(moneys[-1].group("amt"))
            if amt is None:
                continue
            if opening is None and any(w in low for w in _OPENING_WORDS):
                opening = amt
            elif ending is None and any(w in low for w in _ENDING_WORDS):
                ending = amt
        if opening is not None and ending is not None:
            break
    return {"opening_balance": opening, "ending_balance": ending}


# ── Public entry point ─────────────────────────────────────────────────


def parse_bank_pdf(
    raw_bytes: bytes, filename: str = ""
) -> tuple[list[dict[str, Any]], dict[str, Decimal | None]]:
    """Parse a bank-statement PDF.

    Returns (lines, totals) — the same shape as parse_bank_csv:
    lines  = [{txn_date, amount, description, bank_ref}, ...] with `amount`
             signed (positive = deposit, negative = withdrawal);
    totals = {opening_balance, ending_balance} (best-effort, None if absent)."""
    try:
        import pdfplumber
    except ImportError as exc:
        # Fail loud rather than silent-empty — production should always
        # have pdfplumber installed; if it's missing we want to know.
        raise RuntimeError(
            "pdfplumber is not installed — add it to requirements.txt"
        ) from exc

    try:
        pdf = pdfplumber.open(io.BytesIO(raw_bytes))
    except Exception as exc:
        logger.exception("bank_pdf: pdfplumber.open failed for %s", filename or "<upload>")
        raise RuntimeError(
            f"Couldn't open the PDF — file may be corrupted or password-protected: {exc}"
        ) from exc

    try:
        # Strategy 1 — table extraction
        rows = _extract_from_tables(pdf)

        # Strategy 2 — text-line fallback if tables yielded nothing
        if not rows:
            logger.info(
                "bank_pdf: no transaction tables found in %s — trying text-line fallback",
                filename or "<upload>",
            )
            rows = _extract_from_text(pdf)

        if not rows:
            # Last-resort sanity check: is there ANY extractable text at
            # all? If not, this is a scanned image PDF and we can't help.
            try:
                any_text = any((p.extract_text() or "").strip() for p in pdf.pages)
            except Exception:
                any_text = False
            if not any_text:
                logger.warning(
                    "bank_pdf: %s has no extractable text — likely scanned image",
                    filename or "<upload>",
                )
            else:
                logger.warning(
                    "bank_pdf: %s has text but no transactions matched — unfamiliar layout",
                    filename or "<upload>",
                )

        # De-dupe: a PDF that repeats transactions across page boundaries
        # (continued statements) would otherwise produce duplicates.
        seen: set[tuple] = set()
        deduped: list[dict[str, Any]] = []
        for r in rows:
            key = (r["txn_date"], str(r["amount"]), (r["description"] or "")[:100])
            if key in seen:
                continue
            seen.add(key)
            deduped.append(r)
        if len(deduped) < len(rows):
            logger.info(
                "bank_pdf: de-duped %d → %d rows in %s",
                len(rows), len(deduped), filename or "<upload>",
            )
        totals = _extract_totals_text(pdf)
        return deduped, totals
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def is_likely_scanned_pdf(raw_bytes: bytes) -> bool:
    """Quick check used by the router to give a specific error message
    for scanned PDFs (no text layer → user needs OCR / CSV export instead).
    Best-effort: returns False if pdfplumber can't be imported."""
    try:
        import pdfplumber
    except ImportError:
        return False
    try:
        with pdfplumber.open(io.BytesIO(raw_bytes)) as pdf:
            for p in pdf.pages[:3]:
                if (p.extract_text() or "").strip():
                    return False
        return True
    except Exception:
        return False
