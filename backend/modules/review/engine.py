"""
Close Review engine — runs the check battery + AI narrative for one
(workspace, period), then persists the review and its findings.

Snapshot-first: every check reads persisted Nordavix data (recon overview, GL
snapshots, flux, schedules, adjustments) — NO live QuickBooks calls — so a
review is fast and safe to run repeatedly. Re-running refreshes the open
findings but keeps the reviewer's cleared / actioned / accepted decisions.
"""
import asyncio
import hashlib
import logging
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account import Account
from models.account_review_status import AccountReviewStatus
from models.close_review import CloseReview, CloseReviewFinding
from models.gl_balance_snapshot import GlBalanceSnapshot
from models.narrative import Narrative
from models.period_sync import PeriodSync
from models.proposed_entry import ProposedEntry
from models.schedule import ScheduleLease, ScheduleLoan
from models.trial_balance import TrialBalance
from models.variance import Variance
from modules.review.checks import ReviewContext, run_all_checks

logger = logging.getLogger(__name__)

_TIE = Decimal("1.00")
_MAX_PRIOR_PERIODS = 3   # for dropped-recurring / new-account comparisons


def _dec(v) -> Decimal:
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal("0")


def _stable_key(code: str, qbo_account_id, entity_ref, category) -> tuple:
    # Anomaly findings are per-journal-entry, and the QBO JE id (entity_ref) is
    # STABLE across review re-runs — so include it, letting each JE be cleared
    # independently. Everything else keys on (code, account) only: a flux
    # variance id is regenerated each flux run, so keying on it would resurrect
    # a reviewer-cleared finding. Every non-anomaly check emits at most one
    # finding per (code, account), so that's a sufficient, stable identity.
    if category == "anomaly":
        return (code, qbo_account_id or "", entity_ref or "")
    return (code, qbo_account_id or "")


async def _load_schedule_gaps(db: AsyncSession, tenant_id: uuid.UUID, period_end: date,
                              cur: dict) -> list[dict]:
    """Active loan/lease schedules whose implied period interest doesn't appear
    to have hit the GL (schedule subledger vs GL balance gap)."""
    from modules.recons.agentic import _schedule_backed_subledger
    from modules.schedules.calc import lease_interest_in_period, loan_interest_in_period

    p_start = period_end.replace(day=1)
    gaps: list[dict] = []

    loans = list((await db.execute(
        select(ScheduleLoan).where(ScheduleLoan.is_active == True)  # noqa: E712
    )).scalars().all())
    leases = list((await db.execute(
        select(ScheduleLease).where(ScheduleLease.is_active == True)  # noqa: E712
    )).scalars().all())

    plan: list[tuple] = (
        [("loan", it, loan_interest_in_period) for it in loans]
        + [("lease", it, lease_interest_in_period) for it in leases]
    )
    for kind, item, implied_fn in plan:
        try:
            implied = _dec(implied_fn(item, p_start, period_end))
            if implied <= 0:
                continue
            sb = await _schedule_backed_subledger(db, tenant_id, item.qbo_account_id, period_end)
            if not sb:
                continue
            sl_signed = _dec(sb.get("sl_signed"))
            snap = cur.get(item.qbo_account_id)
            if snap is None:
                continue
            gl_bal = _dec(getattr(snap, "balance", 0))
            gap = gl_bal - sl_signed
            if abs(gap) > _TIE:
                label = (
                    f"{getattr(snap, 'account_number', '') or ''} {getattr(snap, 'account_name', '') or ''}".strip()
                    or getattr(item, "description", None) or "(schedule account)"
                )
                gaps.append({
                    "schedule_type": kind, "qbo_account_id": item.qbo_account_id,
                    "account_label": label, "schedule_id": str(getattr(item, "id", "")),
                    "implied": str(implied), "gap": str(gap),
                    "gl": str(gl_bal), "sl": str(sl_signed),
                })
        except Exception:
            logger.exception("Close Review schedule gap check failed for %s", getattr(item, "id", "?"))
    return gaps


_JE_LARGE = Decimal("50000")
_JE_VERY_LARGE = Decimal("250000")
_JE_ROUND_STEP = Decimal("1000")


def _parse_qbo_dt(s) -> datetime | None:
    try:
        return datetime.fromisoformat(str(s))
    except Exception:
        return None


def _classify_je(je: dict, period_end: date) -> dict | None:
    """Flag a single QBO JournalEntry if it looks unusual. Returns the anomaly
    dict, or None when nothing trips. QBO has no 'manual JE' flag — the
    JournalEntry entity itself is the manual-entry proxy."""
    debit = Decimal("0")
    credit = Decimal("0")
    lines: list[dict] = []
    for line in je.get("Line", []) or []:
        d = line.get("JournalEntryLineDetail") or {}
        line_amt = _dec(line.get("Amount"))
        posting = d.get("PostingType")
        if posting == "Debit":
            debit += line_amt
        elif posting == "Credit":
            credit += line_amt
        # Capture the account each line hits (QBO gives name + id on AccountRef)
        # so the finding can show the entry's Dr/Cr breakdown. Cap the count so a
        # pathological split entry can't bloat the stored meta.
        if posting in ("Debit", "Credit") and len(lines) < 20:
            acct = d.get("AccountRef") or {}
            lines.append({
                "account": str(acct.get("name") or acct.get("value") or "(unspecified account)")[:120],
                "debit":  str(line_amt) if posting == "Debit" else None,
                "credit": str(line_amt) if posting == "Credit" else None,
            })
    # Balanced JE: debits == credits. Take the larger so a credit-only or
    # PostingType-less line set still yields the right entry magnitude.
    amt = max(debit, credit)
    try:
        txn_date: date | None = date.fromisoformat(str(je.get("TxnDate"))[:10])
    except Exception:
        txn_date = None
    meta = je.get("MetaData") or {}
    create_dt = _parse_qbo_dt(meta.get("CreateTime"))
    ref = meta.get("LastModifiedByRef") or {}
    poster = ref.get("name") or ref.get("value")

    flags: list[str] = []
    severity = "review"
    if amt and abs(amt) >= _JE_VERY_LARGE:
        flags.append("very large amount"); severity = "high"
    elif amt and abs(amt) >= _JE_LARGE:
        flags.append("large amount")
    if amt and abs(amt) >= _JE_ROUND_STEP and abs(amt) % _JE_ROUND_STEP == 0:
        flags.append("round-dollar amount")
    if txn_date and txn_date.weekday() >= 5:
        flags.append("weekend transaction date")
    if create_dt and txn_date and create_dt.date() > txn_date:
        if (create_dt.year, create_dt.month) > (txn_date.year, txn_date.month):
            flags.append("backdated into a prior month"); severity = "high"
        else:
            flags.append("entered after its transaction date")
    if not flags:
        return None
    return {
        "je_id":    str(je.get("Id") or ""),
        "doc":      str(je.get("DocNumber") or je.get("Id") or ""),
        "txn_date": txn_date.isoformat() if txn_date else None,
        "amount":   str(amt),
        "poster":   poster,
        "memo":     je.get("PrivateNote"),
        "flags":    flags,
        "severity": severity,
        "lines":    lines,
    }


async def _load_je_anomalies(db: AsyncSession, tenant_id: uuid.UUID, period_end: date) -> tuple[list, bool]:
    """Live QBO scan of journal entries dated in the period for manual-JE
    anomalies. Returns (anomalies, scanned). Best-effort: any QBO failure or a
    disconnected workspace yields ([], False) so the snapshot-based review still
    runs — this is the one live call in an otherwise snapshot-only engine."""
    from models.qbo_connection import QboConnection
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        return [], False

    from modules.recons.service import _qbo_get
    p_start = period_end.replace(day=1)
    out: list[dict] = []
    start_pos, page, seen = 1, 1000, 0
    try:
        while seen < 5000:                       # safety ceiling on a runaway period
            q = (
                f"SELECT * FROM JournalEntry "
                f"WHERE TxnDate >= '{p_start.isoformat()}' AND TxnDate <= '{period_end.isoformat()}' "
                f"MAXRESULTS {page} STARTPOSITION {start_pos}"
            )
            data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
            jes = (data.get("QueryResponse", {}) or {}).get("JournalEntry", []) or []
            if not jes:
                break
            for je in jes:
                a = _classify_je(je, period_end)
                if a:
                    out.append(a)
            seen += len(jes)
            if len(jes) < page:
                break
            start_pos += page
        return out, True
    except Exception:
        logger.exception("Close Review JE anomaly scan failed for tenant %s", tenant_id)
        return [], False


async def _build_context(db: AsyncSession, tenant_id: uuid.UUID, period_end: date) -> ReviewContext:
    from modules.recons.overview import read_overview_from_snapshots

    overview = await read_overview_from_snapshots(db, period_end)

    # AccountReviewStatus (approval trail not exposed on the overview dict).
    ars = list((await db.execute(
        select(AccountReviewStatus).where(AccountReviewStatus.period_end == period_end)
    )).scalars().all())
    review_status = {
        r.qbo_account_id: {
            "approved_at": r.approved_at,
            "subledger_entered_at": r.subledger_entered_at,
            "status": r.status,
        }
        for r in ars
    }

    ps = (await db.execute(
        select(PeriodSync).where(PeriodSync.period_end == period_end)
    )).scalar_one_or_none()
    tb_balanced = ps.tb_balanced if ps else None
    tb_diff = _dec(ps.tb_diff) if (ps and ps.tb_diff is not None) else None

    # Snapshots: current + the most-recent prior periods (one round trip).
    all_periods = list((await db.execute(
        select(GlBalanceSnapshot.period_end).distinct().order_by(GlBalanceSnapshot.period_end.desc())
    )).scalars().all())
    priors = [p for p in all_periods if p < period_end][:_MAX_PRIOR_PERIODS]
    to_load = [period_end, *priors]
    snap_rows = list((await db.execute(
        select(GlBalanceSnapshot).where(GlBalanceSnapshot.period_end.in_(to_load))
    )).scalars().all())
    by_period: dict[date, dict] = defaultdict(dict)
    for r in snap_rows:
        by_period[r.period_end][r.qbo_account_id] = r
    cur = dict(by_period.get(period_end, {}))
    prior_month = dict(by_period.get(priors[0], {})) if priors else {}
    prior_id_sets = [set(by_period.get(p, {}).keys()) for p in priors]

    # Flux: latest trial balance for the period + material/explanation state.
    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.period_current == period_end)
        .order_by(TrialBalance.created_at.desc())
    )).scalars().first()
    flux: list = []
    if tb is not None:
        rows = (await db.execute(
            select(Variance, Account, Narrative)
            .join(Account, Variance.account_id == Account.id)
            .outerjoin(Narrative, Narrative.variance_id == Variance.id)
            .where(Account.trial_balance_id == tb.id)
        )).all()
        for var, acct, narr in rows:
            has_expl = (narr is not None) or (var.ai_commentary is not None)
            flux.append((var, acct, has_expl))

    open_adj = (await db.execute(
        select(ProposedEntry).where(
            ProposedEntry.period_end == period_end, ProposedEntry.status == "open",
        )
    )).scalars().all()

    schedule_gaps = await _load_schedule_gaps(db, tenant_id, period_end, cur)
    je_anomalies, je_scanned = await _load_je_anomalies(db, tenant_id, period_end)

    return ReviewContext(
        period_end=period_end, overview=overview, review_status=review_status,
        tb_balanced=tb_balanced, tb_diff=tb_diff, cur=cur, prior_month=prior_month,
        prior_id_sets=prior_id_sets, flux=flux, schedule_gaps=schedule_gaps,
        open_adjustments=len(open_adj), je_anomalies=je_anomalies, je_scanned=je_scanned,
    )


def _deterministic_summary(findings: list[dict], passed: list[str], period_label: str) -> str:
    highs = [f for f in findings if f["severity"] == "high"]
    reviews = [f for f in findings if f["severity"] == "review"]
    if not findings:
        return f"The {period_label} close looks clean — no exceptions surfaced across the review checks."
    bits = []
    if highs:
        bits.append(f"{len(highs)} high-priority item{'s' if len(highs) != 1 else ''} need attention before sign-off")
    if reviews:
        bits.append(f"{len(reviews)} item{'s' if len(reviews) != 1 else ''} to review")
    lead = "; ".join(bits) if bits else "a few informational notes"
    top = highs[0] if highs else (reviews[0] if reviews else findings[0])
    return f"Close review found {lead}. Most notable: {top['title']}."


async def _ai_summary(findings: list[dict], passed: list[str], period_label: str,
                      tenant_id: uuid.UUID) -> str | None:
    from core.ai.client import generate_narrative
    from core.ai.guard import enforce_ai_limits
    try:
        await enforce_ai_limits(tenant_id)
    except Exception:
        return None
    ranked = sorted(findings, key=lambda f: {"high": 0, "review": 1, "info": 2}[f["severity"]])
    lines = [f"- [{f['severity']}] {f['title']}: {f['detail']}" for f in ranked[:12]]
    findings_block = "\n".join(lines) if lines else "(no exceptions found)"
    passed_block = ", ".join(passed) if passed else "(none recorded)"
    system = (
        "You are a senior reviewing partner at a CPA firm performing the final "
        "analytical review of a client's monthly close. Write 2-3 concise, "
        "professional sentences: state whether the books look broadly reasonable, "
        "then name the one or two items that most deserve attention before sign-off. "
        "Only reference what you are given — never invent issues. No preamble."
    )
    user = (
        f"Period: {period_label}\n"
        f"Checks that passed: {passed_block}\n"
        f"Exceptions found:\n{findings_block}\n\n"
        "Write the partner's review summary."
    )
    key = hashlib.sha256(f"close_review|{period_label}|{findings_block}".encode()).hexdigest()
    try:
        resp = await asyncio.to_thread(
            generate_narrative, system, user, key, 220, 3, "close_review",
        )
        text = (resp.content or "").strip()
        return text or None
    except Exception:
        logger.exception("Close Review AI summary failed")
        return None


async def run_close_review(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    period_end: date,
    *,
    generated_by: uuid.UUID | None,
    use_ai: bool = True,
) -> CloseReview:
    """Run the review for (tenant, period) and persist it. Tenant scope must
    already be set on the current_tenant_id ContextVar by the caller (request
    middleware or the Autopilot engine)."""
    period_label = period_end.strftime("%B %Y")
    ctx = await _build_context(db, tenant_id, period_end)
    findings, passed, checks_run = run_all_checks(ctx)

    summary = _deterministic_summary(findings, passed, period_label)
    if use_ai:
        ai = await _ai_summary(findings, passed, period_label, tenant_id)
        if ai:
            summary = ai

    # Upsert the review row (one per tenant+period).
    review = (await db.execute(
        select(CloseReview).where(CloseReview.period_end == period_end)
    )).scalar_one_or_none()
    if review is None:
        review = CloseReview(id=uuid.uuid4(), tenant_id=tenant_id, period_end=period_end)
        db.add(review)
        await db.flush()

    # Keep human-decided findings; replace only the open (auto) ones.
    existing = list((await db.execute(
        select(CloseReviewFinding).where(CloseReviewFinding.review_id == review.id)
    )).scalars().all())
    kept = [f for f in existing if f.status != "open"]
    kept_keys = {_stable_key(f.code, f.qbo_account_id, f.entity_ref, f.category) for f in kept}
    await db.execute(
        delete(CloseReviewFinding).where(
            CloseReviewFinding.review_id == review.id,
            CloseReviewFinding.tenant_id == tenant_id,
            CloseReviewFinding.status == "open",
        )
    )

    high = review_n = info = 0
    for f in findings:
        key = _stable_key(f["code"], f["qbo_account_id"], f["entity_ref"], f["category"])
        if key in kept_keys:
            continue  # the reviewer already decided on this exact issue
        db.add(CloseReviewFinding(
            id=uuid.uuid4(), tenant_id=tenant_id, review_id=review.id, period_end=period_end,
            code=f["code"], category=f["category"], severity=f["severity"],
            title=f["title"][:300], detail=(f["detail"] or "")[:1000],
            recommended_action=(f["recommended_action"] or None),
            qbo_account_id=f["qbo_account_id"], account_label=f["account_label"],
            entity_ref=f["entity_ref"], link_hint=f["link_hint"],
            meta=f.get("meta"), status="open",
        ))
        if f["severity"] == "high":
            high += 1
        elif f["severity"] == "review":
            review_n += 1
        else:
            info += 1

    review.high_count = high
    review.review_count = review_n
    review.info_count = info
    review.cleared_count = len(kept)   # actual resolved rows (matches router _recount)
    review.checks_run = checks_run
    review.passed = passed
    review.summary = summary
    review.generated_by = generated_by
    review.generated_at = datetime.now(UTC)
    review.status = "open"            # a fresh run needs fresh sign-off
    review.signed_off_by = None
    review.signed_off_at = None

    await db.commit()
    await db.refresh(review)
    return review
