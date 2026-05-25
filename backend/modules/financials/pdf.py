"""
Big-4 styled PDF generator for the Financial Package.

Aesthetic targets:
  - Single accent color (#1f3a5f navy). Otherwise conservative grey/black.
  - Helvetica everywhere — clean, professional, universal.
  - Cover page: entity name, statement title(s), period, prepared-by + date.
  - Body: section headers (small caps), data rows (indented), section
    totals (italic + top rule), grand total (bold + double rule).
  - Page footer: company · page X of Y · YYYY-MM-DD generated stamp.
  - Two-column number layout when comparative=true (Current / Prior).
  - Right-aligned numbers with $ prefix on first row of each section
    and on totals — same convention as a Big-4 audit report.
"""
from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
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

# Brand palette
NAVY      = colors.HexColor("#1f3a5f")
GREY_DARK = colors.HexColor("#374151")
GREY_MID  = colors.HexColor("#6b7280")
GREY_LIGHT= colors.HexColor("#e5e7eb")


# ── Styles ──────────────────────────────────────────────────────────────────

def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "cover_title": ParagraphStyle(
            "cover_title", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=32, leading=38, alignment=1, textColor=NAVY,
            spaceAfter=12,
        ),
        "cover_sub": ParagraphStyle(
            "cover_sub", parent=base["BodyText"], fontName="Helvetica",
            fontSize=14, leading=18, alignment=1, textColor=GREY_DARK,
            spaceAfter=6,
        ),
        "cover_meta": ParagraphStyle(
            "cover_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=11, leading=14, alignment=1, textColor=GREY_MID,
        ),
        "section_title": ParagraphStyle(
            "section_title", parent=base["Heading1"], fontName="Helvetica-Bold",
            fontSize=18, leading=22, textColor=NAVY, spaceAfter=4, spaceBefore=12,
        ),
        "section_meta": ParagraphStyle(
            "section_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=12, textColor=GREY_MID, spaceAfter=14,
        ),
    }


# ── Number formatting ──────────────────────────────────────────────────────

def _fmt_money(s: str | None) -> str:
    """Big-4 number format: parens for negatives, comma thousands,
    no decimals unless the value has cents (most statement totals are
    whole dollars)."""
    if s is None or s == "":
        return ""
    try:
        v = Decimal(s)
    except Exception:
        return s
    if v == 0:
        return "—"
    sign = -1 if v < 0 else 1
    abs_v = abs(v).quantize(Decimal("1"))
    n_str = f"{int(abs_v):,}"
    return f"({n_str})" if sign < 0 else n_str


# ── Page templates ──────────────────────────────────────────────────────────

def _make_doc(buffer: BinaryIO, company: str) -> tuple[BaseDocTemplate, list]:
    margin = 0.7 * inch
    page_w, page_h = LETTER
    frame = Frame(margin, margin, page_w - 2 * margin, page_h - 2 * margin - 0.4 * inch, id="body")

    def on_page(canvas, doc) -> None:
        canvas.saveState()
        # Footer: company · page X · timestamp
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GREY_MID)
        footer_y = 0.4 * inch
        ts = datetime.now().strftime("%b %d, %Y")
        canvas.drawString(margin, footer_y, company)
        canvas.drawCentredString(page_w / 2, footer_y, f"Page {canvas.getPageNumber()}")
        canvas.drawRightString(page_w - margin, footer_y, f"Generated {ts}")
        # Thin top rule for body pages (not the cover — handled by template)
        if doc.page > 1:
            canvas.setStrokeColor(GREY_LIGHT)
            canvas.setLineWidth(0.5)
            canvas.line(margin, page_h - margin + 0.15 * inch,
                        page_w - margin, page_h - margin + 0.15 * inch)
        canvas.restoreState()

    body_tpl = PageTemplate(id="body", frames=[frame], onPage=on_page)
    cover_frame = Frame(margin, margin + 1.5 * inch, page_w - 2 * margin,
                        page_h - 2 * margin - 2 * inch, id="cover")
    cover_tpl = PageTemplate(id="cover", frames=[cover_frame], onPage=on_page)

    doc = BaseDocTemplate(buffer, pagesize=LETTER, leftMargin=margin, rightMargin=margin,
                          topMargin=margin, bottomMargin=margin,
                          title="Financial Package", author=company)
    doc.addPageTemplates([cover_tpl, body_tpl])
    story: list = []
    return doc, story


# ── Cover page ─────────────────────────────────────────────────────────────

def _cover_page(story: list, styles: dict, *, company: str, period_end: date,
                statements: list[Any], prepared_by: str) -> None:
    story.append(Spacer(1, 1.5 * inch))
    story.append(Paragraph(company, styles["cover_title"]))
    story.append(Spacer(1, 0.4 * inch))

    titles = " · ".join(s.title for s in statements)
    story.append(Paragraph(titles, styles["cover_sub"]))
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph(f"As of {period_end.strftime('%B %d, %Y')}", styles["cover_sub"]))

    story.append(Spacer(1, 1.5 * inch))
    if prepared_by:
        story.append(Paragraph(f"Prepared by {prepared_by}", styles["cover_meta"]))
    story.append(Paragraph(f"Generated {datetime.now().strftime('%B %d, %Y')}",
                            styles["cover_meta"]))
    story.append(Paragraph("Nordavix Financial Package", styles["cover_meta"]))


# ── Statement table ────────────────────────────────────────────────────────

def _statement_table(stmt: Any, comparative: bool) -> Table:
    # Header
    if comparative and stmt.comparative_label:
        header = ["", stmt.period_label.replace("YTD ", ""), stmt.comparative_label.replace("YTD ", "")]
    else:
        header = ["", stmt.period_label.replace("YTD ", "")]

    data: list[list[Any]] = [header]
    style_cmds: list[tuple] = [
        ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("TEXTCOLOR",     (0, 0), (-1, 0), NAVY),
        ("LINEBELOW",     (0, 0), (-1, 0), 0.5, NAVY),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("TOPPADDING",    (0, 0), (-1, 0), 0),
        ("ALIGN",         (1, 0), (-1, -1), "RIGHT"),
        ("FONT",          (0, 1), (-1, -1), "Helvetica", 10),
        ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
        ("TOPPADDING",    (0, 1), (-1, -1), 3),
    ]

    row_idx = 1
    for section in stmt.sections:
        # Section header (bold, small caps look via uppercase + spacing)
        data.append([section.name.upper(), "", ""] if comparative else [section.name.upper(), ""])
        style_cmds += [
            ("FONT",     (0, row_idx), (0, row_idx), "Helvetica-Bold", 9),
            ("TEXTCOLOR",(0, row_idx), (0, row_idx), NAVY),
            ("TOPPADDING",(0, row_idx), (-1, row_idx), 10),
        ]
        row_idx += 1

        for r in section.rows:
            if r.is_header:
                continue   # already rendered as section
            indent = "    " * max(0, r.level - 1)
            label = f"{indent}{r.label}"
            cur = _fmt_money(r.current)
            row = [label, cur, _fmt_money(r.prior)] if comparative else [label, cur]
            data.append(row)
            if r.is_total or r.is_subtotal:
                style_cmds += [
                    ("FONT",     (0, row_idx), (-1, row_idx), "Helvetica-Bold", 10),
                    ("LINEABOVE",(1, row_idx), (-1, row_idx), 0.4, GREY_DARK),
                ]
            row_idx += 1

        # Section total
        if section.total:
            cur = _fmt_money(section.total.current)
            row = [section.total.label, cur, _fmt_money(section.total.prior)] if comparative else [section.total.label, cur]
            data.append(row)
            style_cmds += [
                ("FONT",     (0, row_idx), (-1, row_idx), "Helvetica-Bold", 10),
                ("LINEABOVE",(1, row_idx), (-1, row_idx), 0.5, GREY_DARK),
                ("TOPPADDING",(0, row_idx), (-1, row_idx), 4),
            ]
            row_idx += 1

    # Grand total / footer row (Net Income, Total Liab+Equity, Net Change in Cash)
    if stmt.footer:
        cur = _fmt_money(stmt.footer.current)
        row = [stmt.footer.label, cur, _fmt_money(stmt.footer.prior)] if comparative else [stmt.footer.label, cur]
        data.append(row)
        style_cmds += [
            ("FONT",      (0, row_idx), (-1, row_idx), "Helvetica-Bold", 11),
            ("TEXTCOLOR", (0, row_idx), (-1, row_idx), NAVY),
            ("LINEABOVE", (0, row_idx), (-1, row_idx), 0.5, NAVY),
            ("LINEBELOW", (0, row_idx), (-1, row_idx), 1.5, NAVY),
            ("TOPPADDING",(0, row_idx), (-1, row_idx), 6),
            ("BOTTOMPADDING",(0, row_idx), (-1, row_idx), 6),
        ]

    # Column widths — label column expands, number columns fixed
    if comparative:
        col_widths = [3.6 * inch, 1.6 * inch, 1.6 * inch]
    else:
        col_widths = [4.4 * inch, 2.4 * inch]
    tbl = Table(data, colWidths=col_widths, repeatRows=1)
    tbl.setStyle(TableStyle(style_cmds))
    return tbl


# ── Public entry point ─────────────────────────────────────────────────────

def build_pdf(buffer: BinaryIO, *, company: str, period_end: date,
              statements: list[Any], prepared_by: str = "") -> None:
    """Build the multi-statement PDF into `buffer`."""
    styles = _styles()
    doc, story = _make_doc(buffer, company)

    _cover_page(story, styles, company=company, period_end=period_end,
                statements=statements, prepared_by=prepared_by)

    for s in statements:
        story.append(PageBreak())
        story.append(Paragraph(s.title, styles["section_title"]))
        meta = s.period_label
        if s.comparative_label:
            meta += f"  ·  compared to {s.comparative_label}"
        story.append(Paragraph(meta, styles["section_meta"]))
        story.append(_statement_table(s, comparative=s.comparative_label is not None))

    doc.build(story)


if __name__ == "__main__":  # smoke
    buf = BytesIO()
    class _Row: pass
    class _S:
        title = "Test"
        period_label = "YTD Apr 30, 2026"
        comparative_label = "YTD 2025"
        sections = []
        footer = None
    build_pdf(buf, company="Demo", period_end=date.today(), statements=[_S()])
    print("ok", len(buf.getvalue()), "bytes")
