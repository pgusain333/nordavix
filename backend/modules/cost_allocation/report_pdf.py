"""Nordavix Allocate — the §471(c) client deliverable.

A report a firm can put its name on and hand to a client or their attorney: what
was done, on what authority, what it concluded, and what reaches the return.

It leads with the METHOD and the §448(c) conclusion rather than the numbers,
because under §280E the numbers are only meaningful if the method is available
in the first place. A client above the threshold cannot use §471(c) at all, and
a report that opens with a confident cost of goods sold buries the one fact that
decides whether any of it stands.

An incomplete year is stated on the cover, not discovered on page four. The
watermark and the cover banner both say so.

Shares its design vocabulary with modules/recons/pdf.py — same palette,
formatters and hairlines — so a binder assembled from both reads as one document
set. WinAnsi-safe glyphs only (ReportLab base-14 Helvetica): no arrows, no
U+2212, and the section symbol is spelled out.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, BinaryIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from modules.recons.pdf import (
    BORDER,
    CARD_BG,
    GREEN_TINT,
    GREY_DARK,
    GREY_MID,
    INK,
    ZEBRA,
    _fmt_money,
    _Hairline,
    _styles,
)

SEC = "Section"   # base-14 Helvetica has no reliable section glyph in WinAnsi


def _fmt_qty(v: Decimal) -> str:
    """Thousands-separated, no currency. Square footage is not money, and
    "$8,800.00 square feet" is the kind of detail that costs a report its
    credibility on the first page a client reads."""
    return f"{v:,.0f}"


def _pct(v: Any, dp: int = 2) -> str:
    if v in (None, ""):
        return "-"
    try:
        return f"{Decimal(str(v)) * 100:.{dp}f}%"
    except Exception:
        return str(v)


def _make_doc(buffer: BinaryIO, *, company: str, tax_year: int, complete: bool):
    margin = 0.72 * inch
    footer_band = 0.34 * inch      # rule + caption line at the foot of every page
    page_w, page_h = LETTER
    # The frame STARTS above the footer band rather than at the margin: a frame
    # that runs to the margin lets the last row of a table print through the
    # footer rule, which is what a long completeness list did on page one.
    frame = Frame(
        margin, margin + footer_band,
        page_w - 2 * margin, page_h - 2 * margin - footer_band,
        id="body", topPadding=0, bottomPadding=0,
    )

    def on_page(canvas, doc):
        canvas.saveState()
        if not complete:
            canvas.setFont("Helvetica-Bold", 92)
            canvas.setFillColor(colors.Color(0.86, 0.86, 0.86, alpha=0.40))
            canvas.translate(page_w / 2, page_h / 2)
            canvas.rotate(45)
            canvas.drawCentredString(0, 0, "DRAFT")
            canvas.restoreState()
            canvas.saveState()
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.6)
        canvas.line(margin, margin + 0.20 * inch, page_w - margin, margin + 0.20 * inch)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(GREY_MID)
        canvas.drawString(margin, margin + 0.06 * inch,
                          f"{company}  |  {SEC} 471(c) cost allocation  |  Tax year {tax_year}")
        canvas.drawRightString(page_w - margin, margin + 0.06 * inch, f"Page {doc.page}")
        canvas.restoreState()

    doc = BaseDocTemplate(
        buffer, pagesize=LETTER,
        leftMargin=margin, rightMargin=margin, topMargin=margin, bottomMargin=margin,
        title=f"{SEC} 471(c) cost allocation - {company} - {tax_year}",
        author="Nordavix", subject="Cost of goods sold under IRC 471(c)",
    )
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=on_page)])
    return doc


def _kv_table(rows: list[tuple[str, str]], *, w1=2.5 * inch, w2=4.06 * inch) -> Table:
    t = Table([[k, v] for k, v in rows], colWidths=[w1, w2])
    t.setStyle(TableStyle([
        ("FONT",       (0, 0), (0, -1), "Helvetica", 9),
        ("FONT",       (1, 0), (1, -1), "Helvetica-Bold", 9),
        ("TEXTCOLOR",  (0, 0), (0, -1), GREY_MID),
        ("TEXTCOLOR",  (1, 0), (1, -1), INK),
        ("VALIGN",     (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LINEBELOW",  (0, 0), (-1, -2), 0.4, BORDER),
    ]))
    return t


def _data_table(header: list[str], rows: list[list[str]], widths: list[float],
                *, right_from: int = 1, total_row: bool = False) -> Table:
    t = Table([header, *rows], colWidths=widths, repeatRows=1)
    style = [
        ("FONT",        (0, 0), (-1, 0), "Helvetica-Bold", 8),
        ("TEXTCOLOR",   (0, 0), (-1, 0), INK),
        ("BACKGROUND",  (0, 0), (-1, 0), GREEN_TINT),
        ("FONT",        (0, 1), (-1, -1), "Helvetica", 8.5),
        ("TEXTCOLOR",   (0, 1), (-1, -1), GREY_DARK),
        ("ALIGN",       (right_from, 0), (-1, -1), "RIGHT"),
        ("VALIGN",      (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",  (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW",   (0, 0), (-1, -1), 0.4, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ZEBRA]),
    ]
    if total_row:
        style += [
            ("FONT",      (0, -1), (-1, -1), "Helvetica-Bold", 8.5),
            ("TEXTCOLOR", (0, -1), (-1, -1), INK),
            ("BACKGROUND", (0, -1), (-1, -1), CARD_BG),
            ("LINEABOVE", (0, -1), (-1, -1), 0.8, GREY_MID),
        ]
    t.setStyle(TableStyle(style))
    return t


def build_client_report(buffer: BinaryIO, *, data: dict[str, Any]) -> None:
    """Render the deliverable. `data` is modules.cost_allocation.exports.assemble()."""
    st = _styles()
    annual = data["annual"]
    check = annual["checklist"]
    s = data["settings"]
    company = data["client_name"]
    complete = bool(annual["complete"])

    doc = _make_doc(buffer, company=company, tax_year=data["tax_year"], complete=complete)
    story: list[Any] = []

    # ── Cover ────────────────────────────────────────────────────────────────
    story.append(Paragraph(f"{SEC} 471(c) COST ALLOCATION", st["eyebrow"]))
    story.append(Paragraph(company, st["title"]))
    story.append(Paragraph(
        f"Tax year {data['tax_year']}  |  {annual['year_start']} to {annual['year_end']}",
        st["subtitle"]))
    story.append(Spacer(1, 10))
    story.append(_Hairline(BORDER))
    story.append(Spacer(1, 12))

    if not complete:
        outstanding = (
            len(check["missing_periods"]) + len(check["unapproved_periods"])
            + len(check["unposted_periods"]) + len(check["inventory_breaks"])
        )
        banner = Table([[Paragraph(
            f"<b>Draft - not final.</b> {outstanding} item"
            f"{'' if outstanding == 1 else 's'} outstanding on the year: see "
            "Completeness of the year, below. The figures in this report are "
            "built on an incomplete year and should not be filed from.",
            st["note"])]], colWidths=[6.56 * inch])
        banner.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FDF3E7")),
            ("BOX",        (0, 0), (-1, -1), 0.6, colors.HexColor("#E0B27A")),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ]))
        story.append(banner)
        story.append(Spacer(1, 14))

    story.append(Paragraph("The method", st["eyebrow"]))
    story.append(Paragraph(
        "Under IRC 280E a cannabis business may not deduct ordinary business "
        "expenses, but cost of goods sold reduces gross receipts and is not a "
        "deduction. IRC 471(c) permits a small business taxpayer to determine "
        "inventory costs according to its own books and records. The allocation "
        "below applies that method: expense accounts are assigned to cost pools, "
        "and each pool is either fully inventoriable, apportioned by a stated "
        "driver, or left disallowed.",
        st["body"]))
    story.append(Spacer(1, 8))
    story.append(_kv_table([
        ("Method elected", "Conform to applicable financial statement - 471(c)(1)(B)(i)"
                           if s["method"] == "afs"
                           else "Books and records - 471(c)(1)(B)(ii)"),
        ("Applicable financial statement", "Yes" if s["has_afs"] else "No"),
        ("Inventory method", "Period roll-forward"),
        ("Allocation performed", "Annually, after year end" if s["frequency"] == "annual"
                                 else "Monthly, with the close"),
        ("Fiscal year end", s["fiscal_year_end"] or "12-31 (calendar year)"),
        ("Report prepared", data["prepared_at"].date().isoformat()),
    ]))
    story.append(Spacer(1, 16))

    # ── Eligibility ──────────────────────────────────────────────────────────
    story.append(Paragraph("Eligibility to use the method", st["eyebrow"]))
    e = data["eligibility"]
    if e is None:
        story.append(Paragraph(
            "<b>No 448(c) conclusion is on file for this tax year.</b> "
            "Section 471(c) is available only to a small business taxpayer - "
            "three-year average gross receipts at or under the annually indexed "
            "448(c) threshold, tested across commonly controlled entities. Until "
            "that test is performed and documented, the availability of the method "
            "is unsupported.",
            st["body"]))
    else:
        verdict = "Eligible" if e["eligible"] else "NOT eligible"
        story.append(Paragraph(
            f"<b>{verdict}.</b> Three-year average gross receipts of "
            f"{_fmt_money(Decimal(e['three_year_avg']))} against a threshold of "
            f"{_fmt_money(Decimal(e['threshold']))}. Receipts are aggregated across "
            "commonly controlled entities under 448(c)(2), which applies the rules of "
            "52(a), 52(b), 414(m) and 414(o).",
            st["body"]))
        if e["aggregation_note"]:
            story.append(Paragraph(f"Aggregation basis: {e['aggregation_note']}", st["oblique"]))
        if e["entities"]:
            story.append(Spacer(1, 7))
            ent_rows = [[
                str(r.get("entity", "")), str(r.get("year", "")),
                _fmt_money(Decimal(str(r.get("amount", 0)))),
            ] for r in e["entities"]]
            story.append(_data_table(
                ["Entity", "Year", "Gross receipts"], ent_rows,
                [3.6 * inch, 1.0 * inch, 1.96 * inch], right_from=1))
    story.append(Spacer(1, 16))

    # ── Completeness ─────────────────────────────────────────────────────────
    story.append(Paragraph("Completeness of the year", st["eyebrow"]))
    story.append(Paragraph(
        "An annual figure is only as good as the periods behind it. Each control "
        "below was run against this year's allocations.",
        st["body"]))
    story.append(Spacer(1, 7))

    def _ok(passed: bool, detail: str) -> str:
        mark = "Pass" if passed else "EXCEPTION"
        return f"{mark} - {detail}" if detail else mark

    story.append(_kv_table([
        (f"All {check['months_expected']} period"
         f"{'' if check['months_expected'] == 1 else 's'} allocated",
         _ok(not check["missing_periods"],
             ", ".join(check["missing_periods"]) or f"{check['months_present']} present")),
        ("Every period approved",
         _ok(not check["unapproved_periods"], ", ".join(check["unapproved_periods"]))),
        ("Entries confirmed in the books",
         _ok(not check["unposted_periods"], ", ".join(check["unposted_periods"]))),
        ("Inventory chain unbroken",
         _ok(not check["inventory_breaks"],
             ", ".join(b["period_end"] for b in check["inventory_breaks"]))),
        ("448(c) test concluded",
         _ok(check["eligibility_concluded"] and check["eligible"] is not False, "")),
    ]))
    story.append(PageBreak())

    # ── The numbers ──────────────────────────────────────────────────────────
    t = annual["totals"]
    story.append(Paragraph("What the year concluded", st["eyebrow"]))
    story.append(Paragraph("Cost of goods sold", st["title"]))
    story.append(Spacer(1, 10))

    cards = Table([[
        Paragraph(f"<font size=8 color='#8A8F98'>EXPENSES IN SCOPE</font><br/>"
                  f"<font size=15><b>{_fmt_money(Decimal(t['total_expenses'] or 0))}</b></font>", st["note"]),
        Paragraph(f"<font size=8 color='#8A8F98'>CAPITALIZED</font><br/>"
                  f"<font size=15 color='#3E8F66'><b>{_fmt_money(Decimal(t['capitalized'] or 0))}</b></font>", st["note"]),
        Paragraph(f"<font size=8 color='#8A8F98'>DISALLOWED (280E)</font><br/>"
                  f"<font size=15 color='#C0392B'><b>{_fmt_money(Decimal(t['disallowed'] or 0))}</b></font>", st["note"]),
    ]], colWidths=[2.19 * inch] * 3)
    cards.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CARD_BG),
        ("BOX",        (0, 0), (-1, -1), 0.5, BORDER),
        ("INNERGRID",  (0, 0), (-1, -1), 0.5, BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(cards)
    story.append(Spacer(1, 16))

    rf = annual["roll_forward"]
    if rf:
        story.append(Paragraph("Inventory roll-forward", st["eyebrow"]))
        story.append(_data_table(
            ["", "Amount"],
            [
                ["Beginning inventory", _fmt_money(Decimal(rf["beginning_inventory"]))],
                ["Capitalized cost for the year", _fmt_money(Decimal(rf["capitalized"]))],
                ["Purchases", _fmt_money(Decimal(rf["purchases"]))],
                ["Ending inventory", f"({_fmt_money(Decimal(rf['ending_inventory']))})"],
                ["Cost of goods sold", _fmt_money(Decimal(rf["cogs"]))],
            ],
            [4.56 * inch, 2.0 * inch], total_row=True))
        story.append(Spacer(1, 16))

    f = annual["form_1125a"]
    story.append(Paragraph("Form 1125-A, Cost of Goods Sold", st["eyebrow"]))
    story.append(_data_table(
        ["Line", "", "Amount"],
        [
            ["1", "Inventory at beginning of year", _fmt_money(Decimal(f["line_1_beginning_inventory"]))],
            ["2", "Purchases", _fmt_money(Decimal(f["line_2_purchases"]))],
            ["3", "Cost of labor", _fmt_money(Decimal(f["line_3_cost_of_labor"]))],
            ["5", "Other costs", _fmt_money(Decimal(f["line_5_other_costs"]))],
            ["6", "Total", _fmt_money(Decimal(f["line_6_total"]))],
            ["7", "Inventory at end of year", _fmt_money(Decimal(f["line_7_ending_inventory"]))],
            ["8", "Cost of goods sold", _fmt_money(Decimal(f["line_8_cogs"]))],
        ],
        [0.55 * inch, 4.01 * inch, 2.0 * inch], right_from=2, total_row=True))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "Line 4 (additional 263A costs) is not presented: 280E denies 263A to this "
        "taxpayer, which is the reason 471(c) is used.",
        st["oblique"]))
    story.append(PageBreak())

    # ── Basis ────────────────────────────────────────────────────────────────
    story.append(Paragraph("How the allocation was made", st["eyebrow"]))
    story.append(Paragraph("Pools and drivers", st["title"]))
    story.append(Spacer(1, 10))

    cap_by_pool = {p["pool_name"]: p["capitalized"] for p in annual["by_pool"]}
    pool_rows = []
    for p in data["pools"]:
        if not p["active"]:
            continue
        if p["treatment"] == "direct":
            basis = "Fully inventoriable"
        elif p["treatment"] == "excluded":
            basis = "Disallowed under 280E"
        elif p["driver"] == "blended":
            basis = (f"{_pct(Decimal(p['blend_payroll_wt'] or 0) / 100, 0)} payroll, "
                     f"{_pct(Decimal(p['blend_occupancy_wt'] or 0) / 100, 0)} occupancy")
        elif p["driver"] == "fixed":
            basis = f"Fixed {_pct(Decimal(p['fixed_pct'] or 0) / 100, 2)}"
        else:
            basis = f"By {p['driver']}"
        pool_rows.append([
            p["name"], basis,
            "Labor" if p["form_1125a_line"] == "labor" else "Other",
            _fmt_money(Decimal(cap_by_pool.get(p["name"], "0"))),
        ])
    story.append(_data_table(
        ["Pool", "Basis", "1125-A", "Capitalized"], pool_rows,
        [1.95 * inch, 2.45 * inch, 0.76 * inch, 1.4 * inch], right_from=3))
    story.append(Spacer(1, 14))

    total_sqft = sum(Decimal(sp["square_feet"]) for sp in data["spaces"]) if data["spaces"] else Decimal(0)
    story.append(Paragraph(
        f"<b>Occupancy driver.</b> {len(data['spaces'])} space"
        f"{'' if len(data['spaces']) == 1 else 's'} on file totalling "
        f"{_fmt_qty(total_sqft)} square feet. Production areas carry inventoriable "
        "cost; shared areas apply a stated production percentage rather than an "
        "assumed one.", st["body"]))
    splits = [
        e for e in data["employees"]
        if Decimal(0) < Decimal(e["production_pct"] or "0") < Decimal(100)
    ]
    unsupported = [e for e in splits if not (e["split_basis"] or "").strip()]
    story.append(Paragraph(
        f"<b>Payroll driver.</b> {len(data['employees'])} classified employee"
        f"{'' if len(data['employees']) == 1 else 's'}, of which {len(splits)} "
        f"carr{'ies' if len(splits) == 1 else 'y'} a part-production split. "
        "A full classification follows from the job; a split is an estimate, so "
        "the basis for each one is recorded against the person."
        + (f" {len(unsupported)} split{'' if len(unsupported) == 1 else 's'} "
           "currently ha" + ("s" if len(unsupported) == 1 else "ve")
           + " no stated basis." if unsupported else ""),
        st["body"]))
    story.append(Spacer(1, 10))

    if splits:
        story.append(_data_table(
            ["Employee", "Production %", "Basis for the split"],
            [[e["name"], _pct(Decimal(e["production_pct"]) / 100, 0),
              (e["split_basis"] or "Not stated")] for e in splits],
            [1.6 * inch, 1.0 * inch, 3.96 * inch], right_from=1))
        story.append(Spacer(1, 14))

    if data["runs"]:
        story.append(Paragraph("Drivers applied, by period", st["eyebrow"]))
        run_rows = [[
            r["period_end"], r["status"].replace("_", " "),
            _pct(r["payroll_factor"]), _pct(r["occupancy_factor"]),
            "Yes" if r["posted_at"] else "No",
        ] for r in data["runs"]]
        story.append(_data_table(
            ["Period end", "Status", "Payroll factor", "Occupancy factor", "Posted"],
            run_rows,
            [1.3 * inch, 1.3 * inch, 1.4 * inch, 1.5 * inch, 1.06 * inch], right_from=2))
    story.append(Spacer(1, 16))

    story.append(KeepTogether([
        _Hairline(BORDER),
        Spacer(1, 8),
        Paragraph(
            "This report presents a cost allocation prepared under IRC 471(c) from "
            "the taxpayer's books and records. It is not a tax opinion and does not "
            "constitute assurance on the financial statements. The 471(c) position "
            "and the treatment of costs under 280E are actively contested; the "
            "allocation should be read together with the supporting workpaper and "
            "the taxpayer's written accounting procedures.",
            st["oblique"]),
        Spacer(1, 6),
        Paragraph(
            f"Prepared with Nordavix Allocate on "
            f"{data['prepared_at'].strftime('%d %B %Y')}.", st["oblique"]),
    ]))

    doc.build(story)
