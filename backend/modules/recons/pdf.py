"""
Per-account reconciliation PDF — "reconciliation packet" layout.

One working paper for a single (account, period), styled as a modern audit
packet: a slim top bar, a green eyebrow, a large account title, a four-card
meta row, a Balance summary (per general ledger = per source, two big
numbers), the reconciliation build-up (opening + every ticked reconciling
item = reconciled balance), any explicitly-outstanding open items, the AI
reconciliation summary (kept verbatim), and the prepared/approved sign-off.

Design notes:
  * No logo / brand mark anywhere.
  * Generalized beyond bank rec — the "source" side adapts to the account
    type (bank statement / AR aging / AP aging / card statement / subledger).
  * No attestation / signature scrawl — just prepared-by / approved-by names.
  * Green = brand accent + positive amounts; red = negative amounts.
  * A faint DRAFT watermark until the account is approved.
  * WinAnsi-safe glyphs only (ReportLab base-14 Helvetica): plain text,
    en-dashes, and an ASCII "=" — no check-marks or U+2212.
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

# ── Palette ──────────────────────────────────────────────────────────────────
INK        = colors.HexColor("#14181A")
GREY_DARK  = colors.HexColor("#3C4146")
GREY_MID   = colors.HexColor("#8A8F98")
BORDER     = colors.HexColor("#E6E4DF")
CARD_BG    = colors.HexColor("#FAFAF8")
ZEBRA      = colors.HexColor("#FAF9F6")
GREEN      = colors.HexColor("#3E8F66")
GREEN_TINT = colors.HexColor("#EAF4EE")
RED        = colors.HexColor("#C0392B")
WHITE      = colors.white


# ── Formatters ───────────────────────────────────────────────────────────────
def _to_decimal(v: Any, default: str = "0") -> Decimal:
    try:
        return v if isinstance(v, Decimal) else Decimal(str(v if v not in (None, "") else default))
    except Exception:
        return Decimal(default)


def _fmt_money(v: Decimal | str | None) -> str:
    d = _to_decimal(v)
    if d == 0:
        return "$0.00"
    abs_s = f"{abs(d).quantize(Decimal('0.01')):,.2f}"
    return f"$({abs_s})" if d < 0 else f"${abs_s}"


def _fmt_signed(v: Decimal | str | None) -> str:
    d = _to_decimal(v)
    if d == 0:
        return "0.00"
    abs_s = f"{abs(d).quantize(Decimal('0.01')):,.2f}"
    return f"- {abs_s}" if d < 0 else f"+ {abs_s}"


def _amount_color(v: Decimal | str | None) -> colors.Color:
    d = _to_decimal(v)
    return GREEN if d > 0 else (RED if d < 0 else GREY_MID)


def _fmt_date(d: date | str | None) -> str:
    if d is None or d == "":
        return "—"
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d[:10])
        except Exception:
            return d
    return d.strftime("%b %d, %Y")


def _fmt_date_long(d: date) -> str:
    return d.strftime("%d %B %Y")


def _fmt_date_short(d: date | str | None) -> str:
    if d is None or d == "":
        return ""
    if isinstance(d, str):
        try:
            d = date.fromisoformat(d[:10])
        except Exception:
            return d
    return d.strftime("%d %b")


def _fmt_ts(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return d.strftime("%d %b %Y · %H:%M")
    except Exception:
        return iso[:16].replace("T", " ")


def _period_label(pe: date) -> str:
    q = (pe.month - 1) // 3 + 1
    if pe.month in (3, 6, 9, 12):
        return f"Q{q} {pe.year}"
    return pe.strftime("%b %Y")


_STATUS = {
    "approved": ("Reconciled", GREEN),
    "reviewed": ("In review", colors.HexColor("#B45309")),
    "flagged":  ("Flagged", RED),
    "pending":  ("Open", GREY_MID),
}


def _source_label(account_type: str | None) -> tuple[str, str]:
    t = (account_type or "").lower()
    if "bank" in t or "cash" in t:
        return ("Per bank statement", "Bank statement")
    if "credit card" in t or "creditcard" in t:
        return ("Per card statement", "Card statement")
    if "receivable" in t or t.strip() == "ar":
        return ("Per AR subledger", "AR aging detail")
    if "payable" in t or t.strip() == "ap":
        return ("Per AP subledger", "AP aging detail")
    return ("Per subledger", "Supporting subledger")


# ── Styles ───────────────────────────────────────────────────────────────────
def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()

    def mk(n, **kw):
        return ParagraphStyle(n, parent=base["BodyText"], **kw)

    return {
        "eyebrow":  mk("eyebrow", fontName="Helvetica-Bold", fontSize=8, leading=11,
                       textColor=GREEN, spaceAfter=4),
        "title":    mk("title", fontName="Helvetica-Bold", fontSize=23, leading=27,
                       textColor=INK, spaceAfter=2),
        "subtitle": mk("subtitle", fontName="Helvetica", fontSize=11, leading=14,
                       textColor=GREY_MID, spaceAfter=2),
        "lede":     mk("lede", fontName="Helvetica", fontSize=9.5, leading=14,
                       textColor=GREY_DARK, spaceBefore=6, spaceAfter=2),
        "body":     mk("body", fontName="Helvetica", fontSize=9.5, leading=14,
                       textColor=GREY_DARK, spaceAfter=4),
        "note":     mk("note", fontName="Helvetica", fontSize=9.5, leading=14.5,
                       textColor=GREY_DARK),
        "oblique":  mk("oblique", fontName="Helvetica-Oblique", fontSize=9, leading=12,
                       textColor=GREY_MID),
    }


# ── Hairline ─────────────────────────────────────────────────────────────────
class _Hairline(Flowable):
    def __init__(self, color: colors.Color, w: float = 0.75):
        super().__init__()
        self.c, self.w, self.width, self.height = color, w, 0, w

    def wrap(self, aw, ah):
        self.width = aw
        return (aw, self.height)

    def draw(self):
        self.canv.setStrokeColor(self.c)
        self.canv.setLineWidth(self.w)
        self.canv.line(0, 0, self.width, 0)


# ── Page template (footer, watermark — NO logo) ─────────────────────────────
def _make_doc(buffer, *, company, account_label, doc_ref, period_end, is_draft):
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
        canvas.drawCentredString(page_w / 2, y, "Locked · replayable for 7 years")
        canvas.setFillColor(GREY_MID)
        canvas.drawRightString(page_w - margin, y, f"Page {canvas.getPageNumber()} · {doc_ref}")
        canvas.restoreState()

    tpl = PageTemplate(id="body", frames=[frame], onPage=on_page)
    doc = BaseDocTemplate(buffer, pagesize=LETTER, leftMargin=margin, rightMargin=margin,
                          topMargin=margin, bottomMargin=margin,
                          title=f"Reconciliation · {account_label} · {period_end.isoformat()}",
                          author=company)
    doc.addPageTemplates([tpl])
    return doc


# ── Meta card row ────────────────────────────────────────────────────────────
def _meta_cards(data, pe, body_w) -> Table:
    def sx(**k):
        return ParagraphStyle("x", **k)
    lab = sx(fontName="Helvetica-Bold", fontSize=6.5, leading=9, textColor=GREY_MID)
    val = sx(fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=INK)
    sub = sx(fontName="Helvetica", fontSize=7.5, leading=10, textColor=GREY_MID)

    gl = _to_decimal(data.get("gl_balance"))
    sl = _to_decimal(data.get("subledger_balance"))
    variance = gl - sl
    tied = abs(variance) < Decimal("1.00")
    status_word, status_col = _STATUS.get(data.get("status", "pending"),
                                          (str(data.get("status", "")).title(), GREY_MID))
    val_g = sx(fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=status_col)
    val_v = sx(fontName="Helvetica-Bold", fontSize=11, leading=14,
               textColor=(GREEN if tied else RED))

    acct_no = data.get("account_number") or "—"
    acct_nm = (data.get("account_name") or "—")
    src_cap = _source_label(data.get("account_type"))[1]

    def cell(label, value, sub_text, vstyle=val):
        return [Paragraph(label.upper(), lab), Spacer(1, 4),
                Paragraph(value, vstyle), Paragraph(sub_text, sub)]

    cells = [
        cell("Account", acct_no, acct_nm[:30]),
        cell("Period ending", _fmt_date(pe), _period_label(pe)),
        cell("Variance", _fmt_money(Decimal("0") if tied else variance),
             ("Tied to source" if tied else "Out of balance"), val_v),
        cell("Status", status_word, f"vs {src_cap.lower()}", val_g),
    ]
    gap = 0.14 * inch
    cw = (body_w - 3 * gap) / 4.0
    row, widths = [], []
    for i, c in enumerate(cells):
        row.append(c)
        widths.append(cw)
        if i < 3:
            row.append("")
            widths.append(gap)
    t = Table([row], colWidths=widths)
    style = [("VALIGN", (0, 0), (-1, -1), "TOP")]
    for ci in (0, 2, 4, 6):
        style += [
            ("BACKGROUND", (ci, 0), (ci, 0), CARD_BG),
            ("BOX", (ci, 0), (ci, 0), 0.5, BORDER),
            ("LEFTPADDING", (ci, 0), (ci, 0), 10), ("RIGHTPADDING", (ci, 0), (ci, 0), 10),
            ("TOPPADDING", (ci, 0), (ci, 0), 9), ("BOTTOMPADDING", (ci, 0), (ci, 0), 10),
        ]
    for gi in (1, 3, 5):
        style += [("LEFTPADDING", (gi, 0), (gi, 0), 0), ("RIGHTPADDING", (gi, 0), (gi, 0), 0)]
    t.setStyle(TableStyle(style))
    return t


# ── Balance summary: per GL  =  per source ──────────────────────────────────
def _balance_summary(data, pe, body_w) -> Table:
    gl = _to_decimal(data.get("gl_balance"))
    sl = _to_decimal(data.get("subledger_balance"))
    tied = abs(gl - sl) < Decimal("1.00")
    src_label, src_cap = _source_label(data.get("account_type"))

    lab = ParagraphStyle("bl", fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=GREY_MID)
    big = ParagraphStyle("bb", fontName="Helvetica-Bold", fontSize=21, leading=25, textColor=INK)
    sub = ParagraphStyle("bs", fontName="Helvetica", fontSize=8, leading=11, textColor=GREY_MID)
    eq = ParagraphStyle("eq", fontName="Helvetica", fontSize=22, leading=25,
                        textColor=(GREEN if tied else RED), alignment=1)

    def side(label, amount, caption):
        return [Paragraph(label.upper(), lab), Spacer(1, 3),
                Paragraph(_fmt_money(amount), big), Spacer(1, 2),
                Paragraph(caption, sub)]

    eq_w = 0.5 * inch
    col = (body_w - eq_w) / 2.0
    left = side("Per general ledger", gl, f"As reported · acct {data.get('account_number') or '—'}")
    right = side(src_label, sl, f"{src_cap} · {pe.strftime('%d %b')}")
    t = Table([[left, Paragraph("=" if tied else "≠", eq), right]],
              colWidths=[col, eq_w, col])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return t


# ── Reconciliation build-up — opening + RECONCILED (ticked) items ──────────
def _buildup(data, body_w) -> Table:
    flip = -1 if data.get("is_credit_natural") else 1
    opening = _to_decimal(data.get("opening_balance"))
    items = data.get("reconciling_items") or []
    saved_sl = _to_decimal(data.get("subledger_balance"))

    def signed(it):
        raw = _to_decimal(it.get("amount"))
        return raw if str(it.get("txn_id", "")).startswith("manual-") else flip * raw

    memo = ParagraphStyle("m", fontName="Helvetica", fontSize=9, leading=12, textColor=GREY_DARK)
    memo_b = ParagraphStyle("mb", fontName="Helvetica-Bold", fontSize=9.5, leading=12, textColor=INK)

    def sub(s):
        return f"<br/><font size='7.5' color='{GREY_MID.hexval()}'>{s}</font>"

    # The build-up IS the reconciled composition: opening balance + every
    # reconciling item the preparer ticked = reconciled balance. The recon
    # drawer only ever persists ticked items, so a saved item is reconciled
    # by default — it counts as still-open ONLY when explicitly flagged
    # cleared=False (those are listed separately under "Reconciling items ·
    # open"). This is why ticked items must never fall through to "open".
    reconciled = [it for it in items if it.get("cleared") is not False]

    header = ["Date", "Description", "Reference", "Amount"]
    rows = [header]

    op_src = (data.get("opening_source") or "").strip()
    rows.append(["", Paragraph("Opening balance" + (sub(op_src) if op_src else ""), memo_b),
                 "rolled forward", _fmt_signed(opening)])
    open_idx = len(rows) - 1

    reconciled_sum = Decimal("0")
    item_rows: list[int] = []
    item_vals: list[Decimal] = []
    for it in reconciled:
        s = signed(it); reconciled_sum += s
        rows.append([_fmt_date_short(it.get("txn_date") or ""),
                     Paragraph((it.get("memo") or it.get("txn_type") or "Reconciling item")[:120], memo),
                     (it.get("txn_number") or "—")[:16],
                     _fmt_signed(s)])
        item_rows.append(len(rows) - 1)
        item_vals.append(s)

    adj = saved_sl - (opening + reconciled_sum)
    if abs(adj) >= Decimal("0.01"):
        rows.append(["", Paragraph("Other adjustments to subledger"
                     + sub("net of open items below, aging, or manual override"), memo),
                     "auto", _fmt_signed(adj)])
        item_rows.append(len(rows) - 1)
        item_vals.append(adj)

    # Footer — be honest about whether the GL actually ties to the subledger.
    # The build-up always foots to the closing subledger; only call it
    # "reconciled / matches source" (green) when the GL truly equals it.
    # Otherwise show the GL and the unreconciled variance so the packet never
    # claims a tie that isn't there.
    gl = _to_decimal(data.get("gl_balance"))
    tied = abs(gl - saved_sl) < Decimal("1.00")
    acct_no = data.get("account_number") or "—"

    if tied:
        rows.append(["", Paragraph("Reconciled balance — matches source", memo_b),
                     "", _fmt_money(saved_sl)])
        total_idx = len(rows) - 1
        gl_idx = var_idx = None
    else:
        rows.append(["", Paragraph("Closing balance — per subledger", memo_b),
                     "", _fmt_money(saved_sl)])
        total_idx = len(rows) - 1
        rows.append(["", Paragraph("Per general ledger" + sub(f"acct {acct_no} · as reported"), memo),
                     "", _fmt_money(gl)])
        gl_idx = len(rows) - 1
        rows.append(["", Paragraph("Unreconciled variance — does not tie to GL", memo_b),
                     "", _fmt_money(saved_sl - gl)])
        var_idx = len(rows) - 1

    desc_w = body_w - 0.8 * inch - 1.15 * inch - 1.2 * inch
    t = Table(rows, colWidths=[0.8 * inch, desc_w, 1.15 * inch, 1.2 * inch], repeatRows=1)
    style = [
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), GREY_MID),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, INK),
        ("ALIGN", (-1, 0), (-1, -1), "RIGHT"),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
        ("FONT", (0, 1), (0, -1), "Helvetica", 8),
        ("FONT", (2, 1), (2, -1), "Helvetica", 8),
        ("TEXTCOLOR", (0, 1), (0, -1), GREY_MID),
        ("TEXTCOLOR", (2, 1), (2, -1), GREY_MID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, open_idx), (-1, open_idx), 0.25, BORDER),
        ("LINEABOVE", (0, total_idx), (-1, total_idx), 1.0, INK),
        ("FONT", (0, total_idx), (-1, total_idx), "Helvetica-Bold", 10),
        ("TEXTCOLOR", (-1, total_idx), (-1, total_idx), GREEN if tied else INK),
        ("TOPPADDING", (0, total_idx), (-1, total_idx), 9),
        ("BOTTOMPADDING", (0, total_idx), (-1, total_idx), 9 if tied else 4),
    ]
    if not tied:
        style += [
            ("TOPPADDING", (0, gl_idx), (-1, gl_idx), 2),
            ("BOTTOMPADDING", (0, gl_idx), (-1, gl_idx), 4),
            ("TEXTCOLOR", (-1, gl_idx), (-1, gl_idx), GREY_MID),
            ("LINEABOVE", (0, var_idx), (-1, var_idx), 0.5, BORDER),
            ("FONT", (0, var_idx), (-1, var_idx), "Helvetica-Bold", 10),
            ("TEXTCOLOR", (-1, var_idx), (-1, var_idx), RED),
            ("TOPPADDING", (0, var_idx), (-1, var_idx), 6),
            ("BOTTOMPADDING", (0, var_idx), (-1, var_idx), 9),
        ]
    for n, idx in enumerate(item_rows):
        style.append(("TEXTCOLOR", (-1, idx), (-1, idx), _amount_color(item_vals[n])))
        if n % 2 == 1:
            style.append(("BACKGROUND", (0, idx), (-1, idx), ZEBRA))
    t.setStyle(TableStyle(style))
    return t


# ── Open reconciling items (explicitly un-cleared / outstanding) ─────────────
def _reconciling_items(data, body_w) -> list[Any] | None:
    # Only genuinely-open items belong here: ones EXPLICITLY flagged not
    # cleared. Everything else is part of the reconciled build-up above, so a
    # ticked reconciling item never wrongly appears as "open".
    items = [it for it in (data.get("reconciling_items") or []) if it.get("cleared") is False]
    if not items:
        return None
    memo = ParagraphStyle("rm", fontName="Helvetica", fontSize=8.5, leading=11, textColor=GREY_DARK)
    typ = ParagraphStyle("rt", fontName="Helvetica-Bold", fontSize=8.5, leading=11, textColor=INK)
    flip = -1 if data.get("is_credit_natural") else 1

    def signed(it):
        raw = _to_decimal(it.get("amount"))
        return raw if str(it.get("txn_id", "")).startswith("manual-") else flip * raw

    header = ["Type", "Description", "Reference", "Date", "Amount", "Status"]
    rows = [header]
    total = Decimal("0")
    amt_idx = []
    for it in items:
        s = signed(it); total += s
        is_manual = str(it.get("txn_id", "")).startswith("manual-")
        status = "Manual" if is_manual else "Open"
        rows.append([
            Paragraph((it.get("txn_type") or "Item")[:18], typ),
            Paragraph((it.get("memo") or "—")[:90], memo),
            (it.get("txn_number") or "—")[:14],
            _fmt_date_short(it.get("txn_date") or ""),
            _fmt_signed(s),
            status,
        ])
        amt_idx.append(len(rows) - 1)
    rows.append(["", Paragraph("Net reconciling adjustment", typ), "", "", _fmt_signed(total), ""])
    total_idx = len(rows) - 1

    widths = [0.95 * inch, body_w - 0.95 * inch - 1.0 * inch - 0.75 * inch - 1.0 * inch - 0.7 * inch,
              1.0 * inch, 0.75 * inch, 1.0 * inch, 0.7 * inch]
    t = Table(rows, colWidths=widths, repeatRows=1)
    style = [
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), GREY_MID),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, INK),
        ("ALIGN", (4, 0), (4, -1), "RIGHT"),
        ("FONT", (2, 1), (3, -1), "Helvetica", 8),
        ("TEXTCOLOR", (2, 1), (3, -1), GREY_MID),
        ("FONT", (4, 1), (4, -1), "Helvetica", 9),
        ("FONT", (5, 1), (5, -1), "Helvetica-Bold", 7.5),
        ("TEXTCOLOR", (5, 1), (5, -1), GREY_MID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("LINEABOVE", (0, total_idx), (-1, total_idx), 0.75, INK),
        ("FONT", (1, total_idx), (1, total_idx), "Helvetica-Bold", 9),
        ("TEXTCOLOR", (4, total_idx), (4, total_idx), (GREEN if abs(total) < Decimal("1") else INK)),
        ("FONT", (4, total_idx), (4, total_idx), "Helvetica-Bold", 9.5),
        ("TOPPADDING", (0, total_idx), (-1, total_idx), 8), ("BOTTOMPADDING", (0, total_idx), (-1, total_idx), 8),
    ]
    for n, (idx, it) in enumerate(zip(amt_idx, items, strict=False)):
        style.append(("TEXTCOLOR", (4, idx), (4, idx), _amount_color(signed(it))))
        if n % 2 == 1:
            style.append(("BACKGROUND", (0, idx), (-1, idx), ZEBRA))
    t.setStyle(TableStyle(style))
    return [t]


# ── AI reconciliation summary — green note callout (kept verbatim) ──────────
def _ai_summary(commentary: dict, styles, body_w) -> list[Any]:
    out: list[Any] = []
    narrative = (commentary.get("narrative") or "").strip()
    conf = (commentary.get("confidence") or "").title()
    rec = (commentary.get("recommendation") or "").lower()
    rec_label = {"approve": "Approve as-is", "review": "Review flagged items",
                 "investigate": "Investigate before approving"}.get(rec, rec.title())
    checks = commentary.get("checks") or []

    inner = [Paragraph("AI RECONCILIATION SUMMARY", ParagraphStyle(
        "ainote_h", fontName="Helvetica-Bold", fontSize=7.5, leading=11, textColor=GREEN, spaceAfter=4))]
    if narrative:
        inner.append(Paragraph(narrative, styles["note"]))
    if conf or rec_label:
        inner.append(Spacer(1, 4))
        inner.append(Paragraph(
            f"<font color='{GREY_MID.hexval()}'><b>Confidence:</b></font> {conf or '—'}"
            f" &nbsp;&nbsp;·&nbsp;&nbsp; <font color='{GREY_MID.hexval()}'><b>Recommendation:</b></font> {rec_label or '—'}",
            ParagraphStyle("ai_meta", fontName="Helvetica", fontSize=8.5, leading=12, textColor=GREY_DARK)))
    note = Table([[inner]], colWidths=[body_w])
    note.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN_TINT),
        ("LINEBEFORE", (0, 0), (0, -1), 3, GREEN),
        ("LEFTPADDING", (0, 0), (-1, -1), 13), ("RIGHTPADDING", (0, 0), (-1, -1), 13),
        ("TOPPADDING", (0, 0), (-1, -1), 11), ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
    ]))
    out.append(note)

    if checks:
        rows = [["Check", "Status", "Detail"]]
        for c in checks:
            sraw = (c.get("status") or "pass").lower()
            rows.append([c.get("name") or "—",
                         {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}.get(sraw, sraw.upper()),
                         Paragraph(c.get("detail") or "—", styles["body"])])
        t = Table(rows, colWidths=[1.7 * inch, 0.8 * inch, body_w - 2.5 * inch], repeatRows=1)
        cstyle = [
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7.5),
            ("TEXTCOLOR", (0, 0), (-1, 0), GREY_MID),
            ("LINEBELOW", (0, 0), (-1, 0), 0.5, BORDER),
            ("FONT", (0, 1), (-1, -1), "Helvetica", 8.5),
            ("TEXTCOLOR", (0, 1), (-1, -1), GREY_DARK),
            ("FONT", (1, 1), (1, -1), "Helvetica-Bold", 8.5),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ]
        for ri in range(1, len(rows)):
            sval = rows[ri][1]
            col = {"PASS": GREEN, "WARN": colors.HexColor("#B45309"), "FAIL": RED}.get(sval, GREY_MID)
            cstyle.append(("TEXTCOLOR", (1, ri), (1, ri), col))
            if ri < len(rows) - 1:
                cstyle.append(("LINEBELOW", (0, ri), (-1, ri), 0.25, BORDER))
        t.setStyle(TableStyle(cstyle))
        out.append(Spacer(1, 8))
        out.append(t)
    return out


# ── Prepared / approved sign-off (names + dates, not a signature) ───────────
def _signoff(data, body_w) -> Table:
    def col(label, name, when):
        inner = [Paragraph(label.upper(), ParagraphStyle(
            "so_l", fontName="Helvetica-Bold", fontSize=7, leading=10, textColor=GREY_MID, spaceAfter=5))]
        inner.append(Paragraph(name or "Not yet recorded", ParagraphStyle(
            "so_n", fontName="Helvetica-Bold", fontSize=12, leading=15,
            textColor=(INK if name else GREY_MID))))
        ts = _fmt_ts(when)
        inner.append(Paragraph(ts if ts else "—", ParagraphStyle(
            "so_w", fontName="Helvetica", fontSize=8, leading=11, textColor=GREY_MID, spaceBefore=3)))
        return inner

    gap = 0.3 * inch
    cw = (body_w - gap) / 2.0
    t = Table([[col("Prepared by", data.get("prepared_by_name"), data.get("prepared_at")),
                "",
                col("Approved by", data.get("approved_by_name"), data.get("approved_at"))]],
              colWidths=[cw, gap, cw])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (0, 0), CARD_BG), ("BACKGROUND", (2, 0), (2, 0), CARD_BG),
        ("BOX", (0, 0), (0, 0), 0.5, BORDER), ("BOX", (2, 0), (2, 0), 0.5, BORDER),
        ("LEFTPADDING", (0, 0), (0, 0), 14), ("RIGHTPADDING", (0, 0), (0, 0), 14),
        ("LEFTPADDING", (2, 0), (2, 0), 14), ("RIGHTPADDING", (2, 0), (2, 0), 14),
        ("LEFTPADDING", (1, 0), (1, 0), 0), ("RIGHTPADDING", (1, 0), (1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 14), ("BOTTOMPADDING", (0, 0), (-1, -1), 16),
    ]))
    return t


def _docs(data, styles) -> list[Any]:
    files = data.get("evidence_files") or []
    if not files:
        return [Paragraph("No supporting documents uploaded for this period.", styles["oblique"])]
    out = []
    for f in files:
        name = f.get("file_name") or "(unnamed file)"
        when = _fmt_date(f.get("uploaded_at"))
        out.append(Paragraph(
            f"<font color='{GREEN.hexval()}'>•</font>&nbsp;&nbsp;<b>{name}</b>"
            + (f" &nbsp;<font color='{GREY_MID.hexval()}'>· uploaded {when}</font>" if when != "—" else ""),
            styles["body"]))
    return out


def _section(num: str, title: str, right: str, body_w) -> Table:
    left = Paragraph(
        f"<font color='{GREEN.hexval()}'>{num}</font>&nbsp;&nbsp;&nbsp;"
        f"<font color='{INK.hexval()}'>{title}</font>",
        ParagraphStyle("sec_l", fontName="Helvetica-Bold", fontSize=11, leading=14))
    rp = Paragraph(right, ParagraphStyle("sec_r", fontName="Helvetica", fontSize=8,
                                         leading=12, textColor=GREY_MID, alignment=2))
    t = Table([[left, rp]], colWidths=[body_w * 0.6, body_w * 0.4])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 18), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, BORDER),
    ]))
    return t


# ── Public entry point (unchanged signature + data schema) ───────────────────
def build_account_pdf(buffer: BinaryIO, *, data: dict) -> None:
    is_draft = data.get("is_draft", False)
    company = data["company"]
    pe = data["period_end"]
    if not isinstance(pe, date):
        pe = date.fromisoformat(str(pe))

    acct_no = data.get("account_number")
    acct_nm = data.get("account_name") or "Account"
    account_label = f"{acct_no} · {acct_nm}" if acct_no else acct_nm
    doc_ref = f"REC-{pe.strftime('%Y%m')}" + (f"-{acct_no}" if acct_no else "")
    body_w = LETTER[0] - 2 * (0.72 * inch)

    styles = _styles()
    doc = _make_doc(buffer, company=company, account_label=account_label,
                    doc_ref=doc_ref, period_end=pe, is_draft=is_draft)
    story: list[Any] = []

    _counter = [0]

    def num() -> str:
        _counter[0] += 1
        return f"{_counter[0]:02d}"

    # ── Top bar: company (left) · packet label + ref (right). No logo. ──
    topbar = Table([[
        Paragraph(company.upper(), ParagraphStyle("tb_l", fontName="Helvetica-Bold",
                  fontSize=8, leading=11, textColor=GREY_MID)),
        Paragraph(f"RECONCILIATION PACKET<br/><font color='{GREY_MID.hexval()}'>{doc_ref}</font>",
                  ParagraphStyle("tb_r", fontName="Helvetica-Bold", fontSize=8, leading=11,
                                 textColor=INK, alignment=2)),
    ]], colWidths=[body_w * 0.5, body_w * 0.5])
    topbar.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(topbar)
    story.append(_Hairline(BORDER, 0.75))
    story.append(Spacer(1, 0.22 * inch))

    # ── Eyebrow · title · subtitle · lede ──
    story.append(Paragraph("GENERAL LEDGER RECONCILIATION", styles["eyebrow"]))
    story.append(Paragraph(f"{acct_nm} · {acct_no}" if acct_no else acct_nm, styles["title"]))
    story.append(Paragraph(f"{_period_label(pe)} · period close", styles["subtitle"]))
    status_word = _STATUS.get(data.get("status", "pending"), ("Open", GREY_MID))[0]
    story.append(Paragraph(
        f"{company} · {_fmt_date_long(pe)}. Reconciled and reviewed in the close workflow · {status_word.lower()}.",
        styles["lede"]))
    story.append(Spacer(1, 0.16 * inch))

    story.append(_meta_cards(data, pe, body_w))

    # ── Balance summary + build-up ──
    story.append(_section(num(), "Balance summary", f"USD · ending {_fmt_date(pe)}", body_w))
    story.append(Spacer(1, 0.10 * inch))
    story.append(_balance_summary(data, pe, body_w))
    story.append(Spacer(1, 0.14 * inch))
    story.append(_buildup(data, body_w))

    # ── Open reconciling items (explicitly un-cleared / outstanding) ──
    item_tbl = _reconciling_items(data, body_w)
    if item_tbl:
        open_n = sum(1 for it in (data.get("reconciling_items") or []) if it.get("cleared") is False)
        story.append(_section(num(), "Reconciling items · open",
                              f"{open_n} item{'' if open_n == 1 else 's'}", body_w))
        story.append(Spacer(1, 0.08 * inch))
        story.extend(item_tbl)

    # ── AI reconciliation summary ──
    commentary = data.get("ai_commentary")
    if commentary and isinstance(commentary, dict) and (commentary.get("narrative") or commentary.get("checks")):
        story.append(_section(num(), "AI reconciliation summary", "generated by the agent", body_w))
        story.append(Spacer(1, 0.08 * inch))
        story.extend(_ai_summary(commentary, styles, body_w))

    # ── Notes (optional) ──
    notes = (data.get("notes") or "").strip()
    if notes:
        story.append(_section(num(), "Preparer notes", "", body_w))
        story.append(Spacer(1, 0.06 * inch))
        story.append(Paragraph(notes, styles["body"]))

    # ── Supporting documents ──
    nf = len(data.get("evidence_files") or [])
    story.append(_section(num(), "Supporting documents", f"{nf} attachment{'' if nf == 1 else 's'}", body_w))
    story.append(Spacer(1, 0.06 * inch))
    story.extend(_docs(data, styles))

    # ── Prepared / approved ──
    story.append(_section(num(), "Prepared & approved", "names + timestamps", body_w))
    story.append(Spacer(1, 0.10 * inch))
    story.append(_signoff(data, body_w))

    doc.build(story)
