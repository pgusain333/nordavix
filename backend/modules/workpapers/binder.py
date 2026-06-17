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
from decimal import Decimal

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
    EvidenceRow,
    LeadGroup,
    LeadRow,
    TocEntry,
    render_audit_appendix,
    render_evidence_appendix,
    render_front_matter,
    render_recon_lead_schedule,
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


def _merge(pdfs: list[bytes]) -> bytes:
    """Concatenate several per-item PDFs into one section."""
    writer = PdfWriter()
    for pdf in pdfs:
        for page in PdfReader(io.BytesIO(pdf)).pages:
            writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


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
                tenant_id, db, period_end, kind, True, source="nordavix",
                comparative_basis="prior_month"))
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


# Friendly "supports" label for non-account evidence references.
_EVIDENCE_SECTION_LABELS = {
    "schedule": "Schedules",
    "adjustment": "Adjustments",
    "flux": "Flux analysis",
    "financials": "Financial statements",
    "general": "Supporting documents",
}


async def _render_evidence(
    db: AsyncSession, tenant_id: uuid.UUID, ctx: BinderContext, period_end: date,
) -> tuple[bytes | None, int]:
    """Indexed appendix of every document attached to this period's working
    papers — each cross-referenced (E-n) to the workpaper it backs. The source
    files stay in Nordavix; the appendix is the manifest of record in the binder.

    Returns (None, 0) when nothing is attached, so the section is simply omitted.
    """
    from models.workpaper_evidence import WorkpaperEvidence

    try:
        items = list((await db.execute(
            select(WorkpaperEvidence)
            .where(WorkpaperEvidence.period_end == period_end)
            .order_by(
                WorkpaperEvidence.ref_type,
                WorkpaperEvidence.ref_id,
                WorkpaperEvidence.uploaded_at,
            )
        )).scalars().all())
    except Exception:
        logger.warning("binder: evidence query failed; skipping", exc_info=True)
        return None, 0

    if not items:
        return None, 0

    # Resolve account references to human account names (committed snapshot).
    acct_names: dict[str, str] = {}
    try:
        ov = await read_overview_from_snapshots(db, period_end)
        for a in (ov.get("accounts") or []):
            qid = a.get("qbo_id") or a.get("qbo_account_id")
            if qid:
                acct_names[str(qid)] = a.get("account_name") or str(qid)
    except Exception:
        logger.debug("binder: evidence account map failed", exc_info=True)

    # Resolve uploader display names (Clerk-backed, best-effort).
    ids = list({e.uploaded_by for e in items if e.uploaded_by})
    names: dict[str, str] = {}
    if ids:
        try:
            from modules.audit.router import _resolve_user_names
            names = await _resolve_user_names(db, ids)
        except Exception:
            logger.debug("binder: evidence name resolution failed", exc_info=True)

    rows: list[EvidenceRow] = []
    for i, e in enumerate(items, start=1):
        if e.ref_type == "account":
            if e.ref_id:
                supports = acct_names.get(str(e.ref_id), f"Account {e.ref_id}")
            else:
                supports = "Account (unspecified)"
        else:
            supports = _EVIDENCE_SECTION_LABELS.get(
                e.ref_type, (e.ref_type or "").replace("_", " ").title() or "—")
        who = names.get(str(e.uploaded_by), "—") if e.uploaded_by else "—"
        when = _fmt_dt(e.uploaded_at) or ""
        rows.append(EvidenceRow(
            no=f"E-{i}", document=e.file_name or "(unnamed)",
            supports=supports, who=who, when=when))

    buf = io.BytesIO()
    render_evidence_appendix(buf, ctx=ctx, rows=rows)
    return buf.getvalue(), len(rows)


def _build_recon_lead_schedule(
    ov: dict, accts: list[dict], ctx: BinderContext,
) -> bytes | None:
    """Render the recon lead schedule (summary table) from the committed
    overview — every account's GL vs subledger, variance and status, grouped by
    balance-sheet category (Assets / Liabilities / Equity) with subtotals and a
    grand total. Returns None when there are no accounts. Pure CPU + the
    overview dict the caller already fetched (no extra DB/QBO)."""
    if not accts:
        return None
    from modules.recons.overview import RECON_TOLERANCE, _classify
    from modules.recons.pdf import _fmt_money

    def _dec(v) -> Decimal:
        try:
            return Decimal(str(v if v not in (None, "") else "0"))
        except Exception:
            return Decimal("0")

    def _status(a: dict, var: Decimal) -> tuple[str, bool]:
        bad = abs(var) > RECON_TOLERANCE
        rs = a.get("review_status") or "pending"
        if rs == "flagged":
            return "Flagged", bad
        if bad:
            return "Variance", True
        if rs in ("approved", "reviewed"):
            return "Reconciled", False
        return "Open", False

    buckets: dict[str, list[dict]] = {"asset": [], "liability": [], "equity": [], "other": []}
    for a in accts:
        buckets[_classify(a.get("group_label") or "") or "other"].append(a)

    groups: list[LeadGroup] = []
    reconciled = 0
    for key, label in (("asset", "Assets"), ("liability", "Liabilities"),
                       ("equity", "Equity"), ("other", "Other")):
        items = sorted(buckets[key], key=lambda a: (a.get("account_number") or "",
                                                    a.get("account_name") or ""))
        if not items:
            continue
        rows: list[LeadRow] = []
        g_gl = g_sub = g_var = Decimal("0")
        for a in items:
            gl, sub = _dec(a.get("gl_balance")), _dec(a.get("subledger_balance"))
            var = _dec(a.get("variance"))
            st, bad = _status(a, var)
            if st == "Reconciled":
                reconciled += 1
            g_gl += gl
            g_sub += sub
            g_var += var
            rows.append(LeadRow(
                number=a.get("account_number") or "",
                name=a.get("account_name") or "",
                gl=_fmt_money(gl), sub=_fmt_money(sub), variance=_fmt_money(var),
                status=st, variance_bad=bad,
            ))
        groups.append(LeadGroup(
            label=label, rows=rows,
            gl=_fmt_money(g_gl), sub=_fmt_money(g_sub), variance=_fmt_money(g_var)))

    totals = ov.get("totals") or {}
    buf = io.BytesIO()
    render_recon_lead_schedule(
        buf, ctx=ctx, groups=groups,
        total_gl=_fmt_money(totals.get("gl") or "0"),
        total_sub=_fmt_money(totals.get("subledger") or "0"),
        total_variance=_fmt_money(totals.get("variance") or "0"),
        reconciled_count=reconciled, total_count=len(accts),
        tolerance_label=f"{RECON_TOLERANCE:.2f}",
    )
    return buf.getvalue()


async def _render_recon_packets(
    db: AsyncSession, tenant_id: uuid.UUID, period_end: date, company: str,
    user_email: str, ctx: BinderContext,
) -> tuple[bytes | None, int]:
    """The recon section: a lead schedule (summary of every account's GL vs
    subledger, variance + status) followed by one full working paper per
    balance-sheet account, in the per-account download style."""
    try:
        from modules.recons.pdf import build_account_pdf
        from modules.recons.pdf_data import gather_account_pdf_data

        ov = await read_overview_from_snapshots(db, period_end)
        accts = sorted(
            ov.get("accounts") or [],
            key=lambda a: (a.get("account_number") or "", a.get("account_name") or ""),
        )

        # Lead schedule first — the at-a-glance tie-out for the whole period.
        try:
            lead_pdf = _build_recon_lead_schedule(ov, accts, ctx)
        except Exception:
            logger.warning("binder: recon lead schedule failed; skipping", exc_info=True)
            lead_pdf = None

        # Then the full working paper for each account.
        pdfs: list[bytes] = []
        for a in accts:
            qid = a.get("qbo_id") or a.get("qbo_account_id")
            if not qid:
                continue
            try:
                data = await gather_account_pdf_data(
                    db, tenant_id=tenant_id, qbo_account_id=str(qid),
                    period_end=period_end, company=company, user_email=user_email)
                if not data:
                    continue
                buf = io.BytesIO()
                build_account_pdf(buf, data=data)
                pdfs.append(buf.getvalue())
            except Exception:
                logger.debug("binder: recon packet failed for %s", qid, exc_info=True)

        parts = ([lead_pdf] if lead_pdf else []) + pdfs
        if not parts:
            return None, 0
        return _merge(parts), len(pdfs)
    except Exception:
        logger.warning("binder: recon packets section failed; skipping", exc_info=True)
        return None, 0


async def _render_flux_packets(
    db: AsyncSession, tenant_id: uuid.UUID, period_end: date, company: str,
    user_email: str,
) -> tuple[bytes | None, int]:
    """One flux working paper per MATERIAL variance whose trial balance closes
    on this period — 'every material variance, explained'."""
    try:
        from models.account import Account
        from models.trial_balance import TrialBalance
        from models.variance import Variance
        from modules.flux.pdf import build_variance_pdf
        from modules.flux.pdf_data import gather_variance_pdf_data

        rows = list((await db.execute(
            select(Variance, Account, TrialBalance)
            .join(Account, Variance.account_id == Account.id)
            .join(TrialBalance, Account.trial_balance_id == TrialBalance.id)
            .where(
                TrialBalance.period_current == period_end,
                Variance.is_material.is_(True),
            )
            .order_by(Account.account_number, Account.account_name)
        )).all())

        pdfs: list[bytes] = []
        for var, acct, tb in rows:
            try:
                data = await gather_variance_pdf_data(
                    db, tb=tb, acct=acct, var=var, company=company, user_email=user_email)
                buf = io.BytesIO()
                build_variance_pdf(buf, data=data)
                pdfs.append(buf.getvalue())
            except Exception:
                logger.debug("binder: flux packet failed for %s", var.id, exc_info=True)
        if not pdfs:
            return None, 0
        return _merge(pdfs), len(pdfs)
    except Exception:
        logger.warning("binder: flux packets section failed; skipping", exc_info=True)
        return None, 0


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

    recon_pdf, recon_n = await _render_recon_packets(
        db, tenant_id, period_end, company, generated_by_name, ctx)
    if recon_pdf:
        recon_note = "Lead schedule" + (
            f" + {recon_n} account{'' if recon_n == 1 else 's'}" if recon_n else "")
        sections.append(_Section(
            "recons", "Reconciliation working papers",
            recon_note, recon_pdf, _count(recon_pdf)))

    flux_pdf, flux_n = await _render_flux_packets(
        db, tenant_id, period_end, company, generated_by_name)
    if flux_pdf:
        sections.append(_Section(
            "flux", "Flux analysis",
            f"{flux_n} material variance{'' if flux_n == 1 else 's'}", flux_pdf, _count(flux_pdf)))

    ev_pdf, ev_n = await _render_evidence(db, tenant_id, ctx, period_end)
    if ev_pdf:
        sections.append(_Section(
            "evidence", "Evidence appendix",
            f"{ev_n} document{'' if ev_n == 1 else 's'}", ev_pdf, _count(ev_pdf)))

    audit_pdf, audit_n, _ = await _render_audit(db, tenant_id, ctx, period_end)
    sections.append(_Section(
        "audit", "Audit trail", f"{audit_n} events", audit_pdf, _count(audit_pdf)))

    return _assemble(ctx, sections)
