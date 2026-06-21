"""Parse user-attached chat files into Claude-readable content blocks.

EPHEMERAL by design: the bytes are decoded in-request, handed to the model, and
never persisted (no R2 object, no DB row) — so an uploaded client document leaves
no new copy at rest. Images go to the vision model as base64; PDFs and
spreadsheets are extracted to text server-side (so we don't depend on model
document support). Everything is type- and size-capped; an unreadable or oversized
file degrades to a short note rather than failing the turn.
"""
from __future__ import annotations

import base64
import binascii
import io
import logging

logger = logging.getLogger(__name__)

MAX_FILES = 3
MAX_BYTES = 6 * 1024 * 1024        # 6 MB per file (raw)
MAX_TEXT_CHARS = 20_000            # cap extracted text per file

_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}
_PDF_TYPES = {"application/pdf"}
_XLSX_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
}
_TEXT_TYPES = {"text/csv", "application/csv", "text/plain"}


def _clip(s: str) -> str:
    s = (s or "").strip()
    return s if len(s) <= MAX_TEXT_CHARS else s[:MAX_TEXT_CHARS] + "\n…[truncated]"


def _pdf_text(raw: bytes) -> str:
    import pdfplumber
    parts: list[str] = []
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for page in pdf.pages[:30]:
            parts.append(page.extract_text() or "")
            if sum(len(p) for p in parts) > MAX_TEXT_CHARS:
                break
    return "\n".join(parts)


def _xlsx_text(raw: bytes) -> str:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    try:
        parts: list[str] = []
        for ws in wb.worksheets:
            parts.append(f"# Sheet: {ws.title}")
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i > 200:
                    parts.append("…[more rows]")
                    break
                cells = ["" if c is None else str(c) for c in row]
                if any(cells):
                    parts.append("\t".join(cells))
                if sum(len(p) for p in parts) > MAX_TEXT_CHARS:
                    break
            if sum(len(p) for p in parts) > MAX_TEXT_CHARS:
                break
        return "\n".join(parts)
    finally:
        wb.close()


def build_attachment_blocks(attachments) -> list[dict]:
    """Turn Attachment models into Anthropic content blocks: image blocks for
    pictures, text blocks for extracted documents. Best-effort, capped, ephemeral."""
    blocks: list[dict] = []
    for att in (attachments or [])[:MAX_FILES]:
        name = ((getattr(att, "name", "") or "file").strip() or "file")[:255]
        mime = (getattr(att, "mime", "") or "").strip().lower()
        lname = name.lower()
        try:
            raw = base64.b64decode(getattr(att, "data", "") or "", validate=True)
        except (binascii.Error, ValueError):
            blocks.append({"type": "text", "text": f"[Attached {name}: could not be decoded; skipped]"})
            continue
        if not raw:
            continue
        if len(raw) > MAX_BYTES:
            blocks.append({"type": "text",
                           "text": f"[Attached {name}: too large ({len(raw) // 1024} KB); "
                                   f"skipped — max {MAX_BYTES // (1024 * 1024)} MB]"})
            continue
        try:
            if mime in _IMAGE_TYPES:
                media = "image/jpeg" if mime == "image/jpg" else mime
                blocks.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": media,
                               "data": base64.b64encode(raw).decode("ascii")},
                })
            elif mime in _PDF_TYPES or lname.endswith(".pdf"):
                text = _clip(_pdf_text(raw))
                blocks.append({"type": "text",
                               "text": f"[Attached PDF: {name}]\n"
                                       f"{text or '(no extractable text — may be a scanned image)'}"})
            elif mime in _XLSX_TYPES or lname.endswith((".xlsx", ".xlsm")):
                blocks.append({"type": "text",
                               "text": f"[Attached spreadsheet: {name}]\n{_clip(_xlsx_text(raw))}"})
            elif mime in _TEXT_TYPES or lname.endswith((".csv", ".txt")):
                blocks.append({"type": "text",
                               "text": f"[Attached file: {name}]\n{_clip(raw.decode('utf-8', errors='replace'))}"})
            else:
                blocks.append({"type": "text",
                               "text": f"[Attached {name}: unsupported type ({mime or 'unknown'}); skipped]"})
        except Exception:
            logger.exception("attachment parse failed for %s (%s)", name, mime)
            blocks.append({"type": "text", "text": f"[Attached {name}: couldn't be read; skipped]"})
    return blocks
