"""The adjustments memo — what was booked, what wasn't, and what it did.

Everything the queue knows lives on a screen only the firm sees. A firm's
deliverable is a document: something handed to a reviewer, a client, an
examiner or the practice that takes this client over in three years. Until now
none of it could leave.

Three sections, and the middle one has no equivalent anywhere:

  Effect      what the approved entries do to the statements. The question a
              reviewer asks first and, on paper, the one nobody could answer
              without re-adding the batch by hand.
  Booked      each entry, with who prepared it, who approved it, and whether
              QuickBooks has been confirmed to contain it.
  Not booked  the uncorrected differences, each with the reason it was passed
              and the total evaluated against materiality. Auditors keep this
              schedule by hand. It has never been a product feature.

Built on the recon design kit so a firm's documents look like one firm's
documents, not a folder of unrelated PDFs.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from xml.sax.saxutils import escape as _esc

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from modules.recons.pdf import (
    BORDER,
    CARD_BG,
    GREY_DARK,
    INK,
    _Hairline,
    _styles,
)

_MARGIN = 0.72 * inch
_PAGE_W, _PAGE_H = LETTER
_BODY_W = _PAGE_W - 2 * _MARGIN
_DOT = "·"


@dataclass
class AdjustmentsMemoContext:
    company: str
    period_label: str
    period_end: date
    generated_at: datetime | None = None
    prepared_by: str | None = None
    # "month" | "ytd" | "unavailable" — printed, because a monthly heading over
    # a year-to-date number is the defect this whole module keeps producing.
    pl_basis: str = "ytd"
    baseline_captured_at: datetime | None = None
    # [{label, before, after, change}] — already formatted by the caller.
    effect_lines: list[dict] = field(default_factory=list)
    booked: list[dict] = field(default_factory=list)
    passed: list[dict] = field(default_factory=list)
    passed_total: str | None = None
    passed_pct_of_income: float | None = None
    materiality_pct: float | None = None
    passed_without_reason: int = 0


def _money(v) -> str:
    try:
        d = Decimal(str(v))
    except Exception:
        return "—"
    sign = "−" if d < 0 else ""
    return f"{sign}{abs(d):,.0f}"


def _table(rows: list[list], widths: list[float], *, right_from: int = 1) -> Table:
    t = Table(rows, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), CARD_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), GREY_DARK),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("TEXTCOLOR", (0, 1), (-1, -1), INK),
        ("ALIGN", (right_from, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def _basis_sentence(ctx: AdjustmentsMemoContext) -> str:
    """Name the basis, always. Read aloud in a review meeting, "revenue
    772,710" means nothing without it."""
    if ctx.pl_basis == "month":
        base = "Profit and loss figures are for this month only"
    elif ctx.pl_basis == "unavailable":
        base = ("Profit and loss could not be shown for the month — the prior "
                "month has not been synced, so there is nothing to measure against")
    else:
        base = "Profit and loss figures are year to date"
    bs = f"; the balance sheet is as at {ctx.period_end.strftime('%d %B %Y')}."
    if ctx.baseline_captured_at:
        bs += (" Figures per QuickBooks are as last read "
               f"{ctx.baseline_captured_at.strftime('%d %B %Y, %H:%M')}.")
    return base + bs


def render_adjustments_memo(ctx: AdjustmentsMemoContext) -> bytes:
    """The memo, as PDF bytes."""
    s = _styles()
    buf = io.BytesIO()
    frame = Frame(_MARGIN, _MARGIN, _BODY_W, _PAGE_H - 2 * _MARGIN - 0.3 * inch,
                  id="body", topPadding=0, bottomPadding=0)
    doc = BaseDocTemplate(
        buf, pagesize=LETTER, leftMargin=_MARGIN, rightMargin=_MARGIN,
        topMargin=_MARGIN, bottomMargin=_MARGIN,
        title=f"Adjustments memo {_DOT} {ctx.period_label}", author=ctx.company)
    doc.addPageTemplates([PageTemplate(id="content", frames=[frame])])

    story: list = []
    story.append(Paragraph("ADJUSTMENTS MEMO", s["eyebrow"]))
    story.append(Paragraph(_esc(ctx.company), s["title"]))
    story.append(Paragraph(
        f"{_esc(ctx.period_label)} {_DOT} period ended {ctx.period_end.strftime('%d %B %Y')}",
        s["subtitle"]))
    story.append(Spacer(1, 6))
    story.append(_Hairline(BORDER))
    story.append(Spacer(1, 12))

    story.append(Paragraph(
        f"{len(ctx.booked)} adjusting entr{'y' if len(ctx.booked) == 1 else 'ies'} "
        f"booked and {len(ctx.passed)} passed for the {_esc(ctx.period_label)} close"
        + (f", prepared by {_esc(ctx.prepared_by)}" if ctx.prepared_by else "")
        + ". Nordavix reads QuickBooks and never writes to it; every entry listed "
          "here was posted by a person.",
        s["body"]))
    story.append(Spacer(1, 4))
    story.append(Paragraph(_basis_sentence(ctx), s["small"] if "small" in s else s["body"]))
    story.append(Spacer(1, 14))

    # ── Effect ───────────────────────────────────────────────────────────
    if ctx.effect_lines:
        story.append(Paragraph("Effect on the financials", s["eyebrow"]))
        rows = [["", "Per QuickBooks", "Adjusted", "Change"]]
        for line in ctx.effect_lines:
            rows.append([
                Paragraph(_esc(str(line.get("label", ""))), s["body"]),
                _money(line.get("before")), _money(line.get("after")),
                _money(line.get("change")),
            ])
        story.append(_table(rows, [2.5 * inch, 1.4 * inch, 1.4 * inch, 1.2 * inch]))
        story.append(Spacer(1, 14))

    # ── Booked ───────────────────────────────────────────────────────────
    story.append(Paragraph("Entries booked", s["eyebrow"]))
    if ctx.booked:
        rows = [["Entry", "Prepared", "Approved", "In QuickBooks", "Amount"]]
        for e in ctx.booked:
            rows.append([
                Paragraph(_esc(str(e.get("description", ""))), s["body"]),
                Paragraph(_esc(str(e.get("prepared_by") or "Nordavix")), s["body"]),
                Paragraph(_esc(str(e.get("approved_by") or "—")), s["body"]),
                Paragraph(_esc(str(e.get("posted_qbo_doc") or "not confirmed")), s["body"]),
                _money(e.get("amount")),
            ])
        story.append(_table(rows, [2.3 * inch, 1.1 * inch, 1.1 * inch, 1.1 * inch, 0.9 * inch],
                            right_from=4))
    else:
        story.append(Paragraph("No entries were booked for this period.", s["body"]))
    story.append(Spacer(1, 14))

    # ── Not booked — the schedule auditors keep by hand ───────────────────
    story.append(Paragraph("Differences not booked", s["eyebrow"]))
    if ctx.passed:
        story.append(Paragraph(
            "Each of these was identified and deliberately not recorded. Individually "
            "immaterial, which is why they were passed — evaluated together below.",
            s["body"]))
        story.append(Spacer(1, 8))
        rows = [["Difference", "Reason it was not booked", "Amount"]]
        for e in ctx.passed:
            rows.append([
                Paragraph(_esc(str(e.get("description", ""))), s["body"]),
                Paragraph(_esc(str(e.get("reason") or "No reason recorded")), s["body"]),
                _money(e.get("amount")),
            ])
        story.append(_table(rows, [2.4 * inch, 2.6 * inch, 1.0 * inch], right_from=2))
        story.append(Spacer(1, 10))

        if ctx.passed_total is not None:
            verdict = (
                f"Together these would move net income by {_money(ctx.passed_total)}"
            )
            if ctx.passed_pct_of_income is not None and ctx.materiality_pct is not None:
                over = ctx.passed_pct_of_income > ctx.materiality_pct
                verdict += (
                    f" — {ctx.passed_pct_of_income:.1f}% of the adjusted figure, against a "
                    f"threshold of {ctx.materiality_pct:.0f}%. "
                    + ("This exceeds the threshold and was accepted by the reviewer."
                       if over else "This is below the threshold.")
                )
            else:
                verdict += "."
            story.append(Paragraph(verdict, s["body"]))
        if ctx.passed_without_reason:
            story.append(Spacer(1, 6))
            story.append(Paragraph(
                ("One of these carries no recorded reason."
                 if ctx.passed_without_reason == 1
                 else f"{ctx.passed_without_reason} of these carry no recorded reason."),
                s["body"]))
    else:
        story.append(Paragraph(
            "Every difference identified for this period was booked.", s["body"]))

    doc.build(story)
    return buf.getvalue()
