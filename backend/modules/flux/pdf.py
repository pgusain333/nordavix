"""
Per-variance flux analysis PDF — "variance working paper" layout.

One working paper for a single account's period-over-period movement:
a slim top bar, a green eyebrow, the account title, a four-card meta row,
the variance summary (prior / current / change as three big numbers), the
AI variance bridge (drivers + explained/unexplained tie-out), the AI
assessment (narrative, risk, justification, key entities, recommendations),
the supporting QBO transactions, and the approval sign-off.

Deliberately shares its design DNA with modules/recons/pdf.py — same
palette, formatters, hairlines, footer band, and DRAFT watermark — so a
close binder assembled from both reads as one document set, not two tools.

WinAnsi-safe glyphs only (ReportLab base-14 Helvetica): plain text,
en-dashes, ASCII +/- — no arrows or U+2212.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Any, BinaryIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
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

# Shared visual vocabulary — single source of truth for the packet look.
from modules.recons.pdf import (
    BORDER,
    CARD_BG,
    GREEN,
    GREEN_TINT,
    GREY_DARK,
    GREY_MID,
    INK,
    RED,
    ZEBRA,
    _fmt_date,
    _fmt_money,
    _fmt_ts,
    _Hairline,
    _period_label,
    _styles,
    _to_decimal,
)

_RISK = {
    "high":   ("High risk",   RED),
    "medium": ("Medium risk", colors.HexColor("#B45309")),
    "low":    ("Low risk",    GREEN),
}
_JUSTIFIED = {
    "yes":          ("Justified", GREEN),
    "no":           ("Not justified", RED),
    "needs_review": ("Needs review", colors.HexColor("#B45309")),
}
_STATUS = {
    "approved": ("Approved", GREEN),
    "edited":   ("Reviewed - edited", colors.HexColor("#B45309")),
    "flagged":  ("Flagged", RED),
    "pending":  ("Open", GREY_MID),
}


def _fmt_pct(v: Any) -> str:
    d = _to_decimal(v, default="0")
    if d == 0:
        return "n/a"
    return f"{d:+.1f}%"


def _signed_driver(amount: Any, direction: str) -> Decimal:
    raw = abs(_to_decimal(amount))
    return raw if direction == "increase" else -raw


# ── Page template (footer, watermark — NO logo) ─────────────────────────────
def _make_doc(buffer: BinaryIO, *, company: str, account_label: str,
              doc_ref: str, period_end: date, is_draft: bool) -> BaseDocTemplate:
    margin = 0.72 * inch
    page_w, page_h = LETTER
    frame = Frame(margin, margin, page_w - 2 * margin, page_h - 2 * margin - 0.35 * inch,
                  id="body", topPadding=0, bottomPadding=0)

    def on_page(canvas, doc):
        canvas.saveState()
        if is_draft:
            canvas.setFont("Helvetica-Bold", 100)
            canvas.setFillColor(colors.Color(0.86, 0.86, 0.86, alpha=0.42))
            canvas.translate(page_w / 2, page_h / 2)
            canvas.rotate(45)
            canvas.drawCentredString(0, 0, "DRAFT")
            canvas.restoreState()
            canvas.saveState()
        y = 0.42 * inch
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(margin, y + 12, page_w - margin, y + 12)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(GREY_MID)
        canvas.drawString(margin, y, f"{company} · {account_label}"[:88])
        canvas.setFillColor(GREEN)
        canvas.drawCentredString(page_w / 2, y, "AI-prepared · human-approved")
        canvas.setFillColor(GREY_MID)
        canvas.drawRightString(page_w - margin, y, f"Page {canvas.getPageNumber()} · {doc_ref}")
        canvas.restoreState()

    tpl = PageTemplate(id="body", frames=[frame], onPage=on_page)
    doc = BaseDocTemplate(buffer, pagesize=LETTER, leftMargin=margin, rightMargin=margin,
                          topMargin=margin, bottomMargin=margin,
                          title=f"Flux Analysis · {account_label} · {period_end.isoformat()}",
                          author=company)
    doc.addPageTemplates([tpl])
    return doc


def _sx(**k) -> ParagraphStyle:
    return ParagraphStyle("x", **k)


# ── Meta card row ────────────────────────────────────────────────────────────
def _meta_cards(data: dict, body_w: float) -> Table:
    lab = _sx(fontName="Helvetica-Bold", fontSize=6.5, leading=9, textColor=GREY_MID)
    val = _sx(fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=INK)

    status_label, status_color = _STATUS.get(data["status"], (data["status"].title(), GREY_MID))
    ai = data.get("ai_commentary") or {}
    risk_label, risk_color = _RISK.get(ai.get("risk_level", ""), ("Not analyzed", GREY_MID))

    cells = [
        ("PERIOD",      _period_label(data["period_current"]), INK),
        ("COMPARATIVE", _period_label(data["period_prior"]),   INK),
        ("STATUS",      status_label,                          status_color),
        ("AI RISK",     risk_label,                            risk_color),
    ]
    row = [
        Table(
            [[Paragraph(c[0].upper(), lab)], [Paragraph(c[1], _sx(parent=val, textColor=c[2]))]],
            colWidths=[body_w / 4 - 8],
            style=TableStyle([
                ("BACKGROUND",   (0, 0), (-1, -1), CARD_BG),
                ("BOX",          (0, 0), (-1, -1), 0.75, BORDER),
                ("LEFTPADDING",  (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING",   (0, 0), (0, 0), 7),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 8),
            ]),
        )
        for c in cells
    ]
    return Table([row], colWidths=[body_w / 4] * 4,
                 style=TableStyle([
                     ("LEFTPADDING",  (0, 0), (-1, -1), 0),
                     ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                     ("TOPPADDING",   (0, 0), (-1, -1), 0),
                     ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                 ]))


# ── Variance summary: prior / current / change ───────────────────────────────
def _summary_band(data: dict, body_w: float) -> Table:
    lab = _sx(fontName="Helvetica-Bold", fontSize=6.5, leading=9, textColor=GREY_MID)
    big = _sx(fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=INK)
    sub = _sx(fontName="Helvetica", fontSize=8, leading=11, textColor=GREY_MID)

    change = _to_decimal(data["dollar_variance"])
    change_color = GREEN if change > 0 else (RED if change < 0 else GREY_MID)

    def cell(label: str, value: str, value_color, sub_text: str, highlight: bool = False):
        return Table(
            [
                [Paragraph(label, lab)],
                [Paragraph(value, _sx(parent=big, textColor=value_color))],
                [Paragraph(sub_text, sub)],
            ],
            colWidths=[body_w / 3 - 8],
            style=TableStyle([
                ("BACKGROUND",   (0, 0), (-1, -1), GREEN_TINT if highlight else CARD_BG),
                ("BOX",          (0, 0), (-1, -1), 0.75, GREEN if highlight else BORDER),
                ("LEFTPADDING",  (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING",   (0, 0), (0, 0), 8),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 9),
            ]),
        )

    cells = [
        cell(f"BALANCE · {_period_label(data['period_prior']).upper()}",
             _fmt_money(data["prior_balance"]), INK, "Comparative period"),
        cell(f"BALANCE · {_period_label(data['period_current']).upper()}",
             _fmt_money(data["current_balance"]), INK, "Current period"),
        cell("CHANGE", _fmt_money(change), change_color,
             f"{_fmt_pct(data.get('pct_variance'))} vs comparative"
             + (" · material" if data.get("is_material") else ""),
             highlight=True),
    ]
    return Table([cells], colWidths=[body_w / 3] * 3,
                 style=TableStyle([
                     ("LEFTPADDING",  (0, 0), (-1, -1), 0),
                     ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                     ("TOPPADDING",   (0, 0), (-1, -1), 0),
                     ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                 ]))


def _section(title: str) -> list:
    h = _sx(fontName="Helvetica-Bold", fontSize=10.5, leading=14, textColor=INK,
            spaceBefore=2, spaceAfter=0)
    return [Spacer(0, 16), Paragraph(title, h), Spacer(0, 5), _Hairline(BORDER), Spacer(0, 8)]


# ── Drivers bridge ───────────────────────────────────────────────────────────
def _drivers_table(ai: dict, dollar_variance: Decimal, body_w: float) -> Table:
    name_s  = _sx(fontName="Helvetica", fontSize=9, leading=12, textColor=GREY_DARK)
    amt_s   = _sx(fontName="Helvetica-Bold", fontSize=9, leading=12, alignment=2)
    tot_s   = _sx(fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=INK)

    rows: list[list] = []
    drivers = ai.get("drivers") or []
    explained = Decimal("0")
    for d in drivers:
        signed = _signed_driver(d.get("amount"), d.get("direction", "increase"))
        explained += signed
        color = GREEN if signed > 0 else (RED if signed < 0 else GREY_MID)
        sign = "+" if signed > 0 else "-"
        rows.append([
            Paragraph(str(d.get("label", ""))[:90], name_s),
            Paragraph(f"{sign} {_fmt_money(abs(signed))[1:]}", _sx(parent=amt_s, textColor=color)),
        ])

    unexplained = (
        _to_decimal(ai["unexplained_amount"]) if ai.get("unexplained_amount") not in (None, "")
        else dollar_variance - explained
    )
    rows.append([Paragraph("Explained by drivers", tot_s),
                 Paragraph(_fmt_money(explained), _sx(parent=amt_s, textColor=INK))])
    rows.append([
        Paragraph("Unexplained residual", _sx(parent=name_s,
                  textColor=RED if abs(unexplained) > Decimal("1") else GREY_MID)),
        Paragraph(_fmt_money(unexplained), _sx(
            parent=amt_s, textColor=RED if abs(unexplained) > Decimal("1") else GREY_MID)),
    ])
    rows.append([Paragraph("= Total change", tot_s),
                 Paragraph(_fmt_money(dollar_variance), _sx(parent=amt_s, textColor=INK))])

    n = len(rows)
    style = [
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW",     (0, 0), (-1, n - 4), 0.5, BORDER),
        ("LINEABOVE",     (0, n - 3), (-1, n - 3), 0.75, GREY_MID),   # above Explained
        ("LINEABOVE",     (0, n - 1), (-1, n - 1), 1.0, INK),          # above Total
        ("BACKGROUND",    (0, n - 1), (-1, n - 1), CARD_BG),
    ]
    for i in range(max(0, n - 3)):
        if i % 2 == 1:
            style.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    return Table(rows, colWidths=[body_w - 1.5 * inch, 1.5 * inch], style=TableStyle(style))


# ── Transactions table ───────────────────────────────────────────────────────
def _txn_table(txns: list[dict], dollar_variance: Decimal, body_w: float) -> Table:
    head_s = _sx(fontName="Helvetica-Bold", fontSize=7, leading=10, textColor=GREY_MID)
    cell_s = _sx(fontName="Helvetica", fontSize=8.2, leading=11, textColor=GREY_DARK)
    amt_s  = _sx(fontName="Helvetica", fontSize=8.2, leading=11, alignment=2)

    header = [Paragraph(h, head_s) for h in
              ["DATE", "TYPE", "REF", "COUNTERPARTY", "MEMO", "REV'D", "AMOUNT"]]
    rows: list[list] = [header]
    total = Decimal("0")
    for t in txns:
        amt = _to_decimal(t.get("amount"))
        total += amt
        rows.append([
            Paragraph(_fmt_date(t.get("txn_date")), cell_s),
            Paragraph(str(t.get("txn_type") or "")[:18], cell_s),
            Paragraph(str(t.get("txn_number") or "")[:14], cell_s),
            Paragraph(str(t.get("entity_name") or "")[:34], cell_s),
            Paragraph(str(t.get("memo") or "")[:48], cell_s),
            Paragraph("x" if t.get("is_checked") else "", _sx(
                parent=cell_s, alignment=1, textColor=GREEN, fontName="Helvetica-Bold")),
            Paragraph(_fmt_money(amt), _sx(
                parent=amt_s, textColor=GREEN if amt > 0 else (RED if amt < 0 else GREY_MID))),
        ])
    rows.append([
        Paragraph("Total of listed transactions", _sx(
            fontName="Helvetica-Bold", fontSize=8.4, leading=11, textColor=INK)),
        "", "", "", "", "",
        Paragraph(_fmt_money(total), _sx(
            parent=amt_s, fontName="Helvetica-Bold", textColor=INK)),
    ])

    n = len(rows)
    w = body_w
    col_w = [0.62 * inch, 0.72 * inch, 0.55 * inch, 1.35 * inch,
             w - (0.62 + 0.72 + 0.55 + 1.35 + 0.42 + 0.95) * inch, 0.42 * inch, 0.95 * inch]
    style = [
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW",     (0, 0), (-1, 0), 0.75, GREY_MID),
        ("LINEABOVE",     (0, n - 1), (-1, n - 1), 1.0, INK),
        ("SPAN",          (0, n - 1), (5, n - 1)),
        ("BACKGROUND",    (0, n - 1), (-1, n - 1), CARD_BG),
    ]
    for i in range(1, n - 1):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    return Table(rows, colWidths=col_w, repeatRows=1, style=TableStyle(style))


# ── Chip row (risk / justified / confidence) ─────────────────────────────────
def _chips(ai: dict) -> Table:
    chip_s = _sx(fontName="Helvetica-Bold", fontSize=7.5, leading=10, alignment=1)
    chips: list[tuple[str, colors.Color]] = []
    if ai.get("risk_level") in _RISK:
        chips.append(_RISK[ai["risk_level"]])
    if ai.get("justified") in _JUSTIFIED:
        chips.append(_JUSTIFIED[ai["justified"]])
    if ai.get("confidence"):
        chips.append((f"{str(ai['confidence']).title()} confidence", GREY_MID))
    cells, widths = [], []
    for label, color in chips:
        cells.append(Paragraph(label.upper(), _sx(parent=chip_s, textColor=color)))
        widths.append(len(label) * 4.6 + 22)
    return Table([cells], colWidths=widths, hAlign="LEFT",
                 style=TableStyle([
                     ("BOX",          (i, 0), (i, 0), 0.75, chips[i][1]) if False else
                     ("LEFTPADDING",  (0, 0), (-1, -1), 8) for i in range(1)
                 ] + [
                     ("BOX",           (i, 0), (i, 0), 0.75, chips[i][1]) for i in range(len(chips))
                 ] + [
                     ("LEFTPADDING",   (0, 0), (-1, -1), 8),
                     ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
                     ("TOPPADDING",    (0, 0), (-1, -1), 4),
                     ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                 ]))


# ── Main builder ─────────────────────────────────────────────────────────────
def build_variance_pdf(buffer: BinaryIO, *, data: dict) -> None:
    """Render the variance working paper into `buffer`.

    Expected keys in `data`:
      company, account_number, account_name, tb_name,
      period_current (date), period_prior (date),
      current_balance, prior_balance, dollar_variance, pct_variance,
      is_material (bool), status (str),
      ai_commentary (dict | None)  — AICommentary schema,
      legacy_narrative (str | None) — prose for pre-agentic rows,
      transactions (list[dict]),
      approved_by_name (str | None), approved_at (iso str | None),
      exported_by (str), is_draft (bool)
    """
    s = _styles()
    pe: date = data["period_current"]
    account_label = f"{data['account_number']} · {data['account_name']}".strip(" ·")
    doc_ref = f"FLX-{pe.strftime('%Y%m')}-{(data['account_number'] or 'ACCT')[:8]}"

    doc = _make_doc(buffer, company=data["company"], account_label=account_label,
                    doc_ref=doc_ref, period_end=pe, is_draft=data.get("is_draft", True))
    body_w = doc.width
    ai = data.get("ai_commentary") or {}

    story: list = []

    # Header
    story.append(_Hairline(GREEN, 2.2))
    story.append(Spacer(0, 12))
    story.append(Paragraph("FLUX ANALYSIS · VARIANCE WORKING PAPER", s["eyebrow"]))
    story.append(Paragraph(account_label, s["title"]))
    story.append(Paragraph(
        f"{_period_label(data['period_current'])} vs {_period_label(data['period_prior'])}"
        + (f" · {data['tb_name']}" if data.get("tb_name") else ""),
        s["subtitle"],
    ))
    story.append(Spacer(0, 12))
    story.append(_meta_cards(data, body_w))
    story.append(Spacer(0, 14))
    story.append(_summary_band(data, body_w))

    # Headline / narrative
    headline = ai.get("headline")
    if headline:
        story.append(Spacer(0, 10))
        story.append(Paragraph(headline, _sx(
            fontName="Helvetica-Bold", fontSize=10, leading=14, textColor=GREY_DARK)))

    # Drivers bridge
    if ai.get("drivers"):
        story.extend(_section("What's driving the change"))
        story.append(_drivers_table(ai, _to_decimal(data["dollar_variance"]), body_w))

    # AI assessment
    narrative = (ai.get("narrative") or data.get("legacy_narrative") or "").strip()
    if narrative or ai:
        story.extend(_section("AI assessment"))
        if ai.get("risk_level") or ai.get("justified") or ai.get("confidence"):
            story.append(_chips(ai))
            story.append(Spacer(0, 8))
        if narrative:
            story.append(Paragraph(narrative.replace("\n", "<br/>"), s["note"]))
        ents = ai.get("key_entities") or []
        if ents:
            story.append(Spacer(0, 8))
            ent_s = _sx(fontName="Helvetica", fontSize=8.5, leading=12, textColor=GREY_DARK)
            for e in ents[:8]:
                story.append(Paragraph(
                    f"&bull;&nbsp; <b>{str(e.get('name', ''))[:50]}</b>"
                    f" · {str(e.get('type', 'other'))}"
                    f" · {_fmt_money(e.get('amount'))}",
                    ent_s,
                ))
        recs = ai.get("recommendations") or []
        if recs:
            story.append(Spacer(0, 10))
            story.append(Paragraph("Recommendations", _sx(
                fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=INK)))
            story.append(Spacer(0, 3))
            for i, r in enumerate(recs[:6], start=1):
                story.append(Paragraph(f"{i}.&nbsp; {str(r)[:240]}", s["note"]))

    # Transactions
    txns = data.get("transactions") or []
    if txns:
        story.extend(_section(f"Supporting transactions ({len(txns)})"))
        story.append(_txn_table(txns, _to_decimal(data["dollar_variance"]), body_w))
        story.append(Spacer(0, 4))
        story.append(Paragraph(
            "Transactions pulled live from QuickBooks for the change window. "
            "A green x marks rows the preparer has reviewed.",
            s["oblique"],
        ))

    # Sign-off
    story.extend(_section("Sign-off"))
    so = _sx(fontName="Helvetica", fontSize=9, leading=14, textColor=GREY_DARK)
    if data.get("approved_by_name"):
        story.append(Paragraph(
            f"<b>Approved by</b> {data['approved_by_name']}"
            + (f" · {_fmt_ts(data.get('approved_at'))}" if data.get("approved_at") else ""),
            so,
        ))
    else:
        story.append(Paragraph(
            "<b>Not yet approved</b> — this working paper is a draft until the "
            "variance is approved in Nordavix.", so,
        ))
    if ai.get("generated_at"):
        story.append(Paragraph(f"AI analysis generated {_fmt_ts(ai['generated_at'])}", so))
    story.append(Paragraph(
        f"Exported by {data.get('exported_by', '')} · "
        f"{datetime.now().strftime('%d %b %Y · %H:%M')}",
        s["oblique"],
    ))

    doc.build(story)
