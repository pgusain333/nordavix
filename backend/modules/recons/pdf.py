"""
Per-account reconciliation PDF.

Single working paper for one (account, period). Monochrome by design — no
color anywhere (fonts, rules, fills are black / white / grey only) so it
prints cleanly, photocopies, and reads as a formal audit document. Hierarchy
comes from weight, size, rules, and boxes rather than colour.

  +-------------------------------------------------------------------+
  |  COMPANY                                ACCOUNT RECONCILIATION     |
  |  reconciliation working paper                     Working Paper    |
  |  =============================================================== = |
  |  1010 - Cash - Operating                                          |
  |  Bank - Period ending Apr 30, 2026 - Reconciled & Approved        |
  |                                                                   |
  |  +---------------+   +---------------+   +---------------+        |
  |  | GENERAL LEDGER|   |  SUBLEDGER    |   |   VARIANCE    |        |
  |  |  $125,400.00  |   |  $125,400.00  |   |    $0.00      |        |
  |  | Per QuickBooks|   | Supporting... |   |  IN BALANCE   |        |
  |  +---------------+   +---------------+   +---------------+        |
  |                                                                   |
  |  ACCOUNT INFORMATION    [grid]                                    |
  |  RECONCILIATION BUILD-UP  opening + items = closing -> GL -> var  |
  |  AI COMMENTARY (opt) / NOTES (opt) / SUPPORTING ATTACHMENTS       |
  +-------------------------------------------------------------------+

Long reconciling-item lists spill onto page 2/3 with the header row
repeating. A faint DRAFT watermark is applied until the account is approved.

WinAnsi-safe glyphs only: ReportLab's base-14 Helvetica can't render
check-marks or the U+2212 minus sign (they'd show as blank boxes), so the
document uses plain text + en-dashes throughout.
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
    Flowable,
    Frame,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# Monochrome palette — black / white / greys only. No colour anywhere.
INK        = colors.HexColor("#111827")   # near-black: headings, emphasis, big numbers
GREY_DARK  = colors.HexColor("#374151")   # body text
GREY_MID   = colors.HexColor("#6b7280")   # secondary text, labels, captions
GREY_LIGHT = colors.HexColor("#c8ccd2")   # hairlines, light rules
GREY_BG    = colors.Color(0.965, 0.965, 0.965)   # light card / row fill
GREY_BG2   = colors.Color(0.915, 0.915, 0.915)   # medium fill (emphasis rows / boxes)
WHITE      = colors.white


# ── Styles ──────────────────────────────────────────────────────────────────

def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "letterhead_company": ParagraphStyle(
            "letterhead_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=22, leading=26, textColor=INK, spaceAfter=2,
        ),
        "letterhead_kicker": ParagraphStyle(
            "letterhead_kicker", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=8, leading=10, textColor=GREY_MID, spaceAfter=6,
        ),
        "letterhead_title": ParagraphStyle(
            "letterhead_title", parent=base["BodyText"], fontName="Helvetica",
            fontSize=14, leading=17, textColor=GREY_DARK, spaceAfter=2,
        ),
        "letterhead_meta": ParagraphStyle(
            "letterhead_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=13, textColor=GREY_MID,
        ),
        # Big account identifier that sits above the balance boxes.
        "account_title": ParagraphStyle(
            "account_title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=15, leading=18, textColor=INK, spaceBefore=2, spaceAfter=2,
        ),
        "account_meta": ParagraphStyle(
            "account_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=9.5, leading=12, textColor=GREY_MID,
        ),
        "section": ParagraphStyle(
            "section", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=9, leading=11, textColor=INK,
            spaceBefore=15, spaceAfter=5,
        ),
        "note_body": ParagraphStyle(
            "note_body", parent=base["BodyText"], fontName="Helvetica",
            fontSize=9.5, leading=13, textColor=GREY_DARK, spaceBefore=4,
        ),
        "note_oblique": ParagraphStyle(
            "note_oblique", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=9, leading=12, textColor=GREY_MID, spaceBefore=4,
        ),
    }


# ── Number / date formatting ───────────────────────────────────────────────

def _fmt_money(v: Decimal | str | None, with_dollar: bool = True) -> str:
    """Accounting format: $1,234.56 / $(1,234.56) / em-dash for zero."""
    if v is None or v == "":
        return ""
    try:
        d = v if isinstance(v, Decimal) else Decimal(str(v))
    except Exception:
        return str(v)
    if d == 0:
        return "$0.00" if with_dollar else "—"
    sign = -1 if d < 0 else 1
    abs_v = abs(d).quantize(Decimal("0.01"))
    n_str = f"{abs_v:,.2f}"
    if sign < 0:
        return f"$({n_str})" if with_dollar else f"({n_str})"
    return f"${n_str}" if with_dollar else n_str


def _to_decimal(v: Any, default: str = "0") -> Decimal:
    try:
        return v if isinstance(v, Decimal) else Decimal(str(v if v not in (None, "") else default))
    except Exception:
        return Decimal(default)


def _fmt_date(d: date | str | None) -> str:
    if d is None or d == "":
        return ""
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d[:10])
        except Exception:
            return d
    return d.strftime("%b %d, %Y")


_STATUS_DISPLAY = {
    "approved": "Reconciled & Approved",
    "reviewed": "Prepared - Pending Review",
    "flagged":  "Flagged for Follow-up",
    "pending":  "Open",
}


# ── Small helper flowables ─────────────────────────────────────────────────


class _Hairline(Flowable):
    """A horizontal rule that spans the full body frame width."""
    def __init__(self, color: colors.Color, width_pts: float = 1.0):
        super().__init__()
        self.line_color = color
        self.line_width = width_pts
        self.width: float = 0
        self.height: float = self.line_width

    def wrap(self, avail_w: float, avail_h: float) -> tuple[float, float]:
        self.width = avail_w
        return (self.width, self.height)

    def draw(self) -> None:
        self.canv.setStrokeColor(self.line_color)
        self.canv.setLineWidth(self.line_width)
        self.canv.line(0, 0, self.width, 0)


def _hairline(color: colors.Color, width_pts: float = 1.0) -> _Hairline:
    return _Hairline(color, width_pts)


# ── Page template ──────────────────────────────────────────────────────────

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
        # DRAFT watermark — light grey, monochrome.
        if is_draft:
            canvas.setFont("Helvetica-Bold", 100)
            canvas.setFillColor(colors.Color(0.85, 0.85, 0.85, alpha=0.45))
            canvas.translate(page_w / 2, page_h / 2)
            canvas.rotate(45)
            canvas.drawCentredString(0, 0, "DRAFT")
            canvas.translate(-page_w / 2, -page_h / 2)
            canvas.rotate(-45)

        # Footer — company - account label - page X - timestamp
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GREY_MID)
        y = 0.4 * inch
        ts = datetime.now().strftime("%B %d, %Y")
        left = f"{company} · {account_label}"
        canvas.drawString(margin, y, left[:90])
        canvas.drawCentredString(page_w / 2, y, f"Page {canvas.getPageNumber()}")
        canvas.drawRightString(page_w - margin, y, f"Generated {ts}")
        # Thin rule above the footer.
        canvas.setStrokeColor(GREY_LIGHT)
        canvas.setLineWidth(0.5)
        canvas.line(margin, y + 12, page_w - margin, y + 12)
        canvas.restoreState()

    body_tpl = PageTemplate(id="body", frames=[body_frame], onPage=on_page)
    doc = BaseDocTemplate(
        buffer, pagesize=LETTER, leftMargin=margin, rightMargin=margin,
        topMargin=margin, bottomMargin=margin,
        title=f"Account Reconciliation - {company} - {account_label} - {period_end.isoformat()}",
        author=company,
    )
    doc.addPageTemplates([body_tpl])
    return doc


# ── Headline balance boxes (GL / Subledger / Variance) ─────────────────────

def _kpi_boxes(data: dict) -> Table:
    """Three prominent boxes across the top of the working paper: the General
    Ledger balance, the Subledger balance, and the Variance between them. This
    is the headline answer — "does it tie?" — readable at a glance.

    Monochrome: identical light boxes with black borders + big black numbers.
    When out of balance, the Variance box gets a heavier border and a darker
    fill so the eye lands on it without any colour.
    """
    gl = _to_decimal(data.get("gl_balance"))
    sl = _to_decimal(data.get("subledger_balance"))
    variance = gl - sl
    tied = abs(variance) < Decimal("1.00")
    variance_value = Decimal("0") if tied else variance
    status_text = "IN BALANCE" if tied else "OUT OF BALANCE"

    label_style = ParagraphStyle(
        "kpi_label", fontName="Helvetica-Bold", fontSize=7.5, leading=10,
        textColor=GREY_MID, alignment=1,  # centered
    )
    num_style = ParagraphStyle(
        "kpi_num", fontName="Helvetica-Bold", fontSize=16, leading=19,
        textColor=INK, alignment=1,
    )
    sub_style = ParagraphStyle(
        "kpi_sub", fontName="Helvetica", fontSize=7, leading=9,
        textColor=GREY_MID, alignment=1,
    )
    status_style = ParagraphStyle(
        "kpi_status", fontName="Helvetica-Bold", fontSize=8, leading=10,
        textColor=INK, alignment=1,
    )

    # 5 columns: box / gap / box / gap / box
    gap = 0.16 * inch
    body_w = LETTER[0] - 2 * (0.7 * inch)
    box_w = (body_w - 2 * gap) / 3.0

    rows = [
        [Paragraph("GENERAL LEDGER", label_style), "",
         Paragraph("SUBLEDGER", label_style), "",
         Paragraph("VARIANCE (GL - SL)", label_style)],
        [Paragraph(_fmt_money(gl), num_style), "",
         Paragraph(_fmt_money(sl), num_style), "",
         Paragraph(_fmt_money(variance_value), num_style)],
        [Paragraph("Balance per general ledger", sub_style), "",
         Paragraph("Supporting subledger detail", sub_style), "",
         Paragraph(status_text, status_style)],
    ]
    tbl = Table(rows, colWidths=[box_w, gap, box_w, gap, box_w])

    box_cols = (0, 2, 4)
    style: list[tuple] = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        # vertical rhythm inside the boxes
        ("TOPPADDING",    (0, 0), (-1, 0), 11),   # space above labels
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING",    (0, 1), (-1, 1), 0),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 5),    # below big number
        ("TOPPADDING",    (0, 2), (-1, 2), 0),
        ("BOTTOMPADDING", (0, 2), (-1, 2), 11),   # space below sub
    ]
    for c in box_cols:
        emphasize = (c == 4 and not tied)
        style.append(("BACKGROUND", (c, 0), (c, -1), GREY_BG2 if emphasize else GREY_BG))
        style.append(("BOX", (c, 0), (c, -1), 1.5 if emphasize else 0.75, INK))
        style.append(("LEFTPADDING",  (c, 0), (c, -1), 8))
        style.append(("RIGHTPADDING", (c, 0), (c, -1), 8))
    # gap columns: no fill, no border, no padding
    for g in (1, 3):
        style.append(("LEFTPADDING",  (g, 0), (g, -1), 0))
        style.append(("RIGHTPADDING", (g, 0), (g, -1), 0))
    tbl.setStyle(TableStyle(style))
    return tbl


# ── Account Information (tabular) ──────────────────────────────────────────

def _account_info_table(data: dict, account_label: str) -> Table:
    """Account Information block — 4-column grid: label | value | label | value."""
    pe = data["period_end"]
    if not isinstance(pe, date):
        pe = date.fromisoformat(str(pe))

    status_raw = data.get("status", "pending")
    status_display = _STATUS_DISPLAY.get(status_raw, status_raw.replace("_", " ").title())

    def actor_line(name: str | None, when: str | None) -> str:
        if not name:
            return "—"
        if when:
            return f"{name}\n{_fmt_date(when)}"
        return name

    acct_num = data.get("account_number") or "—"
    acct_name = data.get("account_name") or "—"

    rows: list[list[Any]] = [
        ["Account No.",   acct_num,                        "Status",     status_display],
        ["Account Name",  acct_name,                       "Period End", _fmt_date(pe)],
        ["Account Type",  data.get("account_type") or "—", "Currency", "USD"],
        ["Prepared By",   actor_line(data.get("prepared_by_name"), data.get("prepared_at")),
         "Approved By",   actor_line(data.get("approved_by_name"), data.get("approved_at"))],
    ]
    tbl = Table(
        rows,
        colWidths=[1.05 * inch, 2.45 * inch, 1.05 * inch, 2.55 * inch],
    )
    style: list[tuple] = [
        # Labels (cols 0 + 2)
        ("FONT",          (0, 0), (0, -1), "Helvetica-Bold", 7.5),
        ("FONT",          (2, 0), (2, -1), "Helvetica-Bold", 7.5),
        ("TEXTCOLOR",     (0, 0), (0, -1), GREY_MID),
        ("TEXTCOLOR",     (2, 0), (2, -1), GREY_MID),
        # Values (cols 1 + 3)
        ("FONT",          (1, 0), (1, -1), "Helvetica", 9.5),
        ("FONT",          (3, 0), (3, -1), "Helvetica", 9.5),
        ("TEXTCOLOR",     (1, 0), (1, -1), GREY_DARK),
        ("TEXTCOLOR",     (3, 0), (3, -1), GREY_DARK),
        # Layout
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING",    (0, 0), (-1, -1), 7),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        # Light dividing rule between rows
        ("LINEBELOW",     (0, 0), (-1, -2), 0.25, GREY_LIGHT),
        # Black top + bottom rule frames the block
        ("LINEABOVE",     (0, 0), (-1, 0), 1.0, INK),
        ("LINEBELOW",     (0, -1), (-1, -1), 0.75, INK),
        # Subtle grey fill on the label/value pairs
        ("BACKGROUND",    (0, 0), (1, -1), colors.Color(0.985, 0.985, 0.985)),
        ("BACKGROUND",    (2, 0), (3, -1), colors.Color(0.97, 0.97, 0.97)),
    ]
    # Account Name is the most-identifying field — bump it.
    style.append(("FONT", (1, 1), (1, 1), "Helvetica-Bold", 10))
    style.append(("TEXTCOLOR", (1, 1), (1, 1), INK))
    tbl.setStyle(TableStyle(style))
    return tbl


# ── Reconciliation Build-up (opening + items = closing -> GL -> variance) ──

def _reconciliation_table(data: dict) -> Table:
    """The whole reconciliation in one table:

        Opening Subledger Balance (Rolled Forward)   $opening
      + Reconciling item 1                           $+/-
      ...
      = Closing Subledger Balance                    $closing
        General Ledger Balance                       $gl
        Variance (GL - Subledger)                    $0.00

    Sign on each reconciling item follows the account's natural side:
    credit-natural accounts flip the QBO amount; manual items are entered
    signed and are NOT flipped.
    """
    flip = -1 if data.get("is_credit_natural") else 1
    opening = _to_decimal(data.get("opening_balance"))
    items = data.get("reconciling_items") or []
    gl_balance = _to_decimal(data.get("gl_balance"))
    saved_subledger = _to_decimal(data.get("subledger_balance"))

    header = ["Date", "Type", "Ref #", "Memo / Description", "Amount"]
    rows: list[list[Any]] = [header]

    memo_style = ParagraphStyle(
        "recon_memo", fontName="Helvetica", fontSize=9, leading=11, textColor=GREY_DARK,
    )
    memo_bold = ParagraphStyle(
        "recon_memo_bold", fontName="Helvetica-Bold", fontSize=9.5, leading=12, textColor=GREY_DARK,
    )
    memo_total = ParagraphStyle(
        "recon_memo_total", fontName="Helvetica-Bold", fontSize=10, leading=12.5, textColor=INK,
    )

    # 1. Opening
    opening_subnote = (data.get("opening_source") or "").strip()
    opening_label_html = "Opening Subledger Balance"
    if opening_subnote:
        opening_label_html += (
            f"<br/><font size='8' color='{GREY_MID.hexval()}'>{opening_subnote}</font>"
        )
    rows.append(["", "", "", Paragraph(opening_label_html, memo_bold), _fmt_money(opening)])
    opening_row_idx = len(rows) - 1

    # 2. Reconciling items
    items_sum = Decimal("0")
    items_start_idx = len(rows)
    for it in items:
        is_manual = str(it.get("txn_id", "")).startswith("manual-")
        raw_amt = _to_decimal(it.get("amount"))
        signed = raw_amt if is_manual else (flip * raw_amt)
        items_sum += signed
        memo_text = (it.get("memo") or "")[:200]
        if is_manual and "Manual" not in (it.get("txn_type") or ""):
            type_label = ((it.get("txn_type") or "Manual")[:18]) + " · Manual"
        else:
            type_label = (it.get("txn_type") or "")[:24]
        rows.append([
            _fmt_date(it.get("txn_date") or ""),
            type_label,
            (it.get("txn_number") or "")[:14],
            Paragraph(memo_text, memo_style) if memo_text else "",
            _fmt_money(signed),
        ])
    items_end_idx = len(rows) - 1

    # 3a. Reconcile opening + items to the SAVED subledger via an explicit
    # "Other adjustments" row when they differ.
    computed_from_items = opening + items_sum
    adjustment = saved_subledger - computed_from_items
    adjustment_row_idx: int | None = None
    if abs(adjustment) >= Decimal("0.01"):
        rows.append([
            "", "", "",
            Paragraph(
                "Other adjustments to subledger"
                "<br/><font size='8' color='" + GREY_MID.hexval() + "'>"
                "Difference between rolled-forward opening + items and the "
                "recorded subledger balance - typically AR/AP aging, "
                "AI-prepared closing, or a manual override."
                "</font>",
                memo_bold,
            ),
            _fmt_money(adjustment),
        ])
        adjustment_row_idx = len(rows) - 1

    # 3b. Closing Subledger Balance — the SAVED value.
    rows.append(["", "", "", Paragraph("Closing Subledger Balance", memo_total), _fmt_money(saved_subledger)])
    closing_row_idx = len(rows) - 1

    # 4. GL Balance
    rows.append(["", "", "", Paragraph("General Ledger Balance", memo_total), _fmt_money(gl_balance)])
    gl_row_idx = len(rows) - 1

    # 5. Variance — should be $0.00 on a reconciled account.
    variance = gl_balance - saved_subledger
    tied_out = abs(variance) < Decimal("1.00")
    variance_display = _fmt_money(Decimal("0")) if tied_out else _fmt_money(variance)
    status_word = "IN BALANCE" if tied_out else "OUT OF BALANCE"
    rows.append([
        "", "", "",
        Paragraph(
            f"Variance (GL - Subledger)"
            f"<br/><font size='7.5' color='{GREY_MID.hexval()}'>{status_word}</font>",
            memo_total,
        ),
        variance_display,
    ])
    var_row_idx = len(rows) - 1

    tbl = Table(
        rows,
        colWidths=[0.85 * inch, 1.15 * inch, 0.75 * inch, 3.15 * inch, 1.20 * inch],
        repeatRows=1,
    )

    style: list[tuple] = [
        # Header — black band on top, white text.
        ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
        ("TEXTCOLOR",     (0, 0), (-1, 0), WHITE),
        ("BACKGROUND",    (0, 0), (-1, 0), INK),
        ("ALIGN",         (-1, 0), (-1, 0), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 7),
        ("TOPPADDING",    (0, 0), (-1, 0), 7),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        # Body defaults
        ("FONT",          (0, 1), (-1, -1), "Helvetica", 9),
        ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
        ("ALIGN",         (-1, 1), (-1, -1), "RIGHT"),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
        ("TOPPADDING",    (0, 1), (-1, -1), 5),
        # Opening — bold + light fill
        ("FONT",          (0, opening_row_idx), (-1, opening_row_idx), "Helvetica-Bold", 9.5),
        ("BACKGROUND",    (0, opening_row_idx), (-1, opening_row_idx), GREY_BG),
        ("TOPPADDING",    (0, opening_row_idx), (-1, opening_row_idx), 8),
        ("BOTTOMPADDING", (0, opening_row_idx), (-1, opening_row_idx), 8),
        ("LINEBELOW",     (0, opening_row_idx), (-1, opening_row_idx), 0.5, GREY_LIGHT),
        # Closing — bold + heavy rule above
        ("FONT",          (0, closing_row_idx), (-1, closing_row_idx), "Helvetica-Bold", 10),
        ("LINEABOVE",     (0, closing_row_idx), (-1, closing_row_idx), 1.0, GREY_DARK),
        ("TOPPADDING",    (0, closing_row_idx), (-1, closing_row_idx), 7),
        ("BOTTOMPADDING", (0, closing_row_idx), (-1, closing_row_idx), 5),
        ("BACKGROUND",    (0, closing_row_idx), (-1, closing_row_idx), GREY_BG),
        # GL Balance — bold (target value)
        ("FONT",          (0, gl_row_idx), (-1, gl_row_idx), "Helvetica-Bold", 10),
        ("TOPPADDING",    (0, gl_row_idx), (-1, gl_row_idx), 5),
        ("BOTTOMPADDING", (0, gl_row_idx), (-1, gl_row_idx), 5),
        ("BACKGROUND",    (0, gl_row_idx), (-1, gl_row_idx), GREY_BG),
        # Variance — heaviest weight, double rule, medium fill.
        ("FONT",          (0, var_row_idx), (-1, var_row_idx), "Helvetica-Bold", 11),
        ("TEXTCOLOR",     (0, var_row_idx), (-1, var_row_idx), INK),
        ("LINEABOVE",     (0, var_row_idx), (-1, var_row_idx), 0.75, INK),
        ("LINEBELOW",     (0, var_row_idx), (-1, var_row_idx), 2.0, INK),
        ("BACKGROUND",    (0, var_row_idx), (-1, var_row_idx), GREY_BG2),
        ("TOPPADDING",    (0, var_row_idx), (-1, var_row_idx), 10),
        ("BOTTOMPADDING", (0, var_row_idx), (-1, var_row_idx), 10),
        # Outer frame around the whole build-up.
        ("BOX",           (0, 0), (-1, -1), 0.75, GREY_DARK),
    ]
    # Per-item zebra striping (negatives already show as accounting parentheses).
    for n, idx in enumerate(range(items_start_idx, items_end_idx + 1)):
        if n % 2 == 1:
            style.append(("BACKGROUND", (0, idx), (-1, idx), colors.Color(0.975, 0.975, 0.975)))
    # "Other adjustments" row (when present)
    if adjustment_row_idx is not None:
        style.append(("BACKGROUND", (0, adjustment_row_idx), (-1, adjustment_row_idx), colors.Color(0.955, 0.955, 0.955)))
        style.append(("LINEABOVE",  (0, adjustment_row_idx), (-1, adjustment_row_idx), 0.5, GREY_LIGHT))
        style.append(("TOPPADDING", (0, adjustment_row_idx), (-1, adjustment_row_idx), 7))
        style.append(("BOTTOMPADDING", (0, adjustment_row_idx), (-1, adjustment_row_idx), 7))
    tbl.setStyle(TableStyle(style))
    return tbl


# ── AI Commentary ──────────────────────────────────────────────────────────


def _ai_commentary_table(commentary: dict, styles: dict) -> list[Any]:
    """AI commentary block: confidence / recommendation header, narrative, and
    a checks table. Monochrome — status shown as PASS / WARN / FAIL text."""
    out: list[Any] = []
    conf = (commentary.get("confidence") or "").lower()
    rec = (commentary.get("recommendation") or "").lower()
    narrative = (commentary.get("narrative") or "").strip()
    checks = commentary.get("checks") or []

    rec_label = {
        "approve": "Approve as-is",
        "review": "Review flagged items",
        "investigate": "Investigate before approving",
    }.get(rec, rec.title())
    pill_row = [[
        Paragraph(f"<b>Confidence:</b> {conf.title() or '—'}", styles["note_body"]),
        Paragraph(f"<b>AI Recommendation:</b> {rec_label or '—'}", styles["note_body"]),
    ]]
    pill_tbl = Table(pill_row, colWidths=[3.55 * inch, 3.55 * inch])
    pill_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), GREY_BG),
        ("BOX",           (0, 0), (-1, -1), 0.5, GREY_LIGHT),
        ("TEXTCOLOR",     (0, 0), (-1, -1), GREY_DARK),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    out.append(pill_tbl)

    if narrative:
        out.append(Paragraph(narrative, styles["note_body"]))

    if checks:
        header = ["Check", "Status", "Detail"]
        rows: list[list[Any]] = [header]
        for c in checks:
            status_raw = (c.get("status") or "pass").lower()
            status_label = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}.get(status_raw, status_raw.upper())
            rows.append([
                c.get("name") or "—",
                status_label,
                Paragraph(c.get("detail") or "—", styles["note_body"]),
            ])
        tbl = Table(rows, colWidths=[1.8 * inch, 0.85 * inch, 4.45 * inch], repeatRows=1)
        style: list[tuple] = [
            ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 9),
            ("TEXTCOLOR",     (0, 0), (-1, 0), WHITE),
            ("BACKGROUND",    (0, 0), (-1, 0), INK),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("TOPPADDING",    (0, 0), (-1, 0), 5),
            ("FONT",          (0, 1), (-1, -1), "Helvetica", 9),
            ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING",    (0, 1), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 6),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
            ("LINEBELOW",     (0, 1), (-1, -2), 0.25, GREY_LIGHT),
            ("BOX",           (0, 0), (-1, -1), 0.5, GREY_DARK),
        ]
        # Status column bold for all rows (PASS/WARN/FAIL).
        style.append(("FONT", (1, 1), (1, -1), "Helvetica-Bold", 9))
        tbl.setStyle(TableStyle(style))
        out.append(tbl)
    return out


# ── Attachments list ───────────────────────────────────────────────────────

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
            f"• <b>{name}</b>"
            + (f" <font color='#6b7280'>· uploaded {when}</font>" if when else ""),
            styles["note_body"],
        ))
    return bullets


# ── Public entry point ─────────────────────────────────────────────────────

def build_account_pdf(buffer: BinaryIO, *, data: dict) -> None:
    """
    Build the per-account reconciliation PDF.

    `data` schema (built by the router):
      company, account_number, account_name, account_type, period_end, status,
      gl_balance, subledger_balance, opening_balance, opening_source,
      is_credit_natural, reconciling_items, notes, prepared_by_name/at,
      approved_by_name/at, evidence_files, is_draft, prepared_by, ai_commentary
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
        buffer, company=company, account_label=account_label,
        period_end=pe, is_draft=is_draft,
    )
    story: list[Any] = []

    # ── Letterhead — company (left) + document title / period (right) ──
    period_label_lines = (
        f'<font color="{GREY_MID.hexval()}">PERIOD ENDING</font><br/>'
        f'<font color="{INK.hexval()}"><b>{_fmt_date(pe).upper()}</b></font>'
    )
    title_lines = (
        f'<font color="{GREY_MID.hexval()}"><b>ACCOUNT RECONCILIATION</b></font><br/>'
        f'<font color="{GREY_DARK.hexval()}">Working Paper</font>'
    )
    letterhead_data = [[
        Paragraph(company, styles["letterhead_company"]),
        Paragraph(title_lines, ParagraphStyle(
            "lh_title_right", parent=styles["letterhead_meta"],
            fontSize=10, leading=14, alignment=2,
        )),
    ], [
        Paragraph(
            f'<font color="{GREY_MID.hexval()}"><b>RECONCILIATION WORKING PAPER</b></font>',
            ParagraphStyle("lh_kicker", parent=styles["letterhead_kicker"], alignment=0),
        ),
        Paragraph(period_label_lines, ParagraphStyle(
            "lh_period_right", parent=styles["letterhead_meta"],
            fontSize=10, leading=14, alignment=2,
        )),
    ]]
    letterhead = Table(letterhead_data, colWidths=[3.5 * inch, 3.6 * inch])
    letterhead.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, 0), 0),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
        ("TOPPADDING",    (0, 1), (-1, 1), 0),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 0),
    ]))
    story.append(letterhead)
    story.append(Spacer(1, 0.06 * inch))
    story.append(_hairline(INK, 1.2))
    story.append(Spacer(1, 0.16 * inch))

    # ── Account identifier + headline balance boxes ────────────────────
    status_display = _STATUS_DISPLAY.get(
        data.get("status", "pending"),
        str(data.get("status", "")).replace("_", " ").title(),
    )
    meta_bits = [b for b in [data.get("account_type"), f"Period ending {_fmt_date(pe)}", status_display] if b]
    story.append(Paragraph(account_label, styles["account_title"]))
    story.append(Paragraph(" · ".join(meta_bits), styles["account_meta"]))
    story.append(Spacer(1, 0.14 * inch))
    story.append(_kpi_boxes(data))
    story.append(Spacer(1, 0.04 * inch))

    # ── 1. Account Information ─────────────────────────────────────────
    story.append(Paragraph("ACCOUNT INFORMATION", styles["section"]))
    story.append(_account_info_table(data, account_label))

    # ── 2. Reconciliation build-up ─────────────────────────────────────
    items = data.get("reconciling_items") or []
    item_count_label = f"{len(items)} RECONCILING ITEM{'' if len(items) == 1 else 'S'}"
    story.append(Paragraph(
        f"RECONCILIATION BUILD-UP  &nbsp;&nbsp;<font size='7' color='{GREY_MID.hexval()}'>· {item_count_label}</font>",
        styles["section"],
    ))
    story.append(_reconciliation_table(data))

    # ── 3. AI commentary (optional) ────────────────────────────────────
    commentary = data.get("ai_commentary")
    if commentary and isinstance(commentary, dict):
        story.append(Paragraph("AI COMMENTARY", styles["section"]))
        story.extend(_ai_commentary_table(commentary, styles))

    # ── 4. Notes (optional) ────────────────────────────────────────────
    notes = (data.get("notes") or "").strip()
    if notes:
        story.append(Paragraph("NOTES", styles["section"]))
        story.append(Paragraph(notes, styles["note_body"]))

    # ── 5. Attachments ─────────────────────────────────────────────────
    story.append(Paragraph("SUPPORTING ATTACHMENTS", styles["section"]))
    story.extend(_attachments(data, styles))

    doc.build(story)
