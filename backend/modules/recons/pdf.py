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
    Frame,
    PageTemplate,
    Paragraph,
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
        "masthead_company": ParagraphStyle(
            "masthead_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=18, leading=22, alignment=1, textColor=NAVY, spaceAfter=2,
        ),
        "masthead_title": ParagraphStyle(
            "masthead_title", parent=base["BodyText"], fontName="Helvetica",
            fontSize=13, leading=16, alignment=1, textColor=GREY_DARK, spaceAfter=2,
        ),
        "masthead_subtitle": ParagraphStyle(
            "masthead_subtitle", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=11, leading=13, alignment=1, textColor=GREY_MID, spaceAfter=18,
        ),
        "section": ParagraphStyle(
            "section", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=10, leading=12, textColor=NAVY, spaceBefore=14, spaceAfter=6,
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
    """Two-column key/value table with everything an auditor wants up top —
    account identifiers, period, status, and the prepared/approved actors.
    Single tabular block (per user request — was a kv_table + a separate
    approval_trail before)."""
    pe = data["period_end"]
    if not isinstance(pe, date):
        pe = date.fromisoformat(str(pe))

    status_raw = data.get("status", "pending")
    status_display = {
        "approved": "Reconciled and Approved",
        "reviewed": "Prepared — pending review",
        "flagged":  "Flagged for follow-up",
        "pending":  "Open",
    }.get(status_raw, status_raw.replace("_", " ").title())

    def actor_line(name: str | None, when: str | None) -> str:
        if not name:
            return "—"
        if when:
            return f"{name} · {_fmt_date(when)}"
        return name

    rows: list[list[Any]] = [
        ["Account",       account_label],
        ["Account Type",  data.get("account_type") or "—"],
        ["Period End",    _fmt_date(pe)],
        ["Status",        status_display],
        ["Prepared By",   actor_line(data.get("prepared_by_name"), data.get("prepared_at"))],
        ["Approved By",   actor_line(data.get("approved_by_name"), data.get("approved_at"))],
    ]
    tbl = Table(rows, colWidths=[1.6 * inch, 5.5 * inch])
    tbl.setStyle(TableStyle([
        ("FONT",          (0, 0), (0, -1), "Helvetica-Bold", 9),
        ("FONT",          (1, 0), (1, -1), "Helvetica", 10),
        ("TEXTCOLOR",     (0, 0), (0, -1), GREY_MID),
        ("TEXTCOLOR",     (1, 0), (1, -1), GREY_DARK),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("BACKGROUND",    (0, 0), (-1, -1), colors.Color(0.98, 0.98, 0.98)),
        ("LINEABOVE",     (0, 0), (-1, 0), 0.75, NAVY),
        ("LINEBELOW",     (0, -1), (-1, -1), 0.75, NAVY),
        ("ROWBACKGROUNDS",(0, 0), (-1, -1),
            [colors.Color(0.98, 0.98, 0.98), colors.white]),
    ]))
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

    # 1. Opening — Subledger Balance (RF)
    opening_subnote = data.get("opening_source") or ""
    opening_memo = "Subledger Balance (Rolled Forward)"
    if opening_subnote:
        opening_memo = f"Subledger Balance (RF) — {opening_subnote}"
    rows.append(["", "", "", opening_memo, _fmt_money(opening)])
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
        colWidths=[0.85 * inch, 1.25 * inch, 0.85 * inch, 2.95 * inch, 1.2 * inch],
        repeatRows=1,
    )

    style: list[tuple] = [
        # Header
        ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("TEXTCOLOR",     (0, 0), (-1, 0), NAVY),
        ("ALIGN",         (-1, 0), (-1, 0), "RIGHT"),
        ("LINEBELOW",     (0, 0), (-1, 0), 0.75, NAVY),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("TOPPADDING",    (0, 0), (-1, 0), 4),
        # Body defaults
        ("FONT",          (0, 1), (-1, -1), "Helvetica", 9),
        ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
        ("ALIGN",         (-1, 1), (-1, -1), "RIGHT"),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
        ("TOPPADDING",    (0, 1), (-1, -1), 4),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        # Opening (Subledger Balance RF) — bold, light grey bg
        ("FONT",          (0, opening_row_idx), (-1, opening_row_idx), "Helvetica-Bold", 9),
        ("BACKGROUND",    (0, opening_row_idx), (-1, opening_row_idx), GREY_BG),
        ("TOPPADDING",    (0, opening_row_idx), (-1, opening_row_idx), 6),
        ("BOTTOMPADDING", (0, opening_row_idx), (-1, opening_row_idx), 6),
        # Closing row — bold + rule above
        ("FONT",          (0, closing_row_idx), (-1, closing_row_idx), "Helvetica-Bold", 10),
        ("LINEABOVE",     (0, closing_row_idx), (-1, closing_row_idx), 0.75, GREY_DARK),
        ("TOPPADDING",    (0, closing_row_idx), (-1, closing_row_idx), 6),
        ("BOTTOMPADDING", (0, closing_row_idx), (-1, closing_row_idx), 4),
        # GL Balance row — bold (target value to match)
        ("FONT",          (0, gl_row_idx), (-1, gl_row_idx), "Helvetica-Bold", 10),
        ("TOPPADDING",    (0, gl_row_idx), (-1, gl_row_idx), 4),
        # Variance row — heavy, navy, double rule, tinted by status
        ("FONT",          (0, var_row_idx), (-1, var_row_idx), "Helvetica-Bold", 11),
        ("TEXTCOLOR",     (0, var_row_idx), (-1, var_row_idx), GREEN if tied_out else RED),
        ("LINEABOVE",     (0, var_row_idx), (-1, var_row_idx), 0.5, NAVY),
        ("LINEBELOW",     (0, var_row_idx), (-1, var_row_idx), 1.5, NAVY),
        ("BACKGROUND",    (0, var_row_idx), (-1, var_row_idx),
            GREEN_TINT if tied_out else colors.Color(0.725, 0.114, 0.114, alpha=0.08)),
        ("TOPPADDING",    (0, var_row_idx), (-1, var_row_idx), 8),
        ("BOTTOMPADDING", (0, var_row_idx), (-1, var_row_idx), 8),
    ]
    # Red negative amounts on reconciling item rows only.
    for idx in range(items_start_idx, items_end_idx + 1):
        cell = rows[idx][-1]
        if cell and cell.startswith("$("):
            style.append(("TEXTCOLOR", (-1, idx), (-1, idx), RED))
    # Light separator under the last reconciling item so the eye sees
    # "items end here, totals begin".
    if items_end_idx >= items_start_idx:
        style.append(("LINEBELOW", (0, items_end_idx), (-1, items_end_idx), 0.25, GREY_LIGHT))
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

    # Masthead — company / "Account Reconciliation" / account · period
    story.append(Paragraph(company, styles["masthead_company"]))
    story.append(Paragraph("Account Reconciliation", styles["masthead_title"]))
    story.append(Paragraph(
        f"{account_label} · {_fmt_date(pe)}",
        styles["masthead_subtitle"],
    ))

    # 1. Account Information — single tabular block, includes Prepared
    #    By and Approved By per user request (no separate "Approval
    #    Trail" section anymore).
    story.append(Paragraph("Account Information", styles["section"]))
    story.append(_account_info_table(data, account_label))

    # 2. Reconciliation — Subledger (RF) + items = closing → GL match → variance.
    items = data.get("reconciling_items") or []
    story.append(Paragraph(
        f"Reconciliation Summary ({len(items)} reconciling item{'' if len(items) == 1 else 's'})",
        styles["section"],
    ))
    story.append(_reconciliation_table(data))

    # 3. AI commentary (only if this row was AI-prepared — null otherwise).
    #    Sits before Notes so the reviewer reads the AI's confidence + checks
    #    + recommendation in flow, then any human notes after.
    commentary = data.get("ai_commentary")
    if commentary and isinstance(commentary, dict):
        story.append(Paragraph("AI Commentary", styles["section"]))
        story.extend(_ai_commentary_table(commentary, styles))

    # 4. Notes (only if preparer or reviewer left one)
    notes = (data.get("notes") or "").strip()
    if notes:
        story.append(Paragraph("Notes", styles["section"]))
        story.append(Paragraph(notes, styles["note_body"]))

    # 4. Attachments list
    story.append(Paragraph("Supporting Attachments", styles["section"]))
    story.extend(_attachments(data, styles))

    doc.build(story)
