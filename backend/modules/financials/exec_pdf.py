"""
Executive Financial Report — PDF builder.

A multi-page, audit-grade, AI-narrated close package suitable for the CEO
and the board. Built only when books are closed for the period.

Layout (one section per page-block; page breaks chosen to avoid orphans):

  Page 1   Cover         — company / "Executive Report" / period / closed-by
  Page 2   Executive Summary + Key Highlights (AI-written)
  Page 3+  Financial Statements (IS / BS / CF) — full tables
  Page n   Liquidity insights + cash trend chart
  Page n+1 Profitability insights + revenue/margin chart
  Page n+2 AR/AP aging + stacked bar
  Page n+3 Top expenses + horizontal bar
  Page n+4 Reconciliation Summary + flagged items
  Page n+5 Flux Highlights (per analysis, top variances + narratives)
  Page n+6 AI Risks + Recommendations + Outlook
  Page n+7 Notes & Methodology

Charts are drawn with `reportlab.graphics.charts` so we don't add a
matplotlib dependency. Brand palette mirrors `pdf.py` so the executive
report and the standard financial-package PDF read as one family.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from io import BytesIO
from typing import Any, BinaryIO

from reportlab.graphics.charts.barcharts import HorizontalBarChart, VerticalBarChart
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.graphics.widgets.markers import makeMarker
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from modules.financials.exec_report import ExecReportData

# Reuse existing helpers + brand from the standard financials PDF so the
# two render with identical fonts, colors, and number formatting.
from modules.financials.pdf import (
    GREY_DARK,
    GREY_LIGHT,
    GREY_MID,
    NAVY,
    RED,
    _fmt_money,
    _statement_table,
)

# Extended palette for charts
GREEN     = colors.HexColor("#3E8F66")
AMBER     = colors.HexColor("#b45309")
BLUE      = colors.HexColor("#1d4ed8")
TEAL      = colors.HexColor("#0d9488")
PURPLE    = colors.HexColor("#7c3aed")
GREEN_BG  = colors.Color(0.243, 0.561, 0.4, alpha=0.10)
AMBER_BG  = colors.Color(0.706, 0.325, 0.035, alpha=0.10)
RED_BG    = colors.Color(0.725, 0.114, 0.114, alpha=0.10)


# ── Styles ─────────────────────────────────────────────────────────────────


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        # ── Cover ────────────────────────────────────────────────
        "cover_kicker": ParagraphStyle(
            "cover_kicker", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=9, leading=11, alignment=1, textColor=GREY_MID, spaceAfter=14,
        ),
        "cover_company": ParagraphStyle(
            "cover_company", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=34, leading=40, alignment=1, textColor=NAVY, spaceAfter=8,
        ),
        "cover_title": ParagraphStyle(
            "cover_title", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=22, leading=26, alignment=1, textColor=GREY_DARK, spaceAfter=10,
        ),
        "cover_period": ParagraphStyle(
            "cover_period", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=14, leading=18, alignment=1, textColor=GREY_DARK, spaceAfter=10,
        ),
        "cover_meta": ParagraphStyle(
            "cover_meta", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=14, alignment=1, textColor=GREY_MID,
        ),
        # ── Section / masthead ──────────────────────────────────
        "h_section": ParagraphStyle(
            "h_section", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=18, leading=22, textColor=NAVY, spaceBefore=2, spaceAfter=4,
        ),
        "h_section_kicker": ParagraphStyle(
            "h_section_kicker", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=8, leading=10, textColor=GREY_MID, spaceAfter=2,
        ),
        "h_sub": ParagraphStyle(
            "h_sub", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=12, leading=15, textColor=NAVY, spaceBefore=8, spaceAfter=4,
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
        # ── Body paragraphs ──────────────────────────────────────
        "body": ParagraphStyle(
            "body", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10.5, leading=14, textColor=GREY_DARK, spaceBefore=2, spaceAfter=4,
        ),
        "body_big": ParagraphStyle(
            "body_big", parent=base["BodyText"], fontName="Helvetica",
            fontSize=12, leading=16, textColor=GREY_DARK, spaceBefore=4, spaceAfter=8,
        ),
        "bullet": ParagraphStyle(
            "bullet", parent=base["BodyText"], fontName="Helvetica",
            fontSize=10, leading=13.5, textColor=GREY_DARK,
            leftIndent=14, bulletIndent=2, spaceBefore=2, spaceAfter=2,
        ),
        "note": ParagraphStyle(
            "note", parent=base["BodyText"], fontName="Helvetica-Oblique",
            fontSize=8.5, leading=11, textColor=GREY_MID, spaceBefore=6,
        ),
        # ── KPI tiles ────────────────────────────────────────────
        "tile_label": ParagraphStyle(
            "tile_label", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=7.5, leading=9, textColor=GREY_MID,
        ),
        "tile_value": ParagraphStyle(
            "tile_value", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=14, leading=17, textColor=NAVY,
        ),
        "tile_value_sm": ParagraphStyle(
            "tile_value_sm", parent=base["BodyText"], fontName="Helvetica-Bold",
            fontSize=12, leading=15, textColor=NAVY,
        ),
        "tile_sub": ParagraphStyle(
            "tile_sub", parent=base["BodyText"], fontName="Helvetica",
            fontSize=8, leading=10, textColor=GREY_MID,
        ),
    }


# ── Number / format helpers ─────────────────────────────────────────────────


def _money(v: Any, *, with_dollar: bool = True) -> str:
    """Cover any input shape (Decimal, float, int, str, None) → audit-style string."""
    if v is None:
        return "—"
    if isinstance(v, str):
        if v == "" or v == "—":
            return v or "—"
        try:
            v = Decimal(v)
        except Exception:
            return v
    if isinstance(v, (int, float)):
        v = Decimal(str(v))
    return _fmt_money(str(v), with_dollar=with_dollar)


def _pct(v: Any, decimals: int = 1) -> str:
    if v is None: return "—"
    try:
        return f"{float(v):.{decimals}f}%"
    except (TypeError, ValueError):
        return "—"


# ── Small flowable helpers ──────────────────────────────────────────────────


class _Hairline(Flowable):
    """Full-width horizontal rule."""
    def __init__(self, color: colors.Color, width_pts: float = 0.75):
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


def _section_header(story: list, styles: dict, *, kicker: str, title: str) -> None:
    """Standard section opener — uppercase grey kicker + big navy title + thin rule."""
    story.append(Paragraph(kicker.upper(), styles["h_section_kicker"]))
    story.append(Paragraph(title, styles["h_section"]))
    story.append(_Hairline(NAVY, 1.0))
    story.append(Spacer(1, 0.10 * inch))


def _kpi_row(items: list[tuple[str, str, str | None]], styles: dict,
             *, frame_w: float = 7.1) -> Table:
    """Render a horizontal row of KPI tiles.
    Each item is (label, value, optional sub-line).
    """
    n = len(items) or 1
    col_w = (frame_w * inch) / n
    cells: list[list[Any]] = [[]]
    for label, value, sub in items:
        block = [
            Paragraph(label.upper(), styles["tile_label"]),
            Spacer(1, 0.04 * inch),
            Paragraph(value, styles["tile_value"]),
        ]
        if sub:
            block.append(Spacer(1, 0.02 * inch))
            block.append(Paragraph(sub, styles["tile_sub"]))
        cells[0].append(block)
    tbl = Table(cells, colWidths=[col_w] * n)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.Color(0.985, 0.987, 0.99)),
        ("LINEABOVE",  (0, 0), (-1, 0), 0.75, NAVY),
        ("LINEBELOW",  (0, -1), (-1, -1), 0.75, NAVY),
        ("LEFTPADDING",   (0, 0), (-1, -1), 12),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 12),
        ("TOPPADDING",    (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
    ]))
    return tbl


def _bullet_list(items: list[str], styles: dict, *, bullet: str = "•") -> list[Paragraph]:
    """One bullet paragraph per string."""
    return [
        Paragraph(f"{bullet}  {it}", styles["bullet"]) for it in items if it.strip()
    ]


# ── Charts (reportlab.graphics, no matplotlib) ──────────────────────────────


def _line_chart_cash(history: list[dict], *, width: float = 6.5 * inch,
                     height: float = 2.4 * inch) -> Drawing:
    """Cash & OCF over the last N months — line chart with two series."""
    d = Drawing(width, height)
    if not history:
        d.add(String(width / 2, height / 2, "No cash history available",
                     textAnchor="middle", fillColor=GREY_MID, fontSize=10))
        return d
    chart = LinePlot()
    chart.x, chart.y = 50, 28
    chart.width = width - 75
    chart.height = height - 55
    cash_series = [(i + 1, float(p.get("cash") or 0)) for i, p in enumerate(history)]
    ocf_series  = [(i + 1, float(p.get("ocf") or 0))  for i, p in enumerate(history)]
    chart.data = [cash_series, ocf_series]
    chart.lines[0].strokeColor = NAVY
    chart.lines[0].strokeWidth = 2
    chart.lines[1].strokeColor = GREEN
    chart.lines[1].strokeWidth = 1.6
    chart.lines[1].strokeDashArray = (3, 3)
    chart.lines[0].symbol = makeMarker("FilledCircle", size=4)
    chart.lines[1].symbol = makeMarker("Diamond", size=4)
    # X-axis labels = month abbreviations
    chart.xValueAxis.valueMin = 0.5
    chart.xValueAxis.valueMax = len(history) + 0.5
    chart.xValueAxis.valueSteps = list(range(1, len(history) + 1))
    chart.xValueAxis.labelTextFormat = lambda v: history[int(v) - 1]["label"] if 1 <= int(v) <= len(history) else ""
    chart.xValueAxis.labels.fontSize = 8
    chart.xValueAxis.labels.fillColor = GREY_MID
    chart.yValueAxis.labels.fontSize = 8
    chart.yValueAxis.labels.fillColor = GREY_MID
    chart.yValueAxis.labelTextFormat = lambda v: f"${int(v / 1000)}k" if abs(v) >= 1000 else f"${int(v)}"
    chart.yValueAxis.gridStrokeColor = GREY_LIGHT
    chart.yValueAxis.gridStrokeWidth = 0.4
    d.add(chart)
    # Legend dots
    d.add(Rect(50, height - 18, 8, 8, fillColor=NAVY, strokeColor=None))
    d.add(String(62, height - 12, "Cash balance", fontSize=8, fillColor=GREY_DARK))
    d.add(Rect(160, height - 18, 8, 8, fillColor=GREEN, strokeColor=None))
    d.add(String(172, height - 12, "Operating cash flow (proxy)", fontSize=8, fillColor=GREY_DARK))
    return d


def _bar_chart_revenue(history: list[dict], *, width: float = 6.5 * inch,
                       height: float = 2.4 * inch) -> Drawing:
    """Revenue / Gross Profit / Net Income across months — grouped bars."""
    d = Drawing(width, height)
    if not history:
        d.add(String(width / 2, height / 2, "No revenue history available",
                     textAnchor="middle", fillColor=GREY_MID, fontSize=10))
        return d
    chart = VerticalBarChart()
    chart.x, chart.y = 50, 32
    chart.width = width - 75
    chart.height = height - 60
    chart.data = [
        [float(p.get("revenue") or 0) for p in history],
        [float(p.get("gp") or 0)      for p in history],
        [float(p.get("ni") or 0)      for p in history],
    ]
    chart.bars[0].fillColor = NAVY
    chart.bars[1].fillColor = TEAL
    chart.bars[2].fillColor = GREEN
    chart.bars.strokeColor = None
    chart.barWidth = 6
    chart.groupSpacing = 8
    chart.barSpacing = 1
    chart.categoryAxis.categoryNames = [p.get("label", "") for p in history]
    chart.categoryAxis.labels.fontSize = 8
    chart.categoryAxis.labels.fillColor = GREY_MID
    chart.valueAxis.labels.fontSize = 8
    chart.valueAxis.labels.fillColor = GREY_MID
    chart.valueAxis.labelTextFormat = lambda v: f"${int(v / 1000)}k" if abs(v) >= 1000 else f"${int(v)}"
    chart.valueAxis.gridStrokeColor = GREY_LIGHT
    chart.valueAxis.gridStrokeWidth = 0.4
    d.add(chart)
    # Legend
    d.add(Rect(50, height - 18, 8, 8, fillColor=NAVY, strokeColor=None))
    d.add(String(62, height - 12, "Revenue", fontSize=8, fillColor=GREY_DARK))
    d.add(Rect(120, height - 18, 8, 8, fillColor=TEAL, strokeColor=None))
    d.add(String(132, height - 12, "Gross Profit", fontSize=8, fillColor=GREY_DARK))
    d.add(Rect(200, height - 18, 8, 8, fillColor=GREEN, strokeColor=None))
    d.add(String(212, height - 12, "Net Income", fontSize=8, fillColor=GREY_DARK))
    return d


def _hbar_chart_expenses(categories: list[tuple[str, float]], *,
                         width: float = 6.5 * inch, height: float = 2.6 * inch) -> Drawing:
    """Top expense categories — horizontal bar."""
    d = Drawing(width, height)
    if not categories:
        d.add(String(width / 2, height / 2, "No expense data available",
                     textAnchor="middle", fillColor=GREY_MID, fontSize=10))
        return d
    chart = HorizontalBarChart()
    chart.x, chart.y = 150, 20
    chart.width = width - 175
    chart.height = height - 40
    chart.data = [[v for _, v in categories]]
    chart.bars[0].fillColor = NAVY
    chart.bars.strokeColor = None
    chart.barWidth = 12
    chart.categoryAxis.categoryNames = [_truncate(name, 22) for name, _ in categories]
    chart.categoryAxis.labels.fontSize = 8
    chart.categoryAxis.labels.fillColor = GREY_DARK
    chart.categoryAxis.labels.textAnchor = "end"
    chart.categoryAxis.labels.dx = -6
    chart.valueAxis.labels.fontSize = 8
    chart.valueAxis.labels.fillColor = GREY_MID
    chart.valueAxis.labelTextFormat = lambda v: f"${int(v / 1000)}k" if abs(v) >= 1000 else f"${int(v)}"
    chart.valueAxis.valueMin = 0
    chart.valueAxis.gridStrokeColor = GREY_LIGHT
    chart.valueAxis.gridStrokeWidth = 0.4
    d.add(chart)
    return d


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


# ── Page templates ──────────────────────────────────────────────────────────


def _make_doc(buffer: BinaryIO, company: str, period_end: date) -> tuple[BaseDocTemplate, list]:
    margin = 0.7 * inch
    page_w, page_h = LETTER

    # Body frame (most pages)
    body_frame = Frame(
        margin, margin + 0.4 * inch,
        page_w - 2 * margin,
        page_h - 2 * margin - 0.6 * inch,
        id="body", topPadding=0, bottomPadding=0,
    )

    def on_page(canvas, doc) -> None:
        canvas.saveState()
        # Footer
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(GREY_MID)
        y = 0.4 * inch
        ts = datetime.now().strftime("%B %d, %Y")
        canvas.drawString(margin, y, f"{company} · Executive Report · {period_end.strftime('%B %Y')}")
        canvas.drawCentredString(page_w / 2, y, f"Page {canvas.getPageNumber()}")
        canvas.drawRightString(page_w - margin, y, f"Generated {ts}")
        # Top rule on body pages
        if doc.page > 1:
            canvas.setStrokeColor(GREY_LIGHT)
            canvas.setLineWidth(0.4)
            canvas.line(margin, page_h - margin + 0.20 * inch,
                        page_w - margin, page_h - margin + 0.20 * inch)
        canvas.restoreState()

    body_tpl = PageTemplate(id="body", frames=[body_frame], onPage=on_page)
    cover_frame = Frame(
        margin, margin + 1.2 * inch,
        page_w - 2 * margin,
        page_h - 2 * margin - 1.4 * inch,
        id="cover",
    )
    cover_tpl = PageTemplate(id="cover", frames=[cover_frame], onPage=on_page)

    doc = BaseDocTemplate(
        buffer, pagesize=LETTER,
        leftMargin=margin, rightMargin=margin,
        topMargin=margin, bottomMargin=margin,
        title=f"Executive Report — {company} — {period_end.strftime('%B %Y')}",
        author=company,
    )
    doc.addPageTemplates([cover_tpl, body_tpl])
    return doc, []


# ── Cover page ──────────────────────────────────────────────────────────────


def _cover(story: list, styles: dict, data: ExecReportData, audience: str = "internal") -> None:
    is_client = audience == "client"
    story.append(Spacer(1, 1.3 * inch))
    story.append(Paragraph(
        "FOR YOUR REVIEW" if is_client else "CONFIDENTIAL · BOARD MATERIAL",
        styles["cover_kicker"],
    ))
    story.append(Paragraph(data.company, styles["cover_company"]))
    story.append(Spacer(1, 0.10 * inch))
    story.append(Paragraph(
        "Monthly Business Review" if is_client else "Executive Financial Report",
        styles["cover_title"],
    ))
    story.append(Paragraph(f"For the period ended {data.period_end.strftime('%B %d, %Y')}",
                            styles["cover_period"]))
    story.append(Spacer(1, 1.0 * inch))

    # Closed-state stamp
    stamp_tbl = Table([[
        Paragraph(
            "<font color='#3E8F66'><b>BOOKS CLOSED</b></font>",
            ParagraphStyle("stamp", fontName="Helvetica-Bold", fontSize=14,
                            alignment=1, textColor=GREEN),
        )
    ]], colWidths=[2.6 * inch])
    stamp_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN_BG),
        ("BOX",        (0, 0), (-1, -1), 1.2, GREEN),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    # Center it manually with a wrapper
    centered = Table([[stamp_tbl]], colWidths=[7.1 * inch])
    centered.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    story.append(centered)

    story.append(Spacer(1, 0.5 * inch))

    closed_when = data.closed_at.strftime("%B %d, %Y") if data.closed_at else ""
    if closed_when:
        story.append(Paragraph(
            f"Books closed on {closed_when} by {data.closed_by_name}",
            styles["cover_meta"],
        ))
    story.append(Paragraph(
        f"Generated {datetime.now().strftime('%B %d, %Y')} · Nordavix Close Platform",
        styles["cover_meta"],
    ))


# ── Executive Summary ──────────────────────────────────────────────────────


def _executive_summary(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Executive Summary", title="Where We Are")
    # Big body paragraph
    summary_text = data.ai.executive_summary or "—"
    story.append(Paragraph(summary_text, styles["body_big"]))
    story.append(Spacer(1, 0.20 * inch))

    # KPI tiles — top headline numbers
    liq = data.insights.get("liquidity") or {}
    prof = data.insights.get("profitability") or {}
    tiles: list[tuple[str, str, str | None]] = []
    if prof.get("net_income") is not None:
        ni = prof.get("net_income")
        tiles.append((
            "Net Income",
            _money(ni),
            prof.get("revenue_change_str") or None,
        ))
    if liq.get("cash_balance") is not None:
        tiles.append((
            "Cash on Hand",
            _money(liq.get("cash_balance")),
            (liq.get("cash_change_str") or "") + " vs last month" if liq.get("cash_change_str") else None,
        ))
    if liq.get("runway_months") is not None:
        rm = liq.get("runway_months")
        tiles.append((
            "Runway",
            f"{float(rm):.1f} mo" if rm else "—",
            "at current burn rate",
        ))
    if prof.get("net_margin_pct") is not None:
        tiles.append((
            "Net Margin",
            _pct(prof.get("net_margin_pct")),
            "this period",
        ))
    if tiles:
        story.append(_kpi_row(tiles, styles))

    # Key Highlights bullets
    if data.ai.key_highlights:
        story.append(Spacer(1, 0.25 * inch))
        story.append(Paragraph("Key Highlights", styles["h_sub"]))
        story.extend(_bullet_list(data.ai.key_highlights, styles))


# ── Financial Statements ───────────────────────────────────────────────────


def _statement_section(story: list, styles: dict, stmt: Any) -> None:
    if not stmt:
        return
    story.append(Paragraph(stmt.company, styles["masthead_company"]))
    story.append(Paragraph(stmt.title, styles["masthead_title"]))
    story.append(Paragraph(stmt.subtitle, styles["masthead_subtitle"]))
    story.append(_statement_table(stmt))


# ── Liquidity section ──────────────────────────────────────────────────────


def _liquidity_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Insights — Liquidity",
                    title="Cash, Burn, and Runway")
    liq = data.insights.get("liquidity") or {}
    if not liq:
        story.append(Paragraph(
            "Liquidity metrics could not be computed for this period.",
            styles["note"],
        ))
        return

    # 4 KPI tiles
    rm = liq.get("runway_months")
    runway_str = f"{float(rm):.1f} months" if isinstance(rm, (int, float)) else "Indefinite"
    tiles = [
        ("Cash Balance",    _money(liq.get("cash_balance")),
         (liq.get("cash_change_str") or "") + " vs last month" if liq.get("cash_change_str") else None),
        ("Monthly Burn",    _money(liq.get("monthly_burn")), "3-mo average"),
        ("Runway",          runway_str, "at current trajectory"),
        ("OCF (Proxy)",     _money(liq.get("operating_cash_flow")),
         "monthly net income"),
    ]
    story.append(_kpi_row(tiles, styles))
    story.append(Spacer(1, 0.20 * inch))

    # Cash + OCF trend chart
    story.append(_line_chart_cash(liq.get("history") or []))
    story.append(Spacer(1, 0.08 * inch))

    # Risk narrative from insights.kpis
    kpis = liq.get("kpis") or []
    for k in kpis[:2]:   # top 2 — cash + burn typically
        insight = k.get("insight") or ""
        if insight:
            story.append(Paragraph(
                f"<b>{k.get('kpi', '')}.</b> {insight}",
                styles["body"],
            ))


# ── Profitability section ──────────────────────────────────────────────────


def _profitability_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Insights — Profitability",
                    title="Revenue, Margins, and Earnings")
    prof = data.insights.get("profitability") or {}
    if not prof:
        story.append(Paragraph("Profitability metrics unavailable.", styles["note"]))
        return

    tiles = [
        ("Revenue",          _money(prof.get("revenue")),
         prof.get("revenue_change_str") or None),
        ("Gross Profit",     _money(prof.get("gross_profit")),
         _pct(prof.get("gross_margin_pct"))),
        ("Operating Income", _money(prof.get("operating_income")),
         _pct(prof.get("operating_margin_pct"))),
        ("Net Income",       _money(prof.get("net_income")),
         _pct(prof.get("net_margin_pct"))),
    ]
    story.append(_kpi_row(tiles, styles))
    story.append(Spacer(1, 0.20 * inch))

    # Trend chart
    rev_hist = prof.get("history") or data.insights.get("revenue_history") or []
    if not rev_hist:
        # Some service versions emit history under a different key —
        # fall back to a 1-bar "current period only" chart so the page
        # isn't empty.
        rev_hist = [{
            "label":   data.period_end.strftime("%b"),
            "revenue": prof.get("revenue"),
            "gp":      prof.get("gross_profit"),
            "ni":      prof.get("net_income"),
        }]
    story.append(_bar_chart_revenue(rev_hist))


# ── AR/AP section ──────────────────────────────────────────────────────────


def _ar_ap_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Insights — Working Capital",
                    title="Accounts Receivable and Payable")
    arap = data.insights.get("ar_ap") or {}
    if not arap:
        story.append(Paragraph(
            "AR/AP analysis unavailable — no subledger data captured for this period.",
            styles["note"],
        ))
        return
    tiles = [
        ("DSO",                _fmt_days(arap.get("dso")),
         "Days sales outstanding"),
        ("DPO",                _fmt_days(arap.get("dpo")),
         "Days payables outstanding"),
        ("AR > 60 days",       _pct(arap.get("ar_over_60_pct")),
         "of total AR aging"),
        ("AP > 60 days",       _pct(arap.get("ap_over_60_pct")),
         "of total AP aging"),
    ]
    story.append(_kpi_row(tiles, styles))
    # Narrative
    for k in (arap.get("kpis") or [])[:2]:
        insight = k.get("insight") or ""
        if insight:
            story.append(Spacer(1, 0.08 * inch))
            story.append(Paragraph(
                f"<b>{k.get('kpi', '')}.</b> {insight}",
                styles["body"],
            ))


def _fmt_days(v: Any) -> str:
    if v is None: return "—"
    try:
        return f"{float(v):.0f} days"
    except (TypeError, ValueError):
        return "—"


# ── Expenses section ──────────────────────────────────────────────────────


def _expenses_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Insights — Expense Trends",
                    title="Top Categories and Month-over-Month Movers")
    exp = data.insights.get("expenses") or {}
    cats = exp.get("top_categories") or []
    if not cats:
        story.append(Paragraph("No expense detail available.", styles["note"]))
        return

    # Horizontal bar chart of top categories
    bar_data = [(c.get("name") or "—", float(c.get("amount") or 0)) for c in cats[:7]]
    story.append(_hbar_chart_expenses(bar_data))
    story.append(Spacer(1, 0.10 * inch))

    # MoM movers as a small table
    movers = exp.get("mom_movers") or []
    if movers:
        story.append(Paragraph("Largest Month-over-Month Movers", styles["h_sub"]))
        rows: list[list[Any]] = [["Account", "Current", "Prior", "Δ"]]
        for m in movers[:6]:
            cur   = m.get("current") or 0
            prior = m.get("prior") or 0
            try:
                delta = float(cur) - float(prior)
            except (TypeError, ValueError):
                delta = 0
            rows.append([
                _truncate(m.get("name", ""), 40),
                _money(cur),
                _money(prior),
                _money(delta),
            ])
        tbl = Table(rows, colWidths=[3.4 * inch, 1.2 * inch, 1.2 * inch, 1.2 * inch])
        tbl.setStyle(TableStyle([
            ("FONT",       (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
            ("TEXTCOLOR",  (0, 0), (-1, 0), NAVY),
            ("LINEBELOW",  (0, 0), (-1, 0), 0.5, NAVY),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("FONT",       (0, 1), (-1, -1), "Helvetica", 9),
            ("TEXTCOLOR",  (0, 1), (-1, -1), GREY_DARK),
            ("ALIGN",      (1, 0), (-1, -1), "RIGHT"),
            ("TOPPADDING", (0, 1), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
            ("LINEBELOW",  (0, 1), (-1, -2), 0.25, GREY_LIGHT),
        ]))
        story.append(tbl)


# ── Reconciliation summary ─────────────────────────────────────────────────


def _recons_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Month-End Close",
                    title="Reconciliation Summary")
    r = data.recons

    # KPI strip
    approved_pct = (r.approved_count / r.total_accounts * 100) if r.total_accounts else 0
    tiles = [
        ("Accounts Reconciled",
         f"{r.approved_count} / {r.total_accounts}",
         f"{approved_pct:.0f}% of total"),
        ("Total Variance",
         _money(r.total_variance),
         "absolute sum across accounts"),
        ("Flagged Items",
         str(r.flagged_count),
         "needing follow-up"),
        ("AI-Prepared",
         str(r.ai_prepared_count),
         f"of {r.total_accounts} accounts"),
    ]
    story.append(_kpi_row(tiles, styles))
    story.append(Spacer(1, 0.20 * inch))

    # Top variances table
    if r.top_variances:
        story.append(Paragraph("Largest Reconciliation Variances", styles["h_sub"]))
        rows: list[list[Any]] = [["Account #", "Account Name", "GL Balance", "Subledger", "Variance"]]
        for v in r.top_variances[:8]:
            rows.append([
                v.get("account_number") or "—",
                _truncate(v.get("account_name") or "", 36),
                _money(v.get("gl_balance")),
                _money(v.get("subledger_total")),
                _money(v.get("variance")),
            ])
        tbl = Table(rows, colWidths=[0.85 * inch, 2.85 * inch, 1.1 * inch, 1.1 * inch, 1.1 * inch])
        tbl.setStyle(TableStyle([
            ("FONT",       (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
            ("TEXTCOLOR",  (0, 0), (-1, 0), NAVY),
            ("LINEBELOW",  (0, 0), (-1, 0), 0.5, NAVY),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("FONT",       (0, 1), (-1, -1), "Helvetica", 8.5),
            ("TEXTCOLOR",  (0, 1), (-1, -1), GREY_DARK),
            ("ALIGN",      (2, 0), (-1, -1), "RIGHT"),
            ("TOPPADDING", (0, 1), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
            ("LINEBELOW",  (0, 1), (-1, -2), 0.25, GREY_LIGHT),
        ]))
        story.append(tbl)

    # Flagged items, if any
    if r.flagged_items:
        story.append(Spacer(1, 0.18 * inch))
        story.append(Paragraph("Flagged for Follow-Up", styles["h_sub"]))
        rows = [["Account", "Notes"]]
        for f in r.flagged_items[:5]:
            rows.append([
                _truncate(f"{f.get('account_number') or ''} {f.get('account_name') or ''}".strip(), 28),
                _truncate(f.get("notes") or "(no notes)", 90),
            ])
        tbl = Table(rows, colWidths=[2.0 * inch, 5.1 * inch])
        tbl.setStyle(TableStyle([
            ("FONT",       (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
            ("TEXTCOLOR",  (0, 0), (-1, 0), AMBER),
            ("LINEBELOW",  (0, 0), (-1, 0), 0.5, AMBER),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("FONT",       (0, 1), (-1, -1), "Helvetica", 8.5),
            ("TEXTCOLOR",  (0, 1), (-1, -1), GREY_DARK),
            ("VALIGN",     (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 1), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 4),
            ("BACKGROUND", (0, 0), (-1, -1), AMBER_BG),
        ]))
        story.append(tbl)


# ── Flux highlights ────────────────────────────────────────────────────────


def _flux_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Variance Analysis",
                    title="Flux Highlights")
    if not data.flux:
        story.append(Paragraph(
            "No flux analyses approved for this period.",
            styles["note"],
        ))
        return

    for i, f in enumerate(data.flux):
        if i > 0:
            story.append(Spacer(1, 0.14 * inch))
        # Per-analysis sub-header
        meta_line = (
            f"Approved by <b>{f.approved_by_name or 'an admin'}</b> · "
            f"materiality threshold {_money(f.materiality_threshold)} · "
            f"{f.material_variance_count} material variance(s)"
        )
        story.append(Paragraph(f.name, styles["h_sub"]))
        story.append(Paragraph(meta_line, styles["note"]))

        if not f.top_variances:
            story.append(Paragraph(
                "No material variances flagged.",
                styles["body"],
            ))
            continue

        # Variance table — keep narrow + show narratives in their own
        # row underneath each variance so they can wrap freely.
        rows: list[list[Any]] = [["#", "Account", "Current", "Prior", "Δ", "Δ %"]]
        for v in f.top_variances:
            rows.append([
                v.get("account_number") or "—",
                _truncate(v.get("account_name") or "", 32),
                _money(v.get("current")),
                _money(v.get("prior")),
                _money(v.get("absolute")),
                _pct(v.get("change_pct")) if v.get("change_pct") is not None else "—",
            ])
        tbl = Table(rows, colWidths=[0.6 * inch, 2.65 * inch, 1.1 * inch, 1.1 * inch, 1.0 * inch, 0.65 * inch])
        tbl.setStyle(TableStyle([
            ("FONT",       (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
            ("TEXTCOLOR",  (0, 0), (-1, 0), NAVY),
            ("LINEBELOW",  (0, 0), (-1, 0), 0.5, NAVY),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
            ("FONT",       (0, 1), (-1, -1), "Helvetica", 8.5),
            ("TEXTCOLOR",  (0, 1), (-1, -1), GREY_DARK),
            ("ALIGN",      (2, 0), (-1, -1), "RIGHT"),
            ("TOPPADDING", (0, 1), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 3),
            ("LINEBELOW",  (0, 1), (-1, -2), 0.25, GREY_LIGHT),
        ]))
        story.append(tbl)

        # Narratives — only render the ones that exist
        narr_rows = [v for v in f.top_variances if v.get("narrative")]
        if narr_rows:
            story.append(Spacer(1, 0.06 * inch))
            for v in narr_rows[:3]:
                story.append(Paragraph(
                    f"<b>{v.get('account_number')} {v.get('account_name')}.</b> "
                    f"{(v.get('narrative') or '')[:480]}",
                    styles["body"],
                ))


# ── AI sections (risks / recommendations / outlook) ────────────────────────


def _ai_insights_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="AI-Generated Analysis",
                    title="Risks, Recommendations, and Outlook")

    # Risks
    story.append(Paragraph("Risks Identified", styles["h_sub"]))
    if data.ai.risks:
        # Each risk gets its own callout box for visual punch
        for risk in data.ai.risks[:5]:
            story.extend(_callout_block(risk, styles, color="risk"))
            story.append(Spacer(1, 0.04 * inch))
    else:
        story.append(Paragraph(
            "No high-priority risks surfaced by AI analysis.",
            styles["body"],
        ))
    story.append(Spacer(1, 0.16 * inch))

    # Recommendations
    story.append(Paragraph("Recommended Actions", styles["h_sub"]))
    if data.ai.recommendations:
        for rec in data.ai.recommendations[:6]:
            story.extend(_callout_block(rec, styles, color="rec"))
            story.append(Spacer(1, 0.04 * inch))
    else:
        story.append(Paragraph(
            "No specific recommendations generated.",
            styles["body"],
        ))
    story.append(Spacer(1, 0.16 * inch))

    # Outlook
    story.append(Paragraph("Forward Outlook", styles["h_sub"]))
    if data.ai.outlook:
        story.extend(_callout_block(data.ai.outlook, styles, color="outlook"))
    else:
        story.append(Paragraph(
            "Forward outlook unavailable for this period.",
            styles["body"],
        ))


def _callout_block(text: str, styles: dict, *, color: str) -> list[Any]:
    """One colored side-bar callout box."""
    accent = {"risk": RED, "rec": GREEN, "outlook": BLUE}.get(color, NAVY)
    bg     = {"risk": RED_BG, "rec": GREEN_BG, "outlook": colors.Color(0.114, 0.306, 0.847, alpha=0.08)}.get(
        color, colors.Color(0.122, 0.227, 0.373, alpha=0.05),
    )
    tbl = Table([[Paragraph(text, styles["body"])]], colWidths=[7.0 * inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, -1), bg),
        ("LINEBEFORE",   (0, 0), (0, -1), 2.5, accent),
        ("LEFTPADDING",  (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING",   (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 8),
    ]))
    return [tbl]


# ── Notes & Methodology ────────────────────────────────────────────────────


def _notes_section(story: list, styles: dict, data: ExecReportData) -> None:
    _section_header(story, styles, kicker="Methodology",
                    title="Notes and Definitions")

    notes: list[str] = []
    notes.extend(data.warnings)

    notes.extend([
        "<b>Source.</b> Financial statements (Income Statement and Balance Sheet) "
        "are built from Nordavix's synced GL snapshots — captured on each reconciliation "
        "sync — so they reflect the same balances the reconciliation work signed off on. "
        "The Cash Flow statement is pulled live from QuickBooks.",
        "<b>Comparative.</b> Period-over-period comparisons use the prior month "
        "(e.g. April 2026 vs March 2026). The Income Statement and Cash Flow show "
        "the close month versus the month before; the Balance Sheet compares month-ends.",
        "<b>Runway.</b> Computed as cash balance ÷ rolling 3-month average burn. "
        "Reported as 'indefinite' when the business is cash-positive over the trailing 3 months.",
        "<b>AI-generated content.</b> The executive summary, key highlights, risks, "
        "recommendations, and outlook were generated by Claude (Anthropic) from the structured "
        "financial data above. They are advisory only — not a substitute for the judgment of "
        "the controller, CFO, or external auditor.",
        "<b>Materiality.</b> Flux variance materiality threshold is set per analysis by "
        "the preparer. Only variances exceeding that threshold are surfaced in the Flux "
        "Highlights section.",
        "<b>Reconciliation status.</b> 'Approved' means an authorized reviewer signed off "
        "on the prepared reconciliation; 'Flagged' means the preparer or reviewer flagged "
        "the account for follow-up. The books cannot be closed until every account is approved "
        "AND every flux analysis is approved.",
    ])

    for n in notes:
        story.append(Paragraph(n, styles["body"]))
        story.append(Spacer(1, 0.05 * inch))


# ── Public entry point ─────────────────────────────────────────────────────


def build_executive_pdf(buffer: BinaryIO, *, data: ExecReportData, audience: str = "internal") -> None:
    """Render the executive report PDF into `buffer`.

    audience='client' produces a slimmer "Monthly Business Review" for the
    business owner: cover + the plain-language summary + the insight
    charts/KPIs + the advisory section. It drops the raw GAAP statement tables
    and the reconciliation / flux operational detail — those are the firm's
    internal working papers, not client-facing material."""
    is_client = audience == "client"
    styles = _styles()
    doc, story = _make_doc(buffer, data.company, data.period_end)

    # ── Cover ───────────────────────────────────────────────────────
    _cover(story, styles, data, audience)

    # ── Executive Summary ──────────────────────────────────────────
    story.append(PageBreak())
    _executive_summary(story, styles, data)

    # ── Financial Statements (internal/board package only) ─────────
    if not is_client:
        for stmt in [data.income_statement, data.balance_sheet, data.cash_flow]:
            if stmt is None:
                continue
            story.append(PageBreak())
            _statement_section(story, styles, stmt)

    # ── Insights (both editions) ───────────────────────────────────
    story.append(PageBreak())
    _liquidity_section(story, styles, data)
    story.append(Spacer(1, 0.25 * inch))
    _profitability_section(story, styles, data)

    story.append(PageBreak())
    _ar_ap_section(story, styles, data)
    story.append(Spacer(1, 0.25 * inch))
    _expenses_section(story, styles, data)

    # ── Reconciliations + Flux (internal working papers only) ──────
    if not is_client:
        story.append(PageBreak())
        _recons_section(story, styles, data)

        story.append(PageBreak())
        _flux_section(story, styles, data)

    # ── AI insights (the meat — both editions) ─────────────────────
    story.append(PageBreak())
    _ai_insights_section(story, styles, data)

    # ── Notes ──────────────────────────────────────────────────────
    story.append(PageBreak())
    _notes_section(story, styles, data)

    doc.build(story)


if __name__ == "__main__":  # pragma: no cover — local smoke
    from collections import namedtuple

    from modules.financials.exec_report import (
        AIReportNarrative,
        ExecReportData,
        FluxHighlight,
        ReconSummary,
    )

    R = namedtuple("R", "label current prior level kind")
    S = namedtuple("S", "title subtitle company period_label comparative_label rows notes")
    sample_rows = [
        R("Revenue", None, None, 0, "section_header"),
        R("Sales", "1250000", "1100000", 1, "data"),
        R("Total Revenue", "1250000", "1100000", 0, "total"),
        R("Net Income", "200000", "180000", 0, "grand_total"),
    ]
    is_stmt = S("Income Statement", "For the Year-to-Date Ended April 30, 2026",
                "Demo Co", "YTD Apr 2026", "YTD Apr 2025", sample_rows, [])
    bs_stmt = S("Balance Sheet", "As of April 30, 2026",
                "Demo Co", "Apr 30, 2026", "Apr 30, 2025", sample_rows, [])
    cf_stmt = S("Statement of Cash Flows", "For the Year-to-Date Ended April 30, 2026",
                "Demo Co", "YTD Apr 2026", "YTD Apr 2025", sample_rows, [])

    insights = {
        "liquidity": {
            "cash_balance": 1_200_000, "monthly_burn": 80_000, "runway_months": 15.0,
            "operating_cash_flow": -65_000, "cash_change_str": "+12.4%",
            "history": [
                {"label": "Nov", "cash": 1_400_000, "ocf": -50_000},
                {"label": "Dec", "cash": 1_350_000, "ocf": -60_000},
                {"label": "Jan", "cash": 1_300_000, "ocf": -70_000},
                {"label": "Feb", "cash": 1_280_000, "ocf": -55_000},
                {"label": "Mar", "cash": 1_240_000, "ocf": -80_000},
                {"label": "Apr", "cash": 1_200_000, "ocf": -65_000},
            ],
            "kpis": [
                {"kpi": "Cash balance", "insight": "Healthy buffer; trending down on accelerating spend."},
                {"kpi": "Monthly burn", "insight": "Burn ticked up 8% MoM from Q1 sales hiring."},
            ],
        },
        "profitability": {
            "revenue": 1_250_000, "gross_profit": 880_000,
            "gross_margin_pct": 70.4,
            "operating_income": 240_000, "operating_margin_pct": 19.2,
            "net_income": 200_000, "net_margin_pct": 16.0,
            "revenue_change_str": "+13.6%",
        },
        "ar_ap": {"dso": 42, "dpo": 28, "ar_over_60_pct": 12, "ap_over_60_pct": 4,
                  "kpis": [{"kpi": "DSO", "insight": "DSO at 42 days — slightly elevated; concentration in 2 enterprise accounts."}]},
        "expenses": {
            "top_categories": [
                {"name": "Salaries & Wages", "amount": 420_000},
                {"name": "Software & Subscriptions", "amount": 65_000},
                {"name": "Marketing & Ads", "amount": 48_000},
                {"name": "Office Rent", "amount": 24_000},
                {"name": "Professional Services", "amount": 18_000},
            ],
            "mom_movers": [
                {"name": "Marketing & Ads", "current": 48_000, "prior": 22_000},
            ],
        },
    }
    data = ExecReportData(
        company="Demo Co",
        period_end=date(2026, 4, 30),
        period_label="April 2026",
        closed_at=datetime.now(),
        closed_by_name="Jane Doe",
        income_statement=is_stmt,
        balance_sheet=bs_stmt,
        cash_flow=cf_stmt,
        insights=insights,
        recons=ReconSummary(
            total_accounts=42, approved_count=42, flagged_count=2,
            pending_count=0, total_variance=Decimal("1240.50"),
            top_variances=[
                {"account_name": "Cash Operating", "account_number": "1010",
                 "account_type": "Bank", "variance": Decimal("125.00"),
                 "gl_balance": Decimal("845000"), "subledger_total": Decimal("844875"),
                 "status": "approved"},
            ],
            flagged_items=[
                {"account_name": "Suspense", "account_number": "1999",
                 "notes": "Need to confirm two unreconciled wire transfers from March before approving."},
            ],
            ai_prepared_count=28,
        ),
        flux=[
            FluxHighlight(
                name="Apr 2026 Flux Analysis",
                period_current=date(2026, 4, 30),
                period_prior=date(2025, 4, 30),
                materiality_threshold=Decimal("10000"),
                approved_by_name="Jane Doe",
                material_variance_count=4,
                top_variances=[
                    {"account_name": "Marketing & Ads", "account_number": "6200",
                     "current": Decimal("48000"), "prior": Decimal("22000"),
                     "absolute": Decimal("26000"), "change_pct": Decimal("118.2"),
                     "narrative": "Marketing spend more than doubled YoY driven by Q2 brand push; "
                                  "$18k of the increase was in paid social, $5k in events, $3k in agency fees."},
                ],
            ),
        ],
        ai=AIReportNarrative(
            executive_summary="Demo Co closed April 2026 with strong revenue growth (+13.6% YoY) and net income of $200k. "
                              "Cash position remains healthy at $1.2M and 15-month runway despite accelerating burn from sales hiring. "
                              "Two reconciliations remain flagged for follow-up.",
            key_highlights=[
                "Revenue grew 13.6% year-over-year to $1.25M, ahead of the 10% plan.",
                "Gross margin held at 70.4%, in line with prior quarter.",
                "Operating cash flow turned negative at -$65k driven by sales hiring; runway still 15 months.",
                "42 of 42 accounts reconciled; 2 flagged for AP follow-up.",
                "Marketing spend +118% YoY — Q2 brand push concentrated in paid social and events.",
            ],
            risks=[
                "Operating cash flow has been negative for 3 consecutive months — extrapolated runway shortens if hiring pace continues.",
                "DSO at 42 days with 12% of AR over 60 days, concentrated in two enterprise accounts.",
                "Suspense account contains two unreconciled wire transfers from March — material risk if reclassified incorrectly.",
            ],
            recommendations=[
                "Prioritize collection on the two large AR accounts over 60 days before quarter-end.",
                "Reconcile the suspense account this week — material risk if classified incorrectly.",
                "Review marketing ROI before extending the Q2 push into Q3.",
                "Re-forecast Q3 cash on the assumption sales hiring continues at current pace.",
            ],
            outlook="Trajectory remains positive on top-line and margin, but Q3 cash management warrants close attention. "
                    "Recommend monthly board update on cash burn through Q3.",
        ),
    )
    buf = BytesIO()
    build_executive_pdf(buf, data=data)
    out = "exec_demo.pdf"
    with open(out, "wb") as f:
        f.write(buf.getvalue())
    print(f"ok {len(buf.getvalue())} bytes -> {out}")
