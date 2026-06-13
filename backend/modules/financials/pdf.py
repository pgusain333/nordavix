"""
audit-ready styled PDF generator for the Financial Package.

Design language matches an audited financial-statement package:
  • Cover page: ENTITY name 36pt navy, statement titles, period,
    prepared-by + generation date, "Audited by Nordavix" footer.
  • Body pages: every statement page has a centered MASTHEAD that
    repeats the entity name and statement title — so any page
    photocopied out of context is still identifiable.
  • Helvetica throughout; fully MONOCHROME — near-black accents on
    grey/black, no color anywhere.
  • Flat-row rendering with kind-driven styling:
      section_header   → uppercase bold, no values, top padding
      data             → indented per level, plain
      total            → bold + single rule on top
      computed         → bold + single rule on top
      grand_total      → bold + double rule (top + bottom)
  • Numbers right-aligned, parens for negatives, em-dash for zero,
    comma thousands. $ only on the first row of each section + on
    totals (a audit-ready convention).
  • DRAFT watermark (45° rotated, large grey) when exporting before
    books are closed.
  • Footer on every page: company · page X of Y · "Generated <date>".
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

# Monochrome palette (no color — CPA-workpaper aesthetic). "NAVY" is kept as a
# name so the accent references below don't all need renaming, but it now
# resolves to near-black. Negatives use the body grey (parentheses carry the
# sign), not red.
NAVY      = colors.HexColor("#111827")   # near-black accent (was navy)
GREY_DARK = colors.HexColor("#374151")
GREY_MID  = colors.HexColor("#6b7280")
GREY_LIGHT= colors.HexColor("#d1d5db")
RED       = colors.HexColor("#374151")   # negatives render in body grey (mono)


# ── Styles ──────────────────────────────────────────────────────────────────

def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "cover_company": ParagraphStyle(
            "cover_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=36, leading=42, alignment=1, textColor=NAVY, spaceAfter=12,
        ),
        "cover_title": ParagraphStyle(
            "cover_title", parent=base["BodyText"], fontName="Helvetica",
            fontSize=18, leading=22, alignment=1, textColor=GREY_DARK, spaceAfter=6,
        ),
        "cover_period": ParagraphStyle(
            "cover_period", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=13, leading=16, alignment=1, textColor=GREY_DARK, spaceAfter=12,
        ),
        "cover_meta": ParagraphStyle(
            "cover_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=13, alignment=1, textColor=GREY_MID,
        ),
        "masthead_company": ParagraphStyle(
            "masthead_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=16, leading=19, alignment=1, textColor=NAVY, spaceAfter=2,
        ),
        "masthead_title": ParagraphStyle(
            "masthead_title", parent=base["BodyText"], fontName="Helvetica",
            fontSize=12, leading=15, alignment=1, textColor=GREY_DARK, spaceAfter=2,
        ),
        "masthead_subtitle": ParagraphStyle(
            "masthead_subtitle", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=10, leading=12, alignment=1, textColor=GREY_MID, spaceAfter=14,
        ),
        "note": ParagraphStyle(
            "note", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=8, leading=10, textColor=GREY_MID, spaceBefore=8,
        ),
    }


# ── Number formatting ──────────────────────────────────────────────────────

def _fmt_money(s: str | None, with_dollar: bool = False) -> str:
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
    body = f"({n_str})" if sign < 0 else n_str
    return f"$ {body}" if (with_dollar and sign > 0) else (f"$({n_str})" if (with_dollar and sign < 0) else body)


# ── Page templates ──────────────────────────────────────────────────────────

def _make_doc(buffer: BinaryIO, company: str, *, is_draft: bool) -> tuple[BaseDocTemplate, list]:
    margin = 0.7 * inch
    page_w, page_h = LETTER

    body_frame = Frame(
        margin, margin, page_w - 2 * margin, page_h - 2 * margin - 0.4 * inch,
        id="body", topPadding=0, bottomPadding=0,
    )

    def on_page(canvas, doc) -> None:
        canvas.saveState()

        # DRAFT watermark — only on body pages (not cover) for visibility
        if is_draft and doc.page > 1:
            canvas.setFont("Helvetica-Bold", 100)
            canvas.setFillColor(colors.Color(0.85, 0.85, 0.85, alpha=0.45))
            canvas.translate(page_w / 2, page_h / 2)
            canvas.rotate(45)
            canvas.drawCentredString(0, 0, "DRAFT")
            canvas.translate(-page_w / 2, -page_h / 2)
            canvas.rotate(-45)

        # Footer
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GREY_MID)
        y = 0.4 * inch
        ts = datetime.now().strftime("%B %d, %Y")
        canvas.drawString(margin, y, company)
        canvas.drawCentredString(page_w / 2, y, f"Page {canvas.getPageNumber()}")
        canvas.drawRightString(page_w - margin, y, f"Generated {ts}")
        # Thin top rule for body pages
        if doc.page > 1:
            canvas.setStrokeColor(GREY_LIGHT)
            canvas.setLineWidth(0.5)
            canvas.line(margin, page_h - margin + 0.18 * inch,
                        page_w - margin, page_h - margin + 0.18 * inch)
        canvas.restoreState()

    body_tpl  = PageTemplate(id="body",  frames=[body_frame], onPage=on_page)
    cover_frame = Frame(
        margin, margin + 1.5 * inch, page_w - 2 * margin, page_h - 2 * margin - 2 * inch,
        id="cover",
    )
    cover_tpl = PageTemplate(id="cover", frames=[cover_frame], onPage=on_page)

    doc = BaseDocTemplate(
        buffer, pagesize=LETTER, leftMargin=margin, rightMargin=margin,
        topMargin=margin, bottomMargin=margin,
        title=f"Financial Statements — {company}", author=company,
    )
    doc.addPageTemplates([cover_tpl, body_tpl])
    return doc, []


# ── Cover page ─────────────────────────────────────────────────────────────

def _cover_page(story: list, styles: dict, *, company: str, period_end: date,
                statements: list[Any], prepared_by: str, is_draft: bool) -> None:
    story.append(Spacer(1, 1.4 * inch))
    if is_draft:
        story.append(Paragraph(
            '<font color="#374151"><b>— DRAFT —</b></font>', styles["cover_meta"],
        ))
        story.append(Spacer(1, 0.15 * inch))
    story.append(Paragraph(company, styles["cover_company"]))
    story.append(Spacer(1, 0.35 * inch))

    titles = " · ".join(s.title for s in statements)
    story.append(Paragraph(titles, styles["cover_title"]))
    story.append(Paragraph(f"As of {period_end.strftime('%B %d, %Y')}", styles["cover_period"]))

    story.append(Spacer(1, 1.4 * inch))
    if prepared_by:
        story.append(Paragraph(f"Prepared by {prepared_by}", styles["cover_meta"]))
    story.append(Paragraph(f"Generated {datetime.now().strftime('%B %d, %Y')}",
                            styles["cover_meta"]))
    story.append(Spacer(1, 0.05 * inch))
    story.append(Paragraph("Nordavix · Financial Statements", styles["cover_meta"]))


# ── Per-statement masthead + table ─────────────────────────────────────────

def _statement_masthead(story: list, styles: dict, stmt: Any) -> None:
    story.append(Paragraph(stmt.company, styles["masthead_company"]))
    story.append(Paragraph(stmt.title,   styles["masthead_title"]))
    story.append(Paragraph(stmt.subtitle, styles["masthead_subtitle"]))


def _statement_table(stmt: Any) -> Table:
    comparative = stmt.comparative_label is not None
    # Header columns
    if comparative:
        header = ["", stmt.period_label, stmt.comparative_label]
    else:
        header = ["", stmt.period_label]
    data: list[list[Any]] = [header]
    style_cmds: list[tuple] = [
        # Header row
        ("FONT",          (0, 0), (-1, 0), "Helvetica-Bold", 9),
        ("TEXTCOLOR",     (0, 0), (-1, 0), NAVY),
        ("LINEBELOW",     (0, 0), (-1, 0), 0.75, NAVY),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("TOPPADDING",    (0, 0), (-1, 0), 0),
        ("ALIGN",         (1, 0), (-1, 0), "RIGHT"),
        # Body defaults
        ("FONT",          (0, 1), (-1, -1), "Helvetica", 10),
        ("TEXTCOLOR",     (0, 1), (-1, -1), GREY_DARK),
        ("ALIGN",         (1, 1), (-1, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 2),
        ("TOPPADDING",    (0, 1), (-1, -1), 2),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
    ]

    row_idx = 1
    first_data_in_section = False
    for r in stmt.rows:
        label_indent = "    " * max(0, r.level)
        label = f"{label_indent}{r.label}"
        cur = ""
        prior = ""

        if r.kind == "section_header":
            label = r.label.upper()
            data.append([label, "", ""] if comparative else [label, ""])
            style_cmds += [
                ("FONT",      (0, row_idx), (0, row_idx), "Helvetica-Bold", 10),
                ("TEXTCOLOR", (0, row_idx), (0, row_idx), NAVY),
                ("TOPPADDING",(0, row_idx), (-1, row_idx), 10),
                ("BOTTOMPADDING",(0, row_idx), (-1, row_idx), 4),
            ]
            first_data_in_section = True
        elif r.kind == "data":
            cur = _fmt_money(r.current, with_dollar=first_data_in_section)
            prior = _fmt_money(r.prior, with_dollar=first_data_in_section)
            data.append([label, cur, prior] if comparative else [label, cur])
            first_data_in_section = False
        elif r.kind in ("total", "computed", "subtotal"):
            cur = _fmt_money(r.current, with_dollar=True)
            prior = _fmt_money(r.prior, with_dollar=True)
            data.append([label, cur, prior] if comparative else [label, cur])
            style_cmds += [
                ("FONT",     (0, row_idx), (-1, row_idx), "Helvetica-Bold", 10),
                ("LINEABOVE",(1, row_idx), (-1, row_idx), 0.5, GREY_DARK),
                ("TOPPADDING",(0, row_idx), (-1, row_idx), 4),
                ("BOTTOMPADDING",(0, row_idx), (-1, row_idx), 4),
            ]
            first_data_in_section = True   # next data row gets a $ again
        elif r.kind == "grand_total":
            cur = _fmt_money(r.current, with_dollar=True)
            prior = _fmt_money(r.prior, with_dollar=True)
            data.append([label, cur, prior] if comparative else [label, cur])
            style_cmds += [
                ("FONT",      (0, row_idx), (-1, row_idx), "Helvetica-Bold", 11),
                ("TEXTCOLOR", (0, row_idx), (-1, row_idx), NAVY),
                ("LINEABOVE", (0, row_idx), (-1, row_idx), 0.5, NAVY),
                ("LINEBELOW", (0, row_idx), (-1, row_idx), 1.5, NAVY),
                ("TOPPADDING",(0, row_idx), (-1, row_idx), 6),
                ("BOTTOMPADDING",(0, row_idx), (-1, row_idx), 6),
            ]
            first_data_in_section = True
        else:
            continue

        # Color negative numbers red — audit-ready style. Apply to data rows;
        # totals/computed already have bold styling.
        for col in (1, 2 if comparative else 1):
            cell = data[-1][col] if col < len(data[-1]) else ""
            if cell and cell.startswith("("):
                style_cmds.append(("TEXTCOLOR", (col, row_idx), (col, row_idx), RED))

        row_idx += 1

    # Column widths
    if comparative:
        col_widths = [3.6 * inch, 1.7 * inch, 1.7 * inch]
    else:
        col_widths = [4.4 * inch, 2.6 * inch]
    tbl = Table(data, colWidths=col_widths, repeatRows=1)
    tbl.setStyle(TableStyle(style_cmds))
    return tbl


# ── Public entry point ─────────────────────────────────────────────────────

def build_pdf(buffer: BinaryIO, *, company: str, period_end: date,
              statements: list[Any], prepared_by: str = "",
              is_draft: bool = False) -> None:
    styles = _styles()
    doc, story = _make_doc(buffer, company, is_draft=is_draft)

    # Cover page (uses cover template)
    _cover_page(story, styles, company=company, period_end=period_end,
                statements=statements, prepared_by=prepared_by, is_draft=is_draft)

    # Body pages (use body template) — one statement per page break
    for _i, s in enumerate(statements):
        story.append(PageBreak())
        _statement_masthead(story, styles, s)
        story.append(_statement_table(s))

        # Optional notes
        if s.notes:
            for n in s.notes:
                story.append(Paragraph(f"Note: {n}", styles["note"]))

    # Build
    doc.build(story)


if __name__ == "__main__":  # smoke
    from collections import namedtuple
    R = namedtuple("R", "label current prior level kind")
    S = namedtuple("S", "title subtitle company period_label comparative_label rows notes")
    rows = [
        R("Revenue", None, None, 0, "section_header"),
        R("Sales", "1250000", "1100000", 1, "data"),
        R("Total Revenue", "1250000", "1100000", 0, "total"),
        R("Net Income", "200000", "180000", 0, "grand_total"),
    ]
    s = S("Income Statement", "For the YTD Ended April 30, 2026",
          "Demo Co", "YTD Apr 2026", "YTD Apr 2025", rows, [])
    buf = BytesIO()
    build_pdf(buf, company="Demo Co", period_end=date.today(), statements=[s])
    print("ok", len(buf.getvalue()), "bytes")
