"""
AI verification of subledger evidence documents.

The premise: a manual subledger value is just a number a user typed. The
audit-grade question is whether that number actually matches the document
they cited as the source. We hand the file to Anthropic, ask it to pull
out the ending balance / statement date / account ref, and compare.

Supported formats:
  - PDF: sent directly via Anthropic's document content type
  - CSV / Excel: parsed locally to compact text, sent as text content
  - PNG / JPEG: sent as image content type

Output is always the same JSON envelope so the UI can render uniformly:

  {
    "extracted_balance":  "12345.67" | None,
    "statement_date":     "2026-04-30" | None,
    "doc_type":           "bank_statement" | "fa_register" | "prepaid_schedule" | "loan_amortization" | "other",
    "doc_identifier":     "BoA acct ****1234" | None,
    "summary":            "1–2 sentence human explanation",
    "confidence":         "high" | "medium" | "low",
  }

The caller computes match_status / difference against the user-entered
value and stores the merged result on subledger_evidence.verification.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Any

import anthropic
import pandas as pd

from core.config import settings

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

_VERIFY_SYSTEM = """\
You are a senior accountant reviewing supporting evidence for a manual subledger reconciliation.
Read the attached document and extract ONLY what is explicitly shown — never fabricate or estimate.

You must respond with a single JSON object matching this exact schema and nothing else:
{
  "extracted_balance": <string of the ending/closing balance as it appears, or null>,
  "statement_date":    <"YYYY-MM-DD" closing date of the document, or null>,
  "doc_type":          <"bank_statement" | "fa_register" | "prepaid_schedule" | "loan_amortization" | "credit_card_statement" | "other">,
  "doc_identifier":    <best-effort short label like "Bank of America ****1234", or null>,
  "summary":           <one or two sentence factual description of what the document contains>,
  "confidence":        <"high" | "medium" | "low" — how confident you are in the extracted balance>
}

Confidence rubric:
  high   — single unambiguous ending balance, clearly labeled, on the statement date
  medium — value present but format is unusual, or multiple candidate balances
  low    — document is hard to read, partial, or doesn't appear to contain a balance
"""


def _excel_to_text(raw: bytes, max_chars: int = 50_000) -> str:
    """Parse Excel to a compact CSV-style text representation for Anthropic."""
    buf = io.BytesIO(raw)
    try:
        sheets = pd.read_excel(buf, sheet_name=None, header=None)
    except Exception as e:
        logger.exception("Excel parse failed in verify")
        return f"[Could not parse Excel: {e}]"
    parts: list[str] = []
    for name, df in sheets.items():
        parts.append(f"=== Sheet: {name} ===")
        parts.append(df.to_csv(index=False, header=False))
    text = "\n".join(parts)
    return text[:max_chars]


def _csv_to_text(raw: bytes, max_chars: int = 50_000) -> str:
    try:
        return raw.decode("utf-8", errors="replace")[:max_chars]
    except Exception:
        return raw.decode("latin-1", errors="replace")[:max_chars]


def _build_content(raw: bytes, mime: str, file_name: str) -> list[dict[str, Any]]:
    """Build the Anthropic message content array tailored to the file type."""
    mime_lower = (mime or "").lower()
    fname_lower = (file_name or "").lower()

    # PDFs are the canonical case — Anthropic reads them visually.
    if mime_lower == "application/pdf" or fname_lower.endswith(".pdf"):
        return [{
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": base64.standard_b64encode(raw).decode("ascii"),
            },
        }]

    # Image bank statements / register screenshots.
    if mime_lower.startswith("image/") or fname_lower.endswith((".png", ".jpg", ".jpeg")):
        # Normalize the media type — Anthropic only accepts specific values.
        media_type = "image/png" if "png" in mime_lower or fname_lower.endswith(".png") else "image/jpeg"
        return [{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": base64.standard_b64encode(raw).decode("ascii"),
            },
        }]

    # Excel — local parse to text, then send as a single text block.
    if (
        "spreadsheetml" in mime_lower
        or "ms-excel" in mime_lower
        or fname_lower.endswith((".xlsx", ".xls"))
    ):
        return [{"type": "text", "text": f"Excel contents:\n\n{_excel_to_text(raw)}"}]

    # CSV / plain text.
    if mime_lower in ("text/csv", "text/plain") or fname_lower.endswith(".csv"):
        return [{"type": "text", "text": f"CSV contents:\n\n{_csv_to_text(raw)}"}]

    # Unknown — pass nothing so Anthropic responds with low confidence.
    return [{"type": "text", "text": f"[Unsupported file type: {mime} / {file_name}]"}]


def _coerce_balance(value: str | None) -> str | None:
    """Normalize the extracted balance to a plain decimal string."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Handle ($123.45) parens notation as negative.
    negative = s.startswith("(") and s.endswith(")")
    if negative:
        s = s[1:-1]
    s = re.sub(r"[^0-9\.\-]", "", s)
    if not s or s in (".", "-", "-."):
        return None
    try:
        d = Decimal(s)
        if negative:
            d = -d
        return str(d.quantize(Decimal("0.01")))
    except InvalidOperation:
        return None


def verify_evidence_document(
    raw: bytes,
    mime_type: str,
    file_name: str,
    account_type: str | None = None,
    period_end_hint: str | None = None,
) -> dict[str, Any]:
    """
    Run AI extraction on the document and return the parsed JSON envelope.

    `account_type` and `period_end_hint` give Anthropic context but it must
    still extract only what the document literally shows.

    Raises on hard API failure so the caller can surface a clean error.
    """
    content = _build_content(raw, mime_type, file_name)

    instructions = (
        "Extract the ending/closing balance and statement date from this document. "
        f"It is supporting evidence for the {account_type or 'balance sheet'} account in a month-end close."
    )
    if period_end_hint:
        instructions += f" The expected close date is {period_end_hint}, so prefer a balance dated on or near that day."
    instructions += " Respond with the JSON schema described in the system prompt and nothing else."

    content.append({"type": "text", "text": instructions})

    response = _client.messages.create(
        model=settings.anthropic_model,
        max_tokens=600,
        system=_VERIFY_SYSTEM,
        messages=[{"role": "user", "content": content}],
    )
    from core.ai.usage import record_response
    record_response(response, operation="recon_ai_verify")

    raw_text = (response.content[0].text if response.content else "").strip()
    # Strip code fences if the model added any.
    if raw_text.startswith("```"):
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$", "", raw_text)

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        logger.warning("Verify response was not valid JSON: %s", raw_text[:500])
        return {
            "extracted_balance": None,
            "statement_date":    None,
            "doc_type":          "other",
            "doc_identifier":    None,
            "summary":           "AI returned an unparseable response. Re-upload or verify manually.",
            "confidence":        "low",
            "model":             settings.anthropic_model,
        }

    return {
        "extracted_balance": _coerce_balance(parsed.get("extracted_balance")),
        "statement_date":    parsed.get("statement_date"),
        "doc_type":          parsed.get("doc_type") or "other",
        "doc_identifier":    parsed.get("doc_identifier"),
        "summary":           parsed.get("summary") or "",
        "confidence":        parsed.get("confidence") or "low",
        "model":             settings.anthropic_model,
    }


def compute_match(
    extracted: str | None,
    entered: Decimal | None,
    tolerance: Decimal = Decimal("1.00"),
) -> tuple[str, str | None]:
    """
    Given the extracted balance and the user-entered subledger total, return
    (match_status, difference_string).

    match_status:
      - "match"    — within ±tolerance
      - "mismatch" — outside tolerance
      - "unknown"  — extraction missing or unparseable
    """
    if extracted is None or entered is None:
        return "unknown", None
    try:
        e = Decimal(extracted)
    except (InvalidOperation, TypeError):
        return "unknown", None
    diff = (entered - e).quantize(Decimal("0.01"))
    return ("match" if abs(diff) <= tolerance else "mismatch"), str(diff)
