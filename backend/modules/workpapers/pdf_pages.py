"""
Close Binder — front matter + audit appendix pages.

These are the binder's OWN pages — the ones no other module produces: a
branded cover, the Close Certificate (the QC attestation centrepiece), a
table of contents, and the period audit-trail appendix. The per-account
reconciliation packets, flux working papers, and financial statements are
rendered by their existing modules; binder.py stitches everything together.

Design: deliberately shares the recon packet's palette, formatters, hairline
and styles (imported below) so the stitched binder reads as ONE document, not
four tools bolted together. The cover adds the Nordavix brand band (deep pine
+ cream + sage) used nowhere else, to mark page one as the binder's face.

WinAnsi-safe glyphs only (ReportLab base-14 Helvetica): plain text, en-dashes,
ASCII "·" is NOT safe — use a middle dot via the helper. No check-marks.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# Reuse the recon packet's design kit so the binder is one visual family.
from modules.recons.pdf import (
    BORDER,
    CARD_BG,
    GREEN,
    GREEN_TINT,
    GREY_DARK,
    GREY_MID,
    INK,
    RED,
    _fmt_date_long,
    _Hairline,
    _styles,
)

# ── Brand band colours (cover only) ──────────────────────────────────────────
PINE  = colors.HexColor("#0C2620")   # deep pine — nav brand
CREAM = colors.HexColor("#F4F1E9")
SAGE  = colors.HexColor("#9CC4AD")
AMBER = colors.HexColor("#B45309")

_MARGIN = 0.72 * inch
_PAGE_W, _PAGE_H = LETTER
_BODY_W = _PAGE_W - 2 * _MARGIN
_DOT = "·"  # middle dot — WinAnsi safe


# ── Data contracts (binder.py fills these) ───────────────────────────────────
@dataclass
class BinderContext:
    company: str
    period_end: date
    period_label: str
    generated_at_label: str
    generated_by_name: str
    # Close + sign-off
    closed_at_label: str | None = None
    closed_by_name: str | None = None
    signed_off_at_label: str | None = None
    signed_off_by_name: str | None = None
    review_status: str | None = None           # "signed_off" | "open" | None
    review_summary: str | None = None
    # Close-review counts
    high_count: int = 0
    review_count: int = 0
    info_count: int = 0
    cleared_count: int = 0
    checks_run: int = 0
    passed: list[str] = field(default_factory=list)
    # Recon + flux roll-ups
    recon_total: int = 0
    recon_reconciled: int = 0
    recon_approved: int = 0
    flux_total: int = 0
    flux_material: int = 0
    flux_approved: int = 0


@dataclass
class TocEntry:
    title: str
    page: int          # binder page number (1-based, continuous)
    note: str = ""     # right-hand detail, e.g. "12 accounts"


@dataclass
class AuditRow:
    ts: str
    user: str
    action: str
    summary: str


# ── Small helpers ────────────────────────────────────────────────────────────
def _label(text: str, color: colors.Color = GREY_MID) -> ParagraphStyle:
    return ParagraphStyle("lab", fontName="Helvetica-Bold", fontSize=6.5,
                          leading=9, textColor=color)


def _tile(label: str, value: str, value_color: colors.Color = INK,
          sub: str = "") -> Table:
    """One stat tile: tiny label, big value, optional sub-line."""
    lab = ParagraphStyle("tl", fontName="Helvetica-Bold", fontSize=6.5,
                         leading=9, textColor=GREY_MID)
    val = ParagraphStyle("tv", fontName="Helvetica-Bold", fontSize=15,
                         leading=18, textColor=value_color)
    subs = ParagraphStyle("ts", fontName="Helvetica", fontSize=7.5,
                          leading=10, textColor=GREY_MID)
    rows = [[Paragraph(label.upper(), lab)], [Paragraph(value, val)]]
    if sub:
        rows.append([Paragraph(sub, subs)])
    t = Table(rows, colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CARD_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, 0), 9),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 9),
        ("TOPPADDING", (0, 1), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 1),
    ]))
    return t


def _tile_row(tiles: list[Table], body_w: float, gap: float = 8) -> Table:
    """Lay tiles out as one row with gaps between them."""
    n = len(tiles)
    if n == 0:
        return Spacer(1, 0)
    cw = (body_w - (n - 1) * gap) / n
    cells: list = []
    widths: list[float] = []
    for i, t in enumerate(tiles):
        cells.append(t)
        widths.append(cw)
        if i < n - 1:
            cells.append("")
            widths.append(gap)
    row = Table([cells], colWidths=widths)
    row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return row


def _signoff_block(title: str, name: str | None, when: str | None,
                   *, ok: bool, missing_text: str) -> Table:
    """A 'Books closed' / 'Reviewed & signed off' attestation box."""
    lab = ParagraphStyle("sl", fontName="Helvetica-Bold", fontSize=7,
                         leading=10, textColor=GREEN if ok else AMBER)
    nm = ParagraphStyle("sn", fontName="Helvetica-Bold", fontSize=12,
                        leading=15, textColor=INK)
    dt = ParagraphStyle("sd", fontName="Helvetica", fontSize=8.5,
                        leading=12, textColor=GREY_MID)
    if ok and name:
        body = [[Paragraph(title.upper(), lab)],
                [Paragraph(name, nm)],
                [Paragraph(when or "", dt)]]
    else:
        body = [[Paragraph(title.upper(), lab)],
                [Paragraph(missing_text, ParagraphStyle(
                    "sm", fontName="Helvetica-Oblique", fontSize=10,
                    leading=14, textColor=AMBER))]]
    t = Table(body, colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN_TINT if ok else colors.HexColor("#FBF3E6")),
        ("BOX", (0, 0), (-1, -1), 0.5, GREEN if ok else colors.HexColor("#E7D2A6")),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, 0), 10),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 11),
        ("TOPPADDING", (0, 1), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
    ]))
    return t


# ── Cover (canvas-drawn page 1) ──────────────────────────────────────────────
def _draw_cover(canvas, ctx: BinderContext) -> None:
    canvas.saveState()
    band_h = 3.05 * inch
    band_y = _PAGE_H - band_h
    canvas.setFillColor(PINE)
    canvas.rect(0, band_y, _PAGE_W, band_h, stroke=0, fill=1)

    canvas.setFillColor(SAGE)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(_MARGIN, _PAGE_H - 0.92 * inch,
                      f"NORDAVIX   {_DOT}   MONTH-END CLOSE")

    canvas.setFillColor(CREAM)
    canvas.setFont("Helvetica-Bold", 40)
    canvas.drawString(_MARGIN, _PAGE_H - 1.78 * inch, "Close Binder")

    canvas.setFont("Helvetica", 15)
    canvas.drawString(_MARGIN, _PAGE_H - 2.16 * inch, ctx.company[:64])

    canvas.setFillColor(SAGE)
    canvas.setFont("Helvetica-Bold", 12)
    canvas.drawString(_MARGIN, _PAGE_H - 2.46 * inch,
                      f"{ctx.period_label}   {_DOT}   period ended {_fmt_date_long(ctx.period_end)}")

    # Status chip just below the band
    chip_y = band_y - 0.62 * inch
    locked = ctx.review_status == "signed_off"
    chip_txt = "LOCKED  &  SIGNED OFF" if locked else "LOCKED"
    canvas.setFillColor(GREEN_TINT)
    canvas.roundRect(_MARGIN, chip_y, 2.35 * inch, 0.34 * inch, 6, stroke=0, fill=1)
    canvas.setFillColor(GREEN)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(_MARGIN + 12, chip_y + 0.115 * inch, chip_txt)

    # Two attestation columns
    col_l = _MARGIN
    col_r = _MARGIN + 3.4 * inch
    meta_y = chip_y - 0.5 * inch

    def stamp(x, label, name, when, ok):
        canvas.setFillColor(GREEN if ok else AMBER)
        canvas.setFont("Helvetica-Bold", 7)
        canvas.drawString(x, meta_y, label)
        canvas.setFillColor(INK)
        canvas.setFont("Helvetica-Bold", 11.5)
        canvas.drawString(x, meta_y - 0.22 * inch, (name or "Not recorded")[:38])
        canvas.setFillColor(GREY_MID)
        canvas.setFont("Helvetica", 8.5)
        canvas.drawString(x, meta_y - 0.4 * inch, when or "")

    stamp(col_l, "BOOKS CLOSED", ctx.closed_by_name, ctx.closed_at_label,
          bool(ctx.closed_by_name))
    stamp(col_r, "REVIEWED & SIGNED OFF", ctx.signed_off_by_name,
          ctx.signed_off_at_label, locked)

    # Hairline
    rule_y = meta_y - 0.72 * inch
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.75)
    canvas.line(_MARGIN, rule_y, _PAGE_W - _MARGIN, rule_y)

    # What's inside
    canvas.setFillColor(GREEN)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(_MARGIN, rule_y - 0.34 * inch, "WHAT'S INSIDE")
    inside = [
        "Close certificate — sign-off, findings cleared, checks passed",
        "Financial statements — income statement, balance sheet, cash flow",
        "Reconciliation working papers — one per balance-sheet account",
        "Flux analysis — every material variance, explained",
        "Audit trail — every prepare, approve and sign-off action",
    ]
    canvas.setFont("Helvetica", 10)
    iy = rule_y - 0.62 * inch
    for line in inside:
        canvas.setFillColor(GREEN)
        canvas.drawString(_MARGIN, iy, _DOT)
        canvas.setFillColor(GREY_DARK)
        canvas.drawString(_MARGIN + 0.18 * inch, iy, line)
        iy -= 0.27 * inch

    # Footer line
    canvas.setFillColor(GREY_MID)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(_MARGIN, 0.7 * inch,
                      f"Generated {ctx.generated_at_label} by {ctx.generated_by_name}")
    canvas.drawRightString(_PAGE_W - _MARGIN, 0.7 * inch,
                           "Confidential working papers")
    canvas.restoreState()


# ── Page template plumbing ───────────────────────────────────────────────────
def _content_footer(ctx: BinderContext):
    def on_page(canvas, doc):
        canvas.saveState()
        y = 0.5 * inch
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(_MARGIN, y + 11, _PAGE_W - _MARGIN, y + 11)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(GREY_MID)
        canvas.drawString(_MARGIN, y, f"{ctx.company}   {_DOT}   {ctx.period_label} close binder"[:90])
        canvas.setFillColor(GREEN)
        canvas.drawCentredString(_PAGE_W / 2, y, "Locked · replayable for 7 years")
        canvas.restoreState()
    return on_page


def _make_doc(buffer, ctx: BinderContext, *, title: str, with_cover: bool):
    frame = Frame(_MARGIN, _MARGIN, _BODY_W, _PAGE_H - 2 * _MARGIN - 0.3 * inch,
                  id="body", topPadding=0, bottomPadding=0)
    templates = []
    if with_cover:
        templates.append(PageTemplate(
            id="cover", frames=[frame],
            onPage=lambda c, d: _draw_cover(c, ctx)))
    templates.append(PageTemplate(
        id="content", frames=[frame], onPage=_content_footer(ctx)))
    doc = BaseDocTemplate(
        buffer, pagesize=LETTER, leftMargin=_MARGIN, rightMargin=_MARGIN,
        topMargin=_MARGIN, bottomMargin=_MARGIN,
        title=title, author=ctx.company)
    doc.addPageTemplates(templates)
    return doc


# ── Certificate flowables ────────────────────────────────────────────────────
def _certificate_story(ctx: BinderContext) -> list:
    s = _styles()
    locked = ctx.review_status == "signed_off"
    out: list = []
    out.append(Paragraph("CLOSE CERTIFICATE", s["eyebrow"]))
    out.append(Paragraph("Month-end close, certified", s["title"]))
    attest = (
        f"The books of <b>{ctx.company}</b> for the period ended "
        f"{_fmt_date_long(ctx.period_end)} have been reconciled, reviewed and "
        f"locked. This certificate and the working papers that follow are the "
        f"complete, replayable record of that close."
    )
    out.append(Paragraph(attest, s["lede"]))
    out.append(Spacer(1, 12))

    # Sign-off row
    closed = _signoff_block("Books closed", ctx.closed_by_name, ctx.closed_at_label,
                            ok=bool(ctx.closed_by_name),
                            missing_text="Not recorded")
    signed = _signoff_block("Reviewed & signed off", ctx.signed_off_by_name,
                            ctx.signed_off_at_label, ok=locked,
                            missing_text="Awaiting reviewer sign-off")
    out.append(_tile_row([closed, signed], _BODY_W, gap=12))
    out.append(Spacer(1, 16))

    # Findings
    out.append(Paragraph("Review findings", ParagraphStyle(
        "h", fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=INK,
        spaceAfter=6)))
    high_color = GREEN if ctx.high_count == 0 else RED
    out.append(_tile_row([
        _tile("High severity", str(ctx.high_count), high_color,
              sub="none outstanding" if ctx.high_count == 0 else "must resolve"),
        _tile("To review", str(ctx.review_count), INK),
        _tile("Informational", str(ctx.info_count), GREY_DARK),
        _tile("Cleared", str(ctx.cleared_count), GREEN),
    ], _BODY_W))
    out.append(Spacer(1, 8))

    if ctx.passed:
        chips = "   ".join(f"<font color='#3E8F66'>{_DOT}</font> {c}" for c in ctx.passed[:14])
        out.append(Paragraph(
            f"<b>{ctx.checks_run} checks run.</b> Passed: {chips}",
            ParagraphStyle("pc", fontName="Helvetica", fontSize=8.5, leading=14,
                           textColor=GREY_DARK)))
        out.append(Spacer(1, 14))
    elif ctx.checks_run:
        out.append(Paragraph(f"<b>{ctx.checks_run} checks run.</b>", s["body"]))
        out.append(Spacer(1, 14))

    # Recon + flux roll-up
    out.append(Paragraph("Close coverage", ParagraphStyle(
        "h2", fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=INK,
        spaceAfter=6)))
    out.append(_tile_row([
        _tile("Accounts reconciled", f"{ctx.recon_reconciled}/{ctx.recon_total}", INK),
        _tile("Accounts approved", f"{ctx.recon_approved}/{ctx.recon_total}", GREEN),
        _tile("Variances reviewed", str(ctx.flux_total), INK,
              sub=f"{ctx.flux_material} material"),
        _tile("Variances approved", f"{ctx.flux_approved}/{ctx.flux_total}", GREEN),
    ], _BODY_W))

    if ctx.review_summary:
        out.append(Spacer(1, 16))
        out.append(_Hairline(BORDER))
        out.append(Spacer(1, 8))
        out.append(Paragraph("Reviewer summary", ParagraphStyle(
            "rs", fontName="Helvetica-Bold", fontSize=8, leading=11,
            textColor=GREEN, spaceAfter=4)))
        out.append(Paragraph(ctx.review_summary, s["body"]))
    return out


# ── TOC flowables ────────────────────────────────────────────────────────────
def _toc_story(ctx: BinderContext, entries: list[TocEntry]) -> list:
    s = _styles()
    out: list = [Paragraph("CONTENTS", s["eyebrow"]),
                 Paragraph("What's inside", s["title"]), Spacer(1, 12)]
    title_st = ParagraphStyle("tt", fontName="Helvetica-Bold", fontSize=10.5,
                              leading=15, textColor=INK)
    note_st = ParagraphStyle("tn", fontName="Helvetica", fontSize=8.5,
                             leading=15, textColor=GREY_MID)
    pg_st = ParagraphStyle("tp", fontName="Helvetica-Bold", fontSize=10.5,
                           leading=15, textColor=GREEN, alignment=2)
    rows = []
    for e in entries:
        left = Paragraph(e.title, title_st)
        mid = Paragraph(e.note, note_st)
        right = Paragraph(str(e.page), pg_st)
        rows.append([left, mid, right])
    t = Table(rows, colWidths=[_BODY_W * 0.52, _BODY_W * 0.36, _BODY_W * 0.12])
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, BORDER),
    ]
    t.setStyle(TableStyle(style))
    out.append(t)
    return out


# ── Public: front matter (cover + certificate + TOC) ─────────────────────────
def render_front_matter(buffer, *, ctx: BinderContext,
                        toc_entries: list[TocEntry]) -> None:
    doc = _make_doc(buffer, ctx,
                    title=f"Close Binder — {ctx.company} — {ctx.period_end.isoformat()}",
                    with_cover=True)
    story: list = [Spacer(1, 2), NextPageTemplate("content"), PageBreak()]
    story += _certificate_story(ctx)
    story.append(NextPageTemplate("content"))
    story.append(PageBreak())
    story += _toc_story(ctx, toc_entries)
    doc.build(story)


# ── Public: audit appendix ───────────────────────────────────────────────────
def render_audit_appendix(buffer, *, ctx: BinderContext,
                          rows: list[AuditRow], window_from_label: str) -> None:
    doc = _make_doc(buffer, ctx,
                    title=f"Audit Trail — {ctx.company} — {ctx.period_end.isoformat()}",
                    with_cover=False)
    s = _styles()
    story: list = [Paragraph("AUDIT TRAIL", s["eyebrow"]),
                   Paragraph("Every action, time-stamped", s["title"])]
    story.append(Paragraph(
        f"{len(rows)} events from {window_from_label} through "
        f"{_fmt_date_long(ctx.period_end)}. Times shown in UTC.", s["subtitle"]))
    story.append(Spacer(1, 12))

    if not rows:
        story.append(Paragraph("No audit events recorded for this window.",
                               s["oblique"]))
        doc.build(story)
        return

    head = ParagraphStyle("ah", fontName="Helvetica-Bold", fontSize=7.5,
                          leading=10, textColor=colors.white)
    cell = ParagraphStyle("ac", fontName="Helvetica", fontSize=8, leading=11,
                          textColor=GREY_DARK)
    cell_b = ParagraphStyle("acb", fontName="Helvetica-Bold", fontSize=8,
                            leading=11, textColor=INK)
    data = [[Paragraph("TIMESTAMP", head), Paragraph("USER", head),
             Paragraph("ACTION", head), Paragraph("SUMMARY", head)]]
    for r in rows:
        data.append([
            Paragraph(r.ts, cell),
            Paragraph(r.user[:28], cell),
            Paragraph(r.action, cell_b),
            Paragraph(r.summary[:160], cell),
        ])
    t = Table(data, colWidths=[_BODY_W * 0.18, _BODY_W * 0.2, _BODY_W * 0.22,
                               _BODY_W * 0.4], repeatRows=1)
    ts = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, BORDER),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            ts.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#FAF9F6")))
    t.setStyle(TableStyle(ts))
    story.append(t)
    doc.build(story)
