"""
Per-account reconciliation PDF.

Single-page audit working paper for one (account, period). Layout:

  ┌─────────────────────────────────────────────────────────────┐
  │  Masthead       — company / Account Reconciliation /        │
  │                   account label · period                    │
  ├─────────────────────────────────────────────────────────────┤
  │  Account Information   tabular block: # / Name / Type /     │
  │                        Period End / Status / Prepared by /  │
  │                        Approved by                          │
  ├─────────────────────────────────────────────────────────────┤
  │  Reconciliation        Subledger Balance (RF)               │
  │                      + Reconciling item 1                   │
  │                      + Reconciling item 2 …                 │
  │                      = Closing Subledger Balance            │
  │                        General Ledger Balance               │
  │                        Variance (GL − Subledger)   = $0     │
  ├─────────────────────────────────────────────────────────────┤
  │  Notes                 preparer/reviewer free text          │
  ├─────────────────────────────────────────────────────────────┤
  │  Supporting Attachments  • file_1.pdf · uploaded ...        │
  │                          • file_2.xlsx · uploaded ...       │
  └─────────────────────────────────────────────────────────────┘

When a long reconciling-items list overflows, the Reconciliation table
spills onto page 2/3 — the header row repeats automatically so the
columns stay readable on every page. DRAFT watermark applied when the
account isn't yet approved.

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
    Flowable,
    Frame,
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
GREEN_TINT = colors.Color(0.243, 0.561, 0.4, alpha=0.10)
GREY_BG    = colors.Color(0.95, 0.95, 0.95)


# ── Styles ──────────────────────────────────────────────────────────────────

def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        # Letterhead block — bigger, left-aligned for an authoritative
        # working-paper feel (previous version was centered which read
        # more like a flyer).
        "letterhead_company": ParagraphStyle(
            "letterhead_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=22, leading=26, textColor=NAVY, spaceAfter=2,
        ),
        "letterhead_kicker": ParagraphStyle(
            "letterhead_kicker", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=8, leading=10, textColor=GREY_MID, spaceAfter=6,
            # uppercase letter-spaced label that sits above the title
        ),
        "letterhead_title": ParagraphStyle(
            "letterhead_title", parent=base["BodyText"], fontName="Helvetica",
            fontSize=14, leading=17, textColor=GREY_DARK, spaceAfter=2,
        ),
        "letterhead_meta": ParagraphStyle(
            "letterhead_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=13, textColor=GREY_MID,
        ),
        "section": ParagraphStyle(
            "section", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=9, leading=11, textColor=NAVY,
            spaceBefore=16, spaceAfter=4,
            # tighter spacing, navy color, slightly smaller — reads as a
            # section divider, not a title
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


def _fmt_date(d: date | str | None) -> str:
    if d is None or d == "":
        return ""
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d[:10])
        except Exception:
            return d
    return d.strftime("%b %d, %Y")


# ── Small helper flowables ─────────────────────────────────────────────────


class _Hairline(Flowable):
    """A horizontal rule that spans the full body frame width. Used to
    separate the letterhead from the body content."""
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
        # DRAFT watermark
        if is_draft:
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
        canvas.restoreState()

    body_tpl = PageTemplate(id="body", frames=[body_frame], onPage=on_page)
    doc = BaseDocTemplate(
        buffer, pagesize=LETTER, leftMargin=margin, rightMargin=margin,
        topMargin=margin, bottomMargin=margin,
        title=f"Account Reconciliation — {company} — {account_label} — {period_end.isoformat()}",
        author=company,
    )
    doc.addPageTemplates([body_tpl])
    return doc


# ── Account Information (tabular) ──────────────────────────────────────────

def _account_info_table(data: dict, account_label: str) -> Table:
    """Account Information block — laid out as a 2x6 grid: label / value
    in two columns side-by-side for a tighter, more report-like read.
    Replaces the previous tall single-column key/value layout that
    chewed up vertical space."""
    pe = data["period_end"]
    if not isinstance(pe, date):
        pe = date.fromisoformat(str(pe))

    status_raw = data.get("status", "pending")
    status_display = {
        "approved": "Reconciled & Approved",
        "reviewed": "Prepared — Pending Review",
        "flagged":  "Flagged for Follow-up",
        "pending":  "Open",
    }.get(status_raw, status_raw.replace("_", " ").title())

    def actor_line(name: str | None, when: str | None) -> str:
        if not name:
            return "—"
        if when:
            return f"{name}\n{_fmt_date(when)}"
        return name

    acct_num = data.get("account_number") or "—"
    acct_name = data.get("account_name") or "—"

    # 4-column layout: label | value | label | value
    # Each logical row becomes one PDF row with two key/value pairs.
    rows: list[list[Any]] = [
        ["Account No.",   acct_num,                     "Status",      status_display],
        ["Account Name",  acct_name,                    "Period End",  _fmt_date(pe)],
        ["Account Type",  data.get("account_type") or "—", "Currency",  "USD"],
        ["Prepared By",   actor_line(data.get("prepared_by_name"), data.get("prepared_at")),
         "Approved By",   actor_line(data.get("approved_by_name"), data.get("approved_at"))],
    ]
    tbl = Table(
        rows,
        colWidths=[1.05 * inch, 2.45 * inch, 1.05 * inch, 2.55 * inch],
    )
    style: list[tuple] = [
        # Labels (cols 0 + 2): small uppercase grey
        ("FONT",          (0, 0), (0, -1), "Helvetica-Bold", 7.5),
        ("FONT",          (2, 0), (2, -1), "Helvetica-Bold", 7.5),
        ("TEXTCOLOR",     (0, 0), (0, -1), GREY_MID),
        ("TEXTCOLOR",     (2, 0), (2, -1), GREY_MID),
        # Values (cols 1 + 3): medium dark for readability
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
        # Light dividing rule between rows for a "form" feel
        ("LINEBELOW",     (0, 0), (-1, -2), 0.25, GREY_LIGHT),
        # Navy top + bottom rule frames the block as a single section
        ("LINEABOVE",     (0, 0), (-1, 0), 1.0, NAVY),
        ("LINEBELOW",     (0, -1), (-1, -1), 0.75, NAVY),
        # Subtle alternating column tint to separate the two key/value pairs
        ("BACKGROUND",    (0, 0), (1, -1), colors.Color(0.985, 0.987, 0.99)),
        ("BACKGROUND",    (2, 0), (3, -1), colors.Color(0.97, 0.975, 0.985)),
    ]
    # Account Name in row 1 is the most-identifying field — bump it.
    style.append(("FONT", (1, 1), (1, 1), "Helvetica-Bold", 10))
    style.append(("TEXTCOLOR", (1, 1), (1, 1), NAVY))
    tbl.setStyle(TableStyle(style))
    return tbl


# ── Reconciliation Summary (build-up + GL match + variance) ────────────────

def _reconciliation_table(data: dict) -> Table:
    """The whole reconciliation in one table:

        Subledger Balance (Rolled Forward)        $opening
      + Reconciling item 1                        $+/-
      + Reconciling item 2                        $+/-
      ...
      = Closing Subledger Balance                 $closing
        General Ledger Balance                    $gl
        Variance (GL − Subledger)                 $0.00

    Sign on each reconciling item follows the account's natural side:
    credit-natural accounts (AP, Credit Card, liabilities, equity) flip
    the QBO-returned amount so additions/reductions read correctly;
    manual items are entered signed by the user and are NOT flipped.
    """
    flip = -1 if data.get("is_credit_natural") else 1
    opening = Decimal(data["opening_balance"])
    items = data.get("reconciling_items") or []
    gl_balance = Decimal(data["gl_balance"])

    # Header
    header = ["Date", "Type", "Ref #", "Memo / Description", "Amount"]
    rows: list[list[Any]] = [header]

    # 1. Opening — clean label; source goes in a smaller note line in
    # the memo column instead of being concatenated onto the label.
    opening_subnote = data.get("opening_source") or ""
    rows.append([
        "", "", "",
        f"Opening Subledger Balance" + (
            f"  ({opening_subnote})" if opening_subnote and len(opening_subnote) < 60 else ""
        ),
        _fmt_money(opening),
    ])
    opening_row_idx = len(rows) - 1

    # 2. Reconciling items
    items_sum = Decimal("0")
    items_start_idx = len(rows)
    for it in items:
        is_manual = str(it.get("txn_id", "")).startswith("manual-")
        raw_amt = Decimal(str(it.get("amount", "0") or "0"))
        signed = raw_amt if is_manual else (flip * raw_amt)
        items_sum += signed
        memo = (it.get("memo") or "")[:60]
        if is_manual and "Manual" not in (it.get("txn_type") or ""):
            type_label = ((it.get("txn_type") or "Manual")[:18]) + " · Manual"
        else:
            type_label = (it.get("txn_type") or "")[:24]
        rows.append([
            _fmt_date(it.get("txn_date") or ""),
            type_label,
            (it.get("txn_number") or "")[:14],
            memo,
            _fmt_money(signed),
        ])
    items_end_idx = len(rows) - 1

    # 3. Closing Subledger Balance (= opening + items)
    closing = opening + items_sum
    rows.append(["", "", "", "Closing Subledger Balance", _fmt_money(closing)])
    closing_row_idx = len(rows) - 1

    # 4. GL Balance (the target the subledger should match)
    rows.append(["", "", "", "General Ledger Balance", _fmt_money(gl_balance)])
    gl_row_idx = len(rows) - 1

    # 5. Variance — should be $0.00 on a reconciled account
    variance = gl_balance - closing
    tied_out = abs(variance) < Decimal("1.00")
    variance_display = _fmt_money(Decimal("0")) if tied_out else _fmt_money(variance)
    rows.append(["", "", "", "Variance (GL − Subledger)", variance_display])
    var_row_idx = len(rows) - 1

    tbl = Table(
        rows,
        # Slightly different proportions: more room for memo, less for type
        colWidths=[0.85 * inch, 1.15 * inch, 0.75 * inch, 3.15 * inch, 1.20 * inch],
        repeatRows=1,
    )

    style: list[tuple] = [
        # Header — navy band on top
        ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
        ("TEXTCOLOR",     (0, 0), (-1, 0), colors.white),
        ("BACKGROUND",    (0, 0), (-1, 0), NAVY),
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
        # (Zebra striping handled per-row below — ROWBACKGROUNDS only
        # accepts a range across the whole table so we apply BACKGROUND
        # cell-by-cell for the items section.)
        # Opening (Subledger Balance Opening) — bold + tinted accent bg
        ("FONT",          (0, opening_row_idx), (-1, opening_row_idx), "Helvetica-Bold", 9.5),
        ("BACKGROUND",    (0, opening_row_idx), (-1, opening_row_idx),
            colors.Color(0.95, 0.953, 0.965)),
        ("TOPPADDING",    (0, opening_row_idx), (-1, opening_row_idx), 8),
        ("BOTTOMPADDING", (0, opening_row_idx), (-1, opening_row_idx), 8),
        ("LINEBELOW",     (0, opening_row_idx), (-1, opening_row_idx), 0.5, GREY_LIGHT),
        # Closing row — bold + heavy rule above
        ("FONT",          (0, closing_row_idx), (-1, closing_row_idx), "Helvetica-Bold", 10),
        ("LINEABOVE",     (0, closing_row_idx), (-1, closing_row_idx), 1.0, GREY_DARK),
        ("TOPPADDING",    (0, closing_row_idx), (-1, closing_row_idx), 7),
        ("BOTTOMPADDING", (0, closing_row_idx), (-1, closing_row_idx), 5),
        ("BACKGROUND",    (0, closing_row_idx), (-1, closing_row_idx),
            colors.Color(0.97, 0.972, 0.98)),
        # GL Balance row — bold (target value to match)
        ("FONT",          (0, gl_row_idx), (-1, gl_row_idx), "Helvetica-Bold", 10),
        ("TOPPADDING",    (0, gl_row_idx), (-1, gl_row_idx), 5),
        ("BOTTOMPADDING", (0, gl_row_idx), (-1, gl_row_idx), 5),
        ("BACKGROUND",    (0, gl_row_idx), (-1, gl_row_idx),
            colors.Color(0.97, 0.972, 0.98)),
        # Variance row — heavy, double rule, tinted by tie status
        ("FONT",          (0, var_row_idx), (-1, var_row_idx), "Helvetica-Bold", 11),
        ("TEXTCOLOR",     (0, var_row_idx), (-1, var_row_idx), GREEN if tied_out else RED),
        ("LINEABOVE",     (0, var_row_idx), (-1, var_row_idx), 0.75, NAVY),
        ("LINEBELOW",     (0, var_row_idx), (-1, var_row_idx), 2.0, NAVY),
        ("BACKGROUND",    (0, var_row_idx), (-1, var_row_idx),
            GREEN_TINT if tied_out else colors.Color(0.725, 0.114, 0.114, alpha=0.08)),
        ("TOPPADDING",    (0, var_row_idx), (-1, var_row_idx), 10),
        ("BOTTOMPADDING", (0, var_row_idx), (-1, var_row_idx), 10),
    ]
    # Per-item-row formatting: zebra stripe + red for negative amounts.
    for n, idx in enumerate(range(items_start_idx, items_end_idx + 1)):
        # Light tint on every other items row for readability.
        if n % 2 == 1:
            style.append((
                "BACKGROUND", (0, idx), (-1, idx),
                colors.Color(0.975, 0.978, 0.985),
            ))
        cell = rows[idx][-1]
        if cell and cell.startswith("$("):
            style.append(("TEXTCOLOR", (-1, idx), (-1, idx), RED))
    tbl.setStyle(TableStyle(style))
    return tbl


# ── AI Commentary ──────────────────────────────────────────────────────────


def _ai_commentary_table(commentary: dict, styles: dict) -> list[Any]:
    """Render the AI commentary as a 3-row block: confidence pill / checks
    table / recommendation banner. Returns a list of flowables so it slots
    into `story` directly."""
    out: list[Any] = []
    conf = (commentary.get("confidence") or "").lower()
    rec = (commentary.get("recommendation") or "").lower()
    narrative = (commentary.get("narrative") or "").strip()
    checks = commentary.get("checks") or []

    # Confidence + recommendation pill row
    conf_color = {"high": GREEN, "medium": colors.HexColor("#b45309"), "low": RED}.get(conf, GREY_DARK)
    rec_label = {"approve": "Approve as-is", "review": "Review flagged items",
                  "investigate": "Investigate before approving"}.get(rec, rec.title())
    pill_row = [[
        Paragraph(
            f'<font color="{conf_color.hexval()}"><b>Confidence: {conf.title() or "—"}</b></font>',
            styles["note_body"],
        ),
        Paragraph(
            f'<font color="{conf_color.hexval()}"><b>AI Recommendation: {rec_label}</b></font>',
            styles["note_body"],
        ),
    ]]
    pill_tbl = Table(pill_row, colWidths=[3.55 * inch, 3.55 * inch])
    pill_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1),
            colors.Color(*[c / 255 for c in (62, 143, 102)], alpha=0.10) if conf == "high"
            else colors.Color(0.85, 0.55, 0.10, alpha=0.10) if conf == "medium"
            else colors.Color(0.725, 0.114, 0.114, alpha=0.10)),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    out.append(pill_tbl)

    # Narrative
    if narrative:
        out.append(Paragraph(narrative, styles["note_body"]))

    # Checks table
    if checks:
        header = ["Check", "Status", "Detail"]
        rows: list[list[Any]] = [header]
        for c in checks:
            status_raw = (c.get("status") or "pass").lower()
            status_label = {"pass": "✓ Pass", "warn": "⚠ Warn", "fail": "✕ Fail"}.get(status_raw, status_raw.title())
            rows.append([
                c.get("name") or "—",
                status_label,
                Paragraph(c.get("detail") or "—", styles["note_body"]),
            ])
        tbl = Table(rows, colWidths=[1.8 * inch, 0.85 * inch, 4.45 * inch], repeatRows=1)
        style: list[tuple] = [
            ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 9),
            ("TEXTCOLOR",     (0, 0), (-1, 0), NAVY),
            ("LINEBELOW",     (0, 0), (-1, 0), 0.75, NAVY),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("FONT",          (0, 1), (-1, -1), "Helvetica", 9),
            ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING",    (0, 1), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
            ("LEFTPADDING",   (0, 0), (-1, -1), 6),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        ]
        # Color the status cell per check
        for idx, c in enumerate(checks, start=1):
            s = (c.get("status") or "pass").lower()
            color = GREEN if s == "pass" else colors.HexColor("#b45309") if s == "warn" else RED
            style.append(("TEXTCOLOR", (1, idx), (1, idx), color))
            style.append(("FONT", (1, idx), (1, idx), "Helvetica-Bold", 9))
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
      company:             str
      account_number:      str
      account_name:        str
      account_type:        str
      period_end:          date
      status:              str
      gl_balance:          str (Decimal)
      subledger_balance:   str (Decimal)        # kept for back-compat; not used in render
      opening_balance:     str (Decimal)
      opening_source:      str | None
      is_credit_natural:   bool
      reconciling_items:   list[dict]
      notes:               str | None
      prepared_by_name:    str | None
      prepared_at:         str | None
      approved_by_name:    str | None
      approved_at:         str | None
      evidence_files:      list[dict]
      is_draft:            bool
      prepared_by:         str                  # generator's email (footer)
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

    # ── Letterhead block ────────────────────────────────────────────────
    # Two-column header: company name + kicker on the left, document
    # title + period on the right. Reads as an authoritative working
    # paper rather than a centered marketing-flyer style.
    period_label_lines = (
        f'<font color="{GREY_MID.hexval()}">PERIOD ENDING</font><br/>'
        f'<font color="{NAVY.hexval()}"><b>{_fmt_date(pe).upper()}</b></font>'
    )
    title_lines = (
        f'<font color="{GREY_MID.hexval()}"><b>ACCOUNT RECONCILIATION</b></font><br/>'
        f'<font color="{GREY_DARK.hexval()}">Working Paper</font>'
    )
    letterhead_data = [[
        Paragraph(company, styles["letterhead_company"]),
        Paragraph(title_lines, ParagraphStyle(
            "lh_title_right", parent=styles["letterhead_meta"],
            fontSize=10, leading=14, alignment=2,  # right-aligned
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
    # Heavy navy hairline beneath the letterhead — visual separator
    # that frames everything above as the "header" of the document.
    story.append(Spacer(1, 0.06 * inch))
    story.append(_hairline(NAVY, 1.2))
    story.append(Spacer(1, 0.18 * inch))

    # ── 1. Account Information ─────────────────────────────────────────
    story.append(Paragraph("ACCOUNT INFORMATION", styles["section"]))
    story.append(_account_info_table(data, account_label))

    # 2. Reconciliation — Opening + items = closing → GL match → variance.
    items = data.get("reconciling_items") or []
    item_count_label = (
        f"{len(items)} RECONCILING ITEM{'' if len(items) == 1 else 'S'}"
    )
    story.append(Paragraph(
        f"RECONCILIATION SUMMARY  &nbsp;&nbsp;<font size='7' color='{GREY_MID.hexval()}'>· {item_count_label}</font>",
        styles["section"],
    ))
    story.append(_reconciliation_table(data))

    # 3. AI commentary (only if this row was AI-prepared — null otherwise).
    commentary = data.get("ai_commentary")
    if commentary and isinstance(commentary, dict):
        story.append(Paragraph("AI COMMENTARY", styles["section"]))
        story.extend(_ai_commentary_table(commentary, styles))

    # 4. Notes (only if preparer or reviewer left one)
    notes = (data.get("notes") or "").strip()
    if notes:
        story.append(Paragraph("NOTES", styles["section"]))
        story.append(Paragraph(notes, styles["note_body"]))

    # 5. Attachments list
    story.append(Paragraph("SUPPORTING ATTACHMENTS", styles["section"]))
    story.extend(_attachments(data, styles))

    doc.build(story)
