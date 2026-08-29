"""The Close Review memo — the reviewing partner's deliverable.

The page has always described itself as "an AI reviewing partner checks the
close and hands you a sign-off memo". It handed you a status column. This is
the memo: what was examined, what it found, what was decided about each
exception and by whom, what passed, and the signature under it.

Written to be read by someone who was not there — a partner reviewing the
reviewer, a client asking what was done, an inspector a year later. So every
exception carries its disposition, the person who made it, when, and the reason
they gave. A cleared exception with no reason is the one thing this document
exists to make impossible.

Shares the recon packet's design kit (palette, styles, hairline, footer) so a
memo filed next to a reconciliation packet reads as the same firm's paper.

WinAnsi-safe glyphs only (ReportLab base-14 Helvetica): no check-marks, no
em-dash surprises. The middle dot below is the safe one.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import date, datetime
from xml.sax.saxutils import escape as _esc

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from modules.recons.pdf import (
    BORDER,
    CARD_BG,
    GREEN,
    GREEN_TINT,
    GREY_DARK,
    GREY_MID,
    INK,
    RED,
    _Hairline,
    _styles,
)

AMBER = colors.HexColor("#B45309")
AMBER_TINT = colors.HexColor("#FBF3E6")

_MARGIN = 0.72 * inch
_PAGE_W, _PAGE_H = LETTER
_BODY_W = _PAGE_W - 2 * _MARGIN
_DOT = "·"

_SEV_COLOR = {"high": RED, "review": AMBER, "info": GREY_MID}
_SEV_LABEL = {"high": "High", "review": "Review", "info": "Info"}
_STATUS_LABEL = {
    "open": "Open", "cleared": "Cleared", "accepted": "Accepted",
    "actioned": "Actioned",
}
_CATEGORY_LABEL = {
    "control": "Control", "completeness": "Completeness",
    "analytical": "Analytical", "anomaly": "Anomaly", "hygiene": "Hygiene",
}


@dataclass
class MemoFinding:
    severity: str
    category: str
    title: str
    detail: str
    status: str
    account_label: str | None = None
    note: str | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    first_seen_at: datetime | None = None


@dataclass
class MemoContext:
    company: str
    period_label: str
    period_end: date
    generated_at: datetime | None
    checks_run: int
    summary: str | None
    passed: list[str] = field(default_factory=list)
    open_findings: list[MemoFinding] = field(default_factory=list)
    resolved_findings: list[MemoFinding] = field(default_factory=list)
    signed_off_by: str | None = None
    signed_off_at: datetime | None = None
    signoff_note: str | None = None
    new_count: int = 0
    resolved_count: int = 0


def _when(dt: datetime | None) -> str:
    return dt.strftime("%d %b %Y, %H:%M UTC") if dt else ""


def _footer(ctx: MemoContext):
    def on_page(canvas, doc):
        canvas.saveState()
        y = 0.5 * inch
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(_MARGIN, y + 11, _PAGE_W - _MARGIN, y + 11)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(GREY_MID)
        canvas.drawString(_MARGIN, y,
                          f"{ctx.company}   {_DOT}   {ctx.period_label} close review memo"[:90])
        canvas.drawRightString(_PAGE_W - _MARGIN, y, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()
    return on_page


def _kv_row(pairs: list[tuple[str, str]]) -> Table:
    """A row of label/value tiles across the body width."""
    lab = ParagraphStyle("kl", fontName="Helvetica-Bold", fontSize=7, leading=9,
                         textColor=GREY_MID)
    val = ParagraphStyle("kv", fontName="Helvetica-Bold", fontSize=13, leading=16,
                         textColor=INK)
    cells = [[Paragraph(_esc(k.upper()), lab), Paragraph(_esc(v), val)] for k, v in pairs]
    inner = [Table([[c[0]], [c[1]]], colWidths=[None]) for c in cells]
    for t in inner:
        t.setStyle(TableStyle([
            ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, 0), 9), ("BOTTOMPADDING", (0, -1), (-1, -1), 9),
            ("TOPPADDING", (0, 1), (-1, 1), 1), ("BOTTOMPADDING", (0, 0), (-1, 0), 1),
            ("BACKGROUND", (0, 0), (-1, -1), CARD_BG),
            ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ]))
    w = (_BODY_W - 8 * (len(inner) - 1)) / max(1, len(inner))
    outer = Table([inner], colWidths=[w] * len(inner))
    outer.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return outer


def _finding_block(f: MemoFinding, s: dict) -> KeepTogether:
    """One exception: what it is, and what was decided about it.

    Kept together so a disposition never lands on a different page from the
    finding it disposes of — the single formatting rule that matters in a
    document someone may have to defend line by line.
    """
    sev = _SEV_COLOR.get(f.severity, GREY_MID)
    head = ParagraphStyle("fh", fontName="Helvetica-Bold", fontSize=10, leading=13,
                          textColor=INK)
    chip = ParagraphStyle("fc", fontName="Helvetica-Bold", fontSize=7, leading=9,
                          textColor=sev)
    body = ParagraphStyle("fb", fontName="Helvetica", fontSize=8.5, leading=12,
                          textColor=GREY_DARK)
    meta = ParagraphStyle("fm", fontName="Helvetica", fontSize=7.5, leading=10.5,
                          textColor=GREY_MID)

    tag = f"{_SEV_LABEL.get(f.severity, f.severity).upper()}  {_DOT}  " \
          f"{_CATEGORY_LABEL.get(f.category, f.category).upper()}"
    rows: list[list] = [[Paragraph(_esc(tag), chip)],
                        [Paragraph(_esc(f.title), head)]]
    if f.account_label:
        rows.append([Paragraph(_esc(f.account_label), meta)])
    if f.detail:
        rows.append([Paragraph(_esc(f.detail), body)])

    # The disposition. This is the part a reviewer of the reviewer reads.
    if f.status == "open":
        disp = "<b>Open</b> at sign-off."
    else:
        who = f" by {_esc(f.decided_by)}" if f.decided_by else ""
        when = f" on {_when(f.decided_at)}" if f.decided_at else ""
        disp = f"<b>{_STATUS_LABEL.get(f.status, f.status)}</b>{who}{when}."
        disp += (f" Reason: {_esc(f.note)}" if f.note
                 else " <i>No reason recorded.</i>")
    rows.append([Paragraph(disp, meta)])

    t = Table(rows, colWidths=[_BODY_W])
    t.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 11), ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, 0), 8), ("BOTTOMPADDING", (0, -1), (-1, -1), 9),
        ("TOPPADDING", (0, 1), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -2), 2),
        ("BACKGROUND", (0, 0), (-1, -1), CARD_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, BORDER),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, sev),
    ]))
    return KeepTogether([t, Spacer(1, 7)])


def _signature(ctx: MemoContext, s: dict) -> Table:
    ok = ctx.signed_off_by is not None
    lab = ParagraphStyle("sl", fontName="Helvetica-Bold", fontSize=7, leading=10,
                         textColor=GREEN if ok else AMBER)
    nm = ParagraphStyle("sn", fontName="Helvetica-Bold", fontSize=13, leading=16,
                        textColor=INK)
    dt = ParagraphStyle("sd", fontName="Helvetica", fontSize=8.5, leading=12,
                        textColor=GREY_MID)
    note = ParagraphStyle("sx", fontName="Helvetica-Oblique", fontSize=9, leading=13,
                          textColor=GREY_DARK)
    if ok:
        rows = [[Paragraph("REVIEWED AND SIGNED OFF", lab)],
                [Paragraph(_esc(ctx.signed_off_by or ""), nm)],
                [Paragraph(_esc(_when(ctx.signed_off_at)), dt)]]
        if ctx.signoff_note:
            rows.append([Spacer(1, 4)])
            rows.append([Paragraph(_esc(ctx.signoff_note), note)])
    else:
        rows = [[Paragraph("NOT YET SIGNED OFF", lab)],
                [Paragraph("This review is still open. The memo below reflects "
                           "its state at the time it was generated.", note)]]
    t = Table(rows, colWidths=[_BODY_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN_TINT if ok else AMBER_TINT),
        ("BOX", (0, 0), (-1, -1), 0.5, GREEN if ok else colors.HexColor("#E7D2A6")),
        ("LEFTPADDING", (0, 0), (-1, -1), 14), ("RIGHTPADDING", (0, 0), (-1, -1), 14),
        ("TOPPADDING", (0, 0), (-1, 0), 12), ("BOTTOMPADDING", (0, -1), (-1, -1), 13),
        ("TOPPADDING", (0, 1), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -2), 2),
    ]))
    return t


def render_review_memo(ctx: MemoContext) -> bytes:
    """The memo, as PDF bytes."""
    s = _styles()
    buf = io.BytesIO()
    frame = Frame(_MARGIN, _MARGIN, _BODY_W, _PAGE_H - 2 * _MARGIN - 0.3 * inch,
                  id="body", topPadding=0, bottomPadding=0)
    doc = BaseDocTemplate(
        buf, pagesize=LETTER, leftMargin=_MARGIN, rightMargin=_MARGIN,
        topMargin=_MARGIN, bottomMargin=_MARGIN,
        title=f"Close review memo {_DOT} {ctx.period_label}", author=ctx.company)
    doc.addPageTemplates([PageTemplate(id="content", frames=[frame], onPage=_footer(ctx))])

    story: list = []
    story.append(Paragraph("CLOSE REVIEW MEMO", s["eyebrow"]))
    story.append(Paragraph(_esc(ctx.company), s["title"]))
    story.append(Paragraph(
        f"{_esc(ctx.period_label)} {_DOT} period ended {ctx.period_end.strftime('%d %B %Y')}",
        s["subtitle"]))
    story.append(Spacer(1, 6))
    story.append(_Hairline(BORDER))
    story.append(Spacer(1, 12))

    story.append(_signature(ctx, s))
    story.append(Spacer(1, 14))

    # Scope — what was examined, stated plainly, because a memo that only lists
    # problems doesn't say what was looked at.
    story.append(Paragraph("Scope", s["eyebrow"]))
    total_open = len(ctx.open_findings)
    total_res = len(ctx.resolved_findings)
    story.append(Paragraph(
        f"Nordavix ran {ctx.checks_run} deterministic checks across reconciliation "
        f"controls, completeness, analytical review, anomalies and hygiene over the "
        f"{_esc(ctx.period_label)} close"
        + (f", generated {_when(ctx.generated_at)}" if ctx.generated_at else "")
        + f". It raised {total_open + total_res} exception"
        + ("" if (total_open + total_res) == 1 else "s")
        + f", of which {total_res} were dispositioned and {total_open} remained open. "
        + "Nordavix reads QuickBooks and never writes to it; every correction "
          "recorded here was made by a person.",
        s["body"]))
    story.append(Spacer(1, 10))
    story.append(_kv_row([
        ("Checks run", str(ctx.checks_run)),
        ("Exceptions", str(total_open + total_res)),
        ("Dispositioned", str(total_res)),
        ("Open", str(total_open)),
    ]))
    story.append(Spacer(1, 14))

    if ctx.summary:
        story.append(Paragraph("Analytical review", s["eyebrow"]))
        story.append(Paragraph(_esc(ctx.summary), s["body"]))
        story.append(Spacer(1, 12))

    if ctx.open_findings:
        story.append(Paragraph("Exceptions open at sign-off", s["eyebrow"]))
        story.append(Spacer(1, 4))
        for f in ctx.open_findings:
            story.append(_finding_block(f, s))
        story.append(Spacer(1, 6))

    if ctx.resolved_findings:
        story.append(Paragraph("Exceptions and their disposition", s["eyebrow"]))
        story.append(Spacer(1, 4))
        for f in ctx.resolved_findings:
            story.append(_finding_block(f, s))
        story.append(Spacer(1, 6))

    if not ctx.open_findings and not ctx.resolved_findings:
        story.append(Paragraph("Exceptions", s["eyebrow"]))
        story.append(Paragraph("No exceptions were raised.", s["body"]))
        story.append(Spacer(1, 10))

    if ctx.passed:
        story.append(Paragraph("Checks passed", s["eyebrow"]))
        for p in ctx.passed:
            story.append(Paragraph(f"{_DOT} {_esc(p)}", s["body"]))
        story.append(Spacer(1, 10))

    story.append(_Hairline(BORDER))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Prepared by Nordavix. The checks are deterministic and re-runnable; the "
        "analytical narrative is AI-assisted and was reviewed by the signatory. "
        "This memo is not an audit and does not constitute an audit opinion.",
        s["oblique"]))

    doc.build(story)
    return buf.getvalue()
