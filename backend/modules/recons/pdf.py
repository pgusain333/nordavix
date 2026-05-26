"""
Per-account reconciliation PDF.

One PDF per (account, period) — what an auditor would expect to see
in a reconciliation working-paper file:

  • Cover page         — entity, account, period, status (DRAFT
                         watermark if not yet approved).
  • Account info       — number, name, type, period end.
  • Reconciliation     — GL Balance → Subledger → Variance.
  • Subledger build-up — opening balance + every reconciling item
                         (date, type, ref, memo, amount) = closing.
  • Approval trail     — prepared by/at + approved by/at.
  • Notes              — preparer/reviewer free text.
  • Attachments        — list of evidence file names (PDFs, bank
                         statements, etc. — not the file bytes;
                         this is a reference list).

Same brand language as the Financial Package PDF (Helvetica + navy
accent), so a reconciliation file slotted next to the financials
PDF reads as one consistent package.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Any, BinaryIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# Brand palette — matches modules/financials/pdf.py so a Financial
# Package PDF and an account-reconciliation PDF live together as one
# visual family.
NAVY       = colors.HexColor("#1f3a5f")
GREY_DARK  = colors.HexColor("#374151")
GREY_MID   = colors.HexColor("#6b7280")
GREY_LIGHT = colors.HexColor("#d1d5db")
GREEN      = colors.HexColor("#3E8F66")
RED        = colors.HexColor("#b91c1c")
GREEN_TINT = colors.Color(0.243, 0.561, 0.4, alpha=0.08)
RED_TINT   = colors.Color(0.725, 0.114, 0.114, alpha=0.06)


# ── Styles ──────────────────────────────────────────────────────────────────

def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "cover_company": ParagraphStyle(
            "cover_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=32, leading=38, alignment=1, textColor=NAVY, spaceAfter=10,
        ),
        "cover_title": ParagraphStyle(
            "cover_title", parent=base["BodyText"], fontName="Helvetica",
            fontSize=18, leading=22, alignment=1, textColor=GREY_DARK, spaceAfter=6,
        ),
        "cover_account": ParagraphStyle(
            "cover_account", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=15, leading=18, alignment=1, textColor=NAVY, spaceAfter=2,
        ),
        "cover_period": ParagraphStyle(
            "cover_period", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=12, leading=15, alignment=1, textColor=GREY_DARK, spaceAfter=10,
        ),
        "cover_meta": ParagraphStyle(
            "cover_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=13, alignment=1, textColor=GREY_MID,
        ),
        "masthead_company": ParagraphStyle(
            "masthead_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=15, leading=18, alignment=1, textColor=NAVY, spaceAfter=2,
        ),
        "masthead_title": ParagraphStyle(
            "masthead_title", parent=base["BodyText"], fontName="Helvetica",
            fontSize=11, leading=14, alignment=1, textColor=GREY_DARK, spaceAfter=2,
        ),
        "masthead_subtitle": ParagraphStyle(
            "masthead_subtitle", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=10, leading=12, alignment=1, textColor=GREY_MID, spaceAfter=14,
        ),
        "section": ParagraphStyle(
            "section", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=10, leading=12, textColor=NAVY, spaceBefore=12, spaceAfter=4,
            # Tiny letter-spacing trick for uppercase section labels.
        ),
        "note_body": ParagraphStyle(
            "note_body", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=14, textColor=GREY_DARK, spaceBefore=4,
        ),
        "note_oblique": ParagraphStyle(
            "note_oblique", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=9, leading=12, textColor=GREY_MID, spaceBefore=4,
        ),
    }


# ── Number formatting ──────────────────────────────────────────────────────

def _fmt_money(v: Decimal | str | None, with_dollar: bool = True) -> str:
    """Accounting format: $1,234.56 / $(1,234.56) / em-dash for zero."""
    if v is None or v == "":
        return ""
    try:
        d = v if isinstance(v, Decimal) else Decimal(str(v))
    except Exception:
        return str(v)
    if d == 0:
        return "—"
    sign = -1 if d < 0 else 1
    abs_v = abs(d).quantize(Decimal("0.01"))
    n_str = f"{abs_v:,.2f}"
    if sign < 0:
        return f"$({n_str})" if with_dollar else f"({n_str})"
    return f"${n_str}" if with_dollar else n_str


def _fmt_date(d: date | str | None) -> str:
    if d is None or d == "":
        return ""
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d[:10])
        except Exception:
            return d
    return d.strftime("%b %d, %Y")


# ── Page templates ──────────────────────────────────────────────────────────

def _make_doc(
    buffer: BinaryIO,
    *,
    company: str,
    account_label: str,
    period_end: date,
    is_draft: bool,
) -> BaseDocTemplate:
    margin = 0.7 * inch
    page_w, page_h = LETTER

    body_frame = Frame(
        margin, margin, page_w - 2 * margin, page_h - 2 * margin - 0.4 * inch,
        id="body", topPadding=0, bottomPadding=0,
    )

    def on_page(canvas, doc) -> None:
        canvas.saveState()
        # DRAFT watermark on body pages only (cover already has its
        # own DRAFT label).
        if is_draft and doc.page > 1:
            canvas.setFont("Helvetica-Bold", 100)
            canvas.setFillColor(colors.Color(0.85, 0.85, 0.85, alpha=0.45))
            canvas.translate(page_w / 2, page_h / 2)
            canvas.rotate(45)
            canvas.drawCentredString(0, 0, "DRAFT")
            canvas.translate(-page_w / 2, -page_h / 2)
            canvas.rotate(-45)

        # Footer — company · account label · page X · timestamp
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GREY_MID)
        y = 0.4 * inch
        ts = datetime.now().strftime("%B %d, %Y")
        left = f"{company} · {account_label}"
        canvas.drawString(margin, y, left[:90])
        canvas.drawCentredString(page_w / 2, y, f"Page {canvas.getPageNumber()}")
        canvas.drawRightString(page_w - margin, y, f"Generated {ts}")
        # Thin top rule on body pages
        if doc.page > 1:
            canvas.setStrokeColor(GREY_LIGHT)
            canvas.setLineWidth(0.5)
            canvas.line(
                margin, page_h - margin + 0.18 * inch,
                page_w - margin, page_h - margin + 0.18 * inch,
            )
        canvas.restoreState()

    body_tpl = PageTemplate(id="body", frames=[body_frame], onPage=on_page)
    cover_frame = Frame(
        margin, margin + 1.5 * inch, page_w - 2 * margin, page_h - 2 * margin - 2 * inch,
        id="cover",
    )
    cover_tpl = PageTemplate(id="cover", frames=[cover_frame], onPage=on_page)

    doc = BaseDocTemplate(
        buffer, pagesize=LETTER, leftMargin=margin, rightMargin=margin,
        topMargin=margin, bottomMargin=margin,
        title=f"Account Reconciliation — {company} — {account_label} — {period_end.isoformat()}",
        author=company,
    )
    doc.addPageTemplates([cover_tpl, body_tpl])
    return doc


# ── Cover page ─────────────────────────────────────────────────────────────

def _cover(story: list, styles: dict, *, company: str, account_label: str,
            period_end: date, status: str, is_draft: bool, prepared_by: str) -> None:
    story.append(Spacer(1, 1.4 * inch))
    if is_draft:
        story.append(Paragraph(
            '<font color="#b91c1c"><b>— DRAFT —</b></font>', styles["cover_meta"],
        ))
        story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph(company, styles["cover_company"]))
    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph("Account Reconciliation", styles["cover_title"]))
    story.append(Paragraph(account_label, styles["cover_account"]))
    story.append(Paragraph(f"As of {_fmt_date(period_end)}", styles["cover_period"]))

    # Status chip
    if status == "approved":
        chip = '<font color="#3E8F66"><b>✓ Reconciled and Approved</b></font>'
    elif status == "reviewed":
        chip = '<font color="#1d4ed8"><b>● Prepared — pending review</b></font>'
    elif status == "flagged":
        chip = '<font color="#b91c1c"><b>⚠ Flagged for follow-up</b></font>'
    else:
        chip = '<font color="#6b7280"><b>○ Pending</b></font>'
    story.append(Paragraph(chip, styles["cover_meta"]))

    story.append(Spacer(1, 1.4 * inch))
    if prepared_by:
        story.append(Paragraph(f"Prepared by {prepared_by}", styles["cover_meta"]))
    story.append(Paragraph(f"Generated {datetime.now().strftime('%B %d, %Y')}",
                            styles["cover_meta"]))
    story.append(Spacer(1, 0.05 * inch))
    story.append(Paragraph("Nordavix · Reconciliation Package", styles["cover_meta"]))


# ── Body sections ──────────────────────────────────────────────────────────

def _kv_table(rows: list[tuple[str, str]], *, label_width: float = 1.7 * inch) -> Table:
    """2-column key/value table. Used for the Account Info + Approval Trail
    sections."""
    tbl = Table(rows, colWidths=[label_width, 7.1 * inch - label_width - 2 * 0.7 * inch])
    tbl.setStyle(TableStyle([
        ("FONT",          (0, 0), (-1, -1), "Helvetica", 10),
        ("TEXTCOLOR",     (0, 0), (0, -1), GREY_MID),
        ("TEXTCOLOR",     (1, 0), (1, -1), GREY_DARK),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING",    (0, 0), (-1, -1), 2),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
    ]))
    return tbl


def _reconciliation_summary(data: dict) -> Table:
    """The three-line GL / Subledger / Variance table — the headline."""
    gl  = Decimal(data["gl_balance"])
    sub = Decimal(data["subledger_balance"])
    var = gl - sub
    tied_out = abs(var) < Decimal("1.00")

    rows = [
        ["", "Amount"],
        ["General Ledger Balance",    _fmt_money(gl)],
        ["Subledger / Reconciled Balance", _fmt_money(sub)],
        ["Variance (GL − Subledger)", _fmt_money(var)],
    ]
    tbl = Table(rows, colWidths=[4.3 * inch, 2.3 * inch], hAlign="LEFT")
    tbl.setStyle(TableStyle([
        # Header
        ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("TEXTCOLOR",     (0, 0), (-1, 0), NAVY),
        ("ALIGN",         (1, 0), (-1, 0), "RIGHT"),
        ("LINEBELOW",     (0, 0), (-1, 0), 0.75, NAVY),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        # Body
        ("FONT",          (0, 1), (-1, -1), "Helvetica", 10),
        ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
        ("ALIGN",         (1, 1), (-1, -1), "RIGHT"),
        ("TOPPADDING",    (0, 1), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        # Variance row emphasis
        ("FONT",          (0, 3), (-1, 3), "Helvetica-Bold", 11),
        ("LINEABOVE",     (0, 3), (-1, 3), 0.5, NAVY),
        ("BACKGROUND",    (0, 3), (-1, 3), GREEN_TINT if tied_out else RED_TINT),
        ("TEXTCOLOR",     (1, 3), (-1, 3), GREEN if tied_out else RED),
        ("TOPPADDING",    (0, 3), (-1, 3), 7),
        ("BOTTOMPADDING", (0, 3), (-1, 3), 7),
    ]))
    return tbl


def _buildup_table(data: dict) -> Table:
    """Subledger build-up: opening balance + each reconciling item = closing.

    Sign on each item follows the account's natural side: credit-natural
    accounts (AP, Credit Card, liabilities, equity) flip the QBO-returned
    amount; manual items are entered signed by the user and are NOT flipped.
    Same logic the inline UI uses.
    """
    flip = -1 if data.get("is_credit_natural") else 1
    opening = Decimal(data["opening_balance"])
    items = data.get("reconciling_items") or []

    header = ["Date", "Type", "Ref #", "Memo / Description", "Amount"]
    rows: list[list[Any]] = [header]
    # Opening row
    opening_label = data.get("opening_source") or "Opening Balance"
    rows.append(["", "", "", opening_label, _fmt_money(opening)])

    items_sum = Decimal("0")
    for it in items:
        is_manual = str(it.get("txn_id", "")).startswith("manual-")
        raw_amt = Decimal(str(it.get("amount", "0") or "0"))
        signed = raw_amt if is_manual else (flip * raw_amt)
        items_sum += signed
        rows.append([
            _fmt_date(it.get("txn_date") or ""),
            (it.get("txn_type") or "")[:18] + (" · Manual" if is_manual else ""),
            (it.get("txn_number") or "")[:14],
            (it.get("memo") or "")[:60],
            _fmt_money(signed),
        ])

    closing = opening + items_sum
    rows.append([
        "", "", "", "Closing Subledger Balance", _fmt_money(closing),
    ])

    tbl = Table(
        rows,
        colWidths=[0.85 * inch, 1.15 * inch, 0.9 * inch, 3.0 * inch, 1.2 * inch],
        repeatRows=1,
    )
    style = [
        # Header
        ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("TEXTCOLOR",     (0, 0), (-1, 0), NAVY),
        ("ALIGN",         (-1, 0), (-1, 0), "RIGHT"),
        ("LINEBELOW",     (0, 0), (-1, 0), 0.75, NAVY),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        # Body
        ("FONT",          (0, 1), (-1, -1), "Helvetica", 9),
        ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
        ("ALIGN",         (-1, 1), (-1, -1), "RIGHT"),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
        ("TOPPADDING",    (0, 1), (-1, -1), 3),
        # Opening row gets a subtle grey background
        ("BACKGROUND",    (0, 1), (-1, 1), colors.Color(0.95, 0.95, 0.95)),
        ("FONT",          (0, 1), (-1, 1), "Helvetica-Bold", 9),
        # Closing row
        ("FONT",          (0, -1), (-1, -1), "Helvetica-Bold", 10),
        ("LINEABOVE",     (0, -1), (-1, -1), 0.75, NAVY),
        ("TOPPADDING",    (0, -1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 6),
        ("BACKGROUND",    (0, -1), (-1, -1), GREEN_TINT),
        ("TEXTCOLOR",     (-1, -1), (-1, -1), GREEN),
    ]
    # Color negative amounts red on item rows
    for idx in range(2, len(rows) - 1):
        cell = rows[idx][-1]
        if cell and cell.startswith("$("):
            style.append(("TEXTCOLOR", (-1, idx), (-1, idx), RED))
    tbl.setStyle(TableStyle(style))
    return tbl


def _approval_trail(data: dict) -> Table:
    rows: list[tuple[str, str]] = []
    if data.get("prepared_by_name"):
        when = _fmt_date(data.get("prepared_at"))
        rows.append((
            "Prepared by",
            f"{data['prepared_by_name']}" + (f" · {when}" if when else ""),
        ))
    if data.get("approved_by_name"):
        when = _fmt_date(data.get("approved_at"))
        rows.append((
            "Approved by",
            f"{data['approved_by_name']}" + (f" · {when}" if when else ""),
        ))
    if not rows:
        rows.append(("Status", "Not yet prepared or approved"))
    return _kv_table(rows)


def _attachments(data: dict, styles: dict) -> list[Any]:
    files = data.get("evidence_files") or []
    if not files:
        return [Paragraph(
            "No supporting attachments uploaded for this period.",
            styles["note_oblique"],
        )]
    bullets: list[Any] = []
    for f in files:
        name = f.get("file_name") or "(unnamed file)"
        when = _fmt_date(f.get("uploaded_at"))
        bullets.append(Paragraph(
            f"• <b>{name}</b>" + (f" <font color='#6b7280'>· uploaded {when}</font>" if when else ""),
            styles["note_body"],
        ))
    return bullets


# ── Public entry point ─────────────────────────────────────────────────────

def build_account_pdf(buffer: BinaryIO, *, data: dict) -> None:
    """
    Build the per-account reconciliation PDF.

    `data` schema (built by the router):
      company:             str
      account_number:      str
      account_name:        str
      account_type:        str
      period_end:          date
      status:              str               # 'approved' | 'reviewed' | 'flagged' | 'pending'
      gl_balance:          str (Decimal)
      subledger_balance:   str (Decimal)
      opening_balance:     str (Decimal)
      opening_source:      str | None
      is_credit_natural:   bool
      reconciling_items:   list[dict]        # JSONB shape from AccountReviewStatus
      notes:               str | None
      prepared_by_name:    str | None
      prepared_at:         str | None        # ISO
      approved_by_name:    str | None
      approved_at:         str | None        # ISO
      evidence_files:      list[dict]        # { file_name, uploaded_at }
      is_draft:            bool              # not yet approved
      prepared_by:         str               # generator's user email
    """
    is_draft = data.get("is_draft", False)
    company = data["company"]
    pe = data["period_end"]
    if not isinstance(pe, date):
        pe = date.fromisoformat(str(pe))

    account_label = (
        f"{data['account_number']} · {data['account_name']}"
        if data.get("account_number")
        else data["account_name"]
    )

    styles = _styles()
    doc = _make_doc(
        buffer,
        company=company,
        account_label=account_label,
        period_end=pe,
        is_draft=is_draft,
    )
    story: list[Any] = []

    # ── Cover ────────────────────────────────────────────────────────────
    _cover(
        story, styles,
        company=company,
        account_label=account_label,
        period_end=pe,
        status=data.get("status", "pending"),
        is_draft=is_draft,
        prepared_by=data.get("prepared_by", ""),
    )

    # ── Body page ────────────────────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph(company, styles["masthead_company"]))
    story.append(Paragraph("Account Reconciliation", styles["masthead_title"]))
    story.append(Paragraph(
        f"{account_label} · {_fmt_date(pe)}",
        styles["masthead_subtitle"],
    ))

    # 1. Account info
    story.append(Paragraph("Account Information", styles["section"]))
    story.append(_kv_table([
        ("Account",        account_label),
        ("Account Type",   data.get("account_type", "—")),
        ("Period End",     _fmt_date(pe)),
        ("Status",         data.get("status", "pending").replace("_", " ").title()),
    ]))

    # 2. Reconciliation summary
    story.append(Paragraph("Reconciliation Summary", styles["section"]))
    story.append(_reconciliation_summary(data))

    # 3. Subledger build-up
    items = data.get("reconciling_items") or []
    story.append(Paragraph(
        f"Subledger Build-up ({len(items)} reconciling item{'' if len(items) == 1 else 's'})",
        styles["section"],
    ))
    story.append(_buildup_table(data))

    # 4. Approval trail
    story.append(Paragraph("Approval Trail", styles["section"]))
    story.append(_approval_trail(data))

    # 5. Notes
    notes = (data.get("notes") or "").strip()
    if notes:
        story.append(Paragraph("Notes", styles["section"]))
        story.append(Paragraph(notes, styles["note_body"]))

    # 6. Attachments list
    story.append(Paragraph("Supporting Attachments", styles["section"]))
    story.extend(_attachments(data, styles))

    doc.build(story)
