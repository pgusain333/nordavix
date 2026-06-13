"""
Close Binder assembler.

Produces ONE paginated, bookmarked, audit-ready PDF for a closed period:

    Cover  →  Close Certificate  →  Contents
           →  Financial statements
           →  Reconciliation working papers   (stage 2)
           →  Flux analysis                    (stage 2)
           →  Audit trail appendix

Each section is rendered by the module that already owns it (financials/pdf,
recons/pdf, flux/pdf) so the binder is the real, byte-stable working papers —
not a re-derivation. We then merge with pypdf, compute a true table of contents
(two-pass: render front matter once to learn its length, then again with real
page numbers), add clickable PDF bookmarks, and stamp a continuous binder page
number on every page.

Gated upstream to a CLOSED period, so every section reads from the committed
snapshot, never a fresh QBO pull — the signed binder reflects exactly what was
approved.
"""
from __future__ import annotations

import io
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.audit_log import AuditLog
from models.close_review import CloseReview
from models.closed_period import ClosedPeriod
from modules.recons.overview import read_overview_from_snapshots
from modules.workpapers.pdf_pages import (
    AuditRow,
    BinderContext,
    TocEntry,
    render_audit_appendix,
    render_front_matter,
)

logger = logging.getLogger(__name__)

_PAGE_W, _PAGE_H = LETTER
_MARGIN = 0.72 * inch
_AUDIT_WINDOW_DAYS = 90
_AUDIT_MAX_ROWS = 400


@dataclass
class _Section:
    key: str
    title: str
    note: str
    pdf: bytes
    pages: int


def _count(pdf: bytes) -> int:
    try:
        return len(PdfReader(io.BytesIO(pdf)).pages)
    except Exception:
        return 0


def _fmt_dt(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    try:
        return dt.strftime("%d %b %Y · %H:%M UTC")
    except Exception:
        return None


# ── Context (certificate data) ───────────────────────────────────────────────
async def _gather_context(
    db: AsyncSession, tenant_id: uuid.UUID, period_end: date, *,
    company: str, generated_by_name: str, closed: ClosedPeriod,
) -> BinderContext:
    from modules.recons.pdf import _period_label  # local: avoid import cycle

    ctx = BinderContext(
        company=company,
        period_end=period_end,
        period_label=_period_label(period_end),
        generated_at_label=datetime.now(UTC).strftime("%d %b %Y · %H:%M UTC"),
        generated_by_name=generated_by_name,
        closed_at_label=_fmt_dt(closed.closed_at),
    )

    # Resolve closer + reviewer display names (Clerk-backed, best-effort).
    review: CloseReview | None = None
    try:
        review = (await db.execute(
            select(CloseReview).where(CloseReview.period_end == period_end)
        )).scalars().first()
    except Exception:
        logger.debug("binder: close review lookup failed", exc_info=True)

    ids = [i for i in (closed.closed_by,
                       review.signed_off_by if review else None) if i]
    names: dict[str, str] = {}
    if ids:
        try:
            from modules.audit.router import _resolve_user_names
            names = await _resolve_user_names(db, ids)
        except Exception:
            logger.debug("binder: name resolution failed", exc_info=True)
    ctx.closed_by_name = names.get(str(closed.closed_by)) if closed.closed_by else None

    if review is not None:
        ctx.review_status = review.status
        ctx.review_summary = review.summary
        ctx.high_count = review.high_count or 0
        ctx.review_count = review.review_count or 0
        ctx.info_count = review.info_count or 0
        ctx.cleared_count = review.cleared_count or 0
        ctx.checks_run = review.checks_run or 0
        ctx.passed = list(review.passed or [])
        ctx.signed_off_at_label = _fmt_dt(review.signed_off_at)
        if review.signed_off_by:
            ctx.signed_off_by_name = names.get(str(review.signed_off_by))

    # Recon roll-up from committed snapshots (no QBO).
    try:
        ov = await read_overview_from_snapshots(db, period_end)
        accts = ov.get("accounts") or []
        ctx.recon_total = len(accts)
        ctx.recon_approved = sum(1 for a in accts if a.get("review_status") == "approved")
        ctx.recon_reconciled = sum(
            1 for a in accts if a.get("review_status") in ("reviewed", "approved")
        )
    except Exception:
        logger.debug("binder: recon overview failed", exc_info=True)

    # Flux roll-up — variances on trial balances whose current period is this close.
    try:
        from models.account import Account
        from models.trial_balance import TrialBalance
        from models.variance import Variance
        rows = list((await db.execute(
            select(Variance)
            .join(Account, Variance.account_id == Account.id)
            .join(TrialBalance, Account.trial_balance_id == TrialBalance.id)
            .where(TrialBalance.period_current == period_end)
        )).scalars().all())
        ctx.flux_total = len(rows)
        ctx.flux_material = sum(1 for v in rows if v.is_material)
        ctx.flux_approved = sum(1 for v in rows if v.status == "approved")
    except Exception:
        logger.debug("binder: flux roll-up failed", exc_info=True)

    return ctx


# ── Section producers ────────────────────────────────────────────────────────
async def _render_financials(
    db: AsyncSession, tenant_id: uuid.UUID, period_end: date, company: str,
) -> bytes | None:
    """Income statement + balance sheet + cash flow from the committed snapshot."""
    try:
        from modules.financials.pdf import build_pdf
        from modules.financials.router import _build_statement

        statements = []
        for kind in ("income_statement", "balance_sheet", "cash_flow"):
            statements.append(await _build_statement(
                tenant_id, db, period_end, kind, True, source="nordavix"))
        buf = io.BytesIO()
        build_pdf(buf, company=company, period_end=period_end,
                  statements=statements, prepared_by="", is_draft=False)
        return buf.getvalue()
    except Exception:
        logger.warning("binder: financials section failed; skipping", exc_info=True)
        return None


async def _render_audit(
    db: AsyncSession, tenant_id: uuid.UUID, ctx: BinderContext, period_end: date,
) -> tuple[bytes, int, str]:
    """Period-scoped audit trail (90-day window ending at period_end)."""
    from modules.recons.pdf import _fmt_date_long

    since = period_end - timedelta(days=_AUDIT_WINDOW_DAYS)
    since_dt = datetime.combine(since, time.min, tzinfo=UTC)
    until_dt = datetime.combine(period_end, time.max, tzinfo=UTC)
    rows: list[AuditRow] = []
    window_label = _fmt_date_long(since)
    try:
        logs = list((await db.execute(
            select(AuditLog)
            .where(AuditLog.created_at >= since_dt, AuditLog.created_at <= until_dt)
            .order_by(AuditLog.created_at.desc())
            .limit(_AUDIT_MAX_ROWS)
        )).scalars().all())

        ids = list({log.user_id for log in logs if log.user_id})
        names: dict[str, str] = {}
        if ids:
            try:
                from modules.audit.router import _resolve_user_names
                names = await _resolve_user_names(db, ids)
            except Exception:
                logger.debug("binder: audit name resolution failed", exc_info=True)

        for log in logs:
            ts = log.created_at.strftime("%d %b %Y %H:%M") if log.created_at else ""
            who = names.get(str(log.user_id), "System") if log.user_id else "System"
            summary = ""
            if isinstance(log.event_data, dict):
                summary = str(log.event_data.get("summary", "") or "")
            rows.append(AuditRow(ts=ts, user=who, action=log.action or "", summary=summary))
    except Exception:
        logger.warning("binder: audit section query failed", exc_info=True)

    buf = io.BytesIO()
    render_audit_appendix(buf, ctx=ctx, rows=rows, window_from_label=window_label)
    return buf.getvalue(), len(rows), window_label


# ── Assembly ─────────────────────────────────────────────────────────────────
def _render_front_matter(ctx: BinderContext, toc: list[TocEntry]) -> bytes:
    buf = io.BytesIO()
    render_front_matter(buf, ctx=ctx, toc_entries=toc)
    return buf.getvalue()


def _stamp_overlay(total: int, label: str) -> list:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    for i in range(total):
        if i != 0:  # never stamp the cover
            c.setFont("Helvetica", 7)
            c.setFillColorRGB(0.54, 0.56, 0.60)
            c.drawRightString(_PAGE_W - _MARGIN, _PAGE_H - 0.42 * inch,
                              f"{label}  ·  p. {i + 1} of {total}")
        c.showPage()
    c.save()
    buf.seek(0)
    return list(PdfReader(buf).pages)


def _assemble(ctx: BinderContext, sections: list[_Section]) -> bytes:
    # Pass 1 — render front matter with placeholder page numbers to learn how
    # many pages the cover+certificate+contents occupy (digit content doesn't
    # change the page count, so the measured length is final).
    cert_entry = TocEntry("Close certificate", 2,
                          "Sign-off, findings cleared, checks passed")
    provisional = [cert_entry] + [TocEntry(s.title, 0, s.note) for s in sections]
    front = _render_front_matter(ctx, provisional)
    front_pages = _count(front) or 3

    # Pass 2 — real page numbers: sections start right after the front matter.
    real = [cert_entry]
    starts: dict[str, int] = {}
    running = front_pages
    for s in sections:
        start = running + 1
        starts[s.key] = start
        real.append(TocEntry(s.title, start, s.note))
        running += s.pages
    front = _render_front_matter(ctx, real)

    writer = PdfWriter()
    for p in PdfReader(io.BytesIO(front)).pages:
        writer.add_page(p)
    for s in sections:
        for p in PdfReader(io.BytesIO(s.pdf)).pages:
            writer.add_page(p)

    total = len(writer.pages)
    label = f"{ctx.company} close binder"
    if len(label) > 64:
        label = label[:61] + "..."
    try:
        overlay = _stamp_overlay(total, label)
        for i, page in enumerate(writer.pages):
            if i < len(overlay):
                page.merge_page(overlay[i])
    except Exception:
        logger.debug("binder: page-stamp overlay failed", exc_info=True)

    # Clickable bookmarks
    try:
        writer.add_outline_item("Close certificate", 1)
        for s in sections:
            writer.add_outline_item(s.title, max(0, starts[s.key] - 1))
    except Exception:
        logger.debug("binder: outline failed", exc_info=True)

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


# ── Public entry point ───────────────────────────────────────────────────────
async def build_close_binder(
    *, db: AsyncSession, tenant_id: uuid.UUID, period_end: date,
    company: str, generated_by_name: str, closed: ClosedPeriod,
) -> bytes:
    ctx = await _gather_context(
        db, tenant_id, period_end, company=company,
        generated_by_name=generated_by_name, closed=closed)

    sections: list[_Section] = []

    fin = await _render_financials(db, tenant_id, period_end, company)
    if fin:
        sections.append(_Section(
            "financials", "Financial statements",
            "Income statement · Balance sheet · Cash flow", fin, _count(fin)))

    # Stage 2 will insert reconciliation + flux working-paper packets here.

    audit_pdf, audit_n, _ = await _render_audit(db, tenant_id, ctx, period_end)
    sections.append(_Section(
        "audit", "Audit trail", f"{audit_n} events", audit_pdf, _count(audit_pdf)))

    return _assemble(ctx, sections)
