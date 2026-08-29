"""
AI Close Review API.

  GET  /api/review?period=YYYY-MM-DD     review + findings for a period
  GET  /api/review/memo?period=...       the sign-off memo, as PDF
  POST /api/review/run?period=...        run/refresh the review (reviewer+)
  POST /api/review/finding/{id}/action   clear | action | accept | reopen
  POST /api/review/signoff?period=...     reviewer sign-off

Read is open to any member; mutations require reviewer+. Running is snapshot-
based (no live QuickBooks calls) plus one bounded AI call, so it runs inline.
"""
import io
import logging
import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_role
from core.db.session import get_db
from models.close_review import CloseReview, CloseReviewFinding
from models.user import User
from modules.review.engine import run_close_review

logger = logging.getLogger(__name__)

router = APIRouter()

_SEVERITY_ORDER = {"high": 0, "review": 1, "info": 2}
_ACTION_TO_STATUS = {"clear": "cleared", "action": "actioned", "accept": "accepted", "reopen": "open"}


async def _names_for(db: AsyncSession, ids: list[uuid.UUID]) -> dict[str, str]:
    """user id -> display name, for the people who decided things.

    A disposition without a name is an anonymous override. The id was always
    stored; it was simply never resolved, so the UI could show WHEN a finding
    was cleared but never BY WHOM — the half that makes a review defensible.

    Reuses the audit log's resolver (Clerk profile name, cached, email as
    fallback) rather than growing a second one that would drift: the memo and
    the audit trail must not disagree about who someone is.
    """
    wanted = list({i for i in ids if i})
    if not wanted:
        return {}
    try:
        from modules.audit.router import _resolve_user_names
        return await _resolve_user_names(db, wanted)
    except Exception:      # noqa: BLE001 — a name is never worth failing a read
        logger.debug("reviewer name resolution failed", exc_info=True)
        rows = (await db.execute(select(User.id, User.email).where(User.id.in_(wanted)))).all()
        return {str(uid): email for uid, email in rows}


def _serialize_finding(f: CloseReviewFinding, names: dict[str, str] | None = None) -> dict:
    names = names or {}
    return {
        "id":            str(f.id),
        "code":          f.code,
        "category":      f.category,
        "severity":      f.severity,
        "title":         f.title,
        "detail":        f.detail,
        "recommended_action": f.recommended_action,
        "qbo_account_id": f.qbo_account_id,
        "account_label": f.account_label,
        "entity_ref":    f.entity_ref,
        "link_hint":     f.link_hint,
        "meta":          f.meta,
        "status":        f.status,
        "note":          f.note,
        "status_changed_at": f.status_changed_at.isoformat() if f.status_changed_at else None,
        "status_changed_by_name": names.get(str(f.status_changed_by)) if f.status_changed_by else None,
        # When the exception was FIRST raised, across re-runs — drives "new"
        # badges and "open for 3 days".
        "first_seen_at": (f.first_seen_at or f.created_at).isoformat()
                         if (f.first_seen_at or f.created_at) else None,
    }


def _serialize_review(r: CloseReview | None, findings: list[CloseReviewFinding],
                      period_end: date, names: dict[str, str] | None = None) -> dict:
    names = names or {}
    open_findings = [f for f in findings if f.status == "open"]
    open_findings.sort(key=lambda f: (_SEVERITY_ORDER.get(f.severity, 9), f.category))
    resolved = [f for f in findings if f.status != "open"]
    resolved.sort(key=lambda f: (f.status_changed_at or f.created_at), reverse=True)
    return {
        "period_end":   period_end.isoformat(),
        "period_label": period_end.strftime("%b %Y"),
        "review": None if r is None else {
            "id":            str(r.id),
            "status":        r.status,
            "summary":       r.summary,
            "high_count":    r.high_count,
            "review_count":  r.review_count,
            "info_count":    r.info_count,
            "cleared_count": r.cleared_count,
            "checks_run":    r.checks_run,
            "passed":        r.passed or [],
            "new_count":      r.new_count,
            "resolved_count": r.resolved_count,
            "generated_at":  r.generated_at.isoformat() if r.generated_at else None,
            "signed_off_at": r.signed_off_at.isoformat() if r.signed_off_at else None,
            "signed_off_by_name": names.get(str(r.signed_off_by)) if r.signed_off_by else None,
            "signoff_note":  r.signoff_note,
        },
        "findings":  [_serialize_finding(f, names) for f in open_findings],
        "resolved":  [_serialize_finding(f, names) for f in resolved],
    }


async def _load_state(db: AsyncSession, period_end: date) -> dict:
    review = (await db.execute(
        select(CloseReview).where(CloseReview.period_end == period_end)
    )).scalar_one_or_none()
    findings: list[CloseReviewFinding] = []
    if review is not None:
        findings = list((await db.execute(
            select(CloseReviewFinding).where(CloseReviewFinding.review_id == review.id)
        )).scalars().all())
    ids = [f.status_changed_by for f in findings]
    if review is not None and review.signed_off_by:
        ids.append(review.signed_off_by)
    names = await _names_for(db, ids)
    return _serialize_review(review, findings, period_end, names)


def _parse_period(period: str) -> date:
    try:
        return date.fromisoformat(period)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="period must be YYYY-MM-DD") from exc


async def _recount(db: AsyncSession, review: CloseReview) -> None:
    findings = list((await db.execute(
        select(CloseReviewFinding).where(CloseReviewFinding.review_id == review.id)
    )).scalars().all())
    review.high_count   = sum(1 for f in findings if f.status == "open" and f.severity == "high")
    review.review_count = sum(1 for f in findings if f.status == "open" and f.severity == "review")
    review.info_count   = sum(1 for f in findings if f.status == "open" and f.severity == "info")
    review.cleared_count = sum(1 for f in findings if f.status != "open")


@router.get("/memo")
async def download_memo(
    tenant_id: CurrentTenantId,
    period: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """The sign-off memo as a PDF — the module's actual deliverable.

    Available before sign-off too, and says so on its face: a partner reviewing
    a close in progress needs the same document, and one that refused to render
    until everything was signed would just be re-typed into Word.
    """
    from models.tenant import Tenant
    from modules.review.memo import MemoContext, MemoFinding, render_review_memo

    period_end = _parse_period(period)
    review = (await db.execute(
        select(CloseReview).where(CloseReview.period_end == period_end)
    )).scalar_one_or_none()
    if review is None:
        raise HTTPException(status_code=409, detail="Run the review before downloading the memo.")
    findings = list((await db.execute(
        select(CloseReviewFinding).where(CloseReviewFinding.review_id == review.id)
    )).scalars().all())
    ids = [f.status_changed_by for f in findings]
    if review.signed_off_by:
        ids.append(review.signed_off_by)
    names = await _names_for(db, ids)

    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()

    def _mf(f: CloseReviewFinding) -> MemoFinding:
        return MemoFinding(
            severity=f.severity, category=f.category, title=f.title,
            detail=f.detail or "", status=f.status, account_label=f.account_label,
            note=f.note, decided_at=f.status_changed_at,
            decided_by=names.get(str(f.status_changed_by)) if f.status_changed_by else None,
            first_seen_at=f.first_seen_at or f.created_at,
        )

    open_f = sorted([f for f in findings if f.status == "open"],
                    key=lambda f: (_SEVERITY_ORDER.get(f.severity, 9), f.category))
    resolved_f = sorted([f for f in findings if f.status != "open"],
                        key=lambda f: (_SEVERITY_ORDER.get(f.severity, 9), f.category))

    pdf = render_review_memo(MemoContext(
        company=(tenant.name if tenant else "Workspace"),
        period_label=period_end.strftime("%B %Y"),
        period_end=period_end,
        generated_at=review.generated_at,
        checks_run=review.checks_run,
        summary=review.summary,
        passed=list(review.passed or []),
        open_findings=[_mf(f) for f in open_f],
        resolved_findings=[_mf(f) for f in resolved_f],
        signed_off_by=names.get(str(review.signed_off_by)) if review.signed_off_by else None,
        signed_off_at=review.signed_off_at,
        signoff_note=review.signoff_note,
        new_count=review.new_count,
        resolved_count=review.resolved_count,
    ))
    fname = f"Close-review-memo-{period_end.strftime('%Y-%m')}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf), media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("")
async def get_review(
    tenant_id: CurrentTenantId,
    period: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await _load_state(db, _parse_period(period))


@router.post("/run")
async def run_review(
    tenant_id: CurrentTenantId,
    period: str = Query(...),
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    period_end = _parse_period(period)
    review = await run_close_review(db, tenant_id, period_end, generated_by=user.id)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="review.run", entity_type="period", entity_id=None,
        metadata={"summary": (
            f"Close review run for {period_end.strftime('%b %Y')}: "
            f"{review.high_count} high, {review.review_count} review, {review.info_count} info"
        )},
    )
    await db.commit()
    return await _load_state(db, period_end)


class ActionBody(BaseModel):
    action: str
    note: str | None = None


# Dismissing a HIGH-severity exception is the one action in this module that
# a partner may later have to defend. Requiring a sentence is the whole point
# of a review that claims to be defensible — and the `note` column has existed
# since the table was built, accepted by this endpoint and rendered by the page,
# with nothing on any path ever writing one.
_REASON_REQUIRED_FOR = {"clear", "accept"}
_MIN_REASON = 4


def reason_missing(severity: str, action: str, note: str | None) -> bool:
    """Is this disposition missing the reason it is required to carry?

    A pure rule, extracted so a test can exercise THIS function rather than
    restate the thresholds — a test that reimplements the check keeps passing
    after the check is broken.

    Asymmetric on purpose: mandatory on high, optional below. Demanding a
    sentence for every info-level note trains people to type "ok", which is how
    a control becomes a formality. Reopening never needs one — it retracts a
    decision rather than making one, and taxing the safe direction is backwards.
    """
    if severity != "high" or action not in _REASON_REQUIRED_FOR:
        return False
    return len((note or "").strip()) < _MIN_REASON


@router.post("/finding/{finding_id}/action")
async def act_on_finding(
    finding_id: uuid.UUID,
    body: ActionBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    new_status = _ACTION_TO_STATUS.get(body.action)
    if new_status is None:
        raise HTTPException(status_code=422, detail="action must be clear, action, accept, or reopen")
    finding = (await db.execute(
        select(CloseReviewFinding).where(CloseReviewFinding.id == finding_id)
    )).scalar_one_or_none()
    if finding is None:
        raise HTTPException(status_code=404, detail="Finding not found.")
    note = (body.note or "").strip()
    if reason_missing(finding.severity, body.action, note):
        raise HTTPException(
            status_code=422,
            detail=("Add a reason before setting aside a high-severity exception — "
                    "it goes on the sign-off memo."),
        )
    finding.status = new_status
    finding.status_changed_by = user.id
    finding.status_changed_at = datetime.now(UTC)
    if body.action == "reopen":
        # Reopening retracts the decision; the reason it carried described a
        # disposition that no longer stands, and leaving it attached would put
        # a justification for clearing next to an open exception.
        finding.note = None
    elif note:
        finding.note = note[:500]
    review = (await db.execute(
        select(CloseReview).where(CloseReview.id == finding.review_id)
    )).scalar_one_or_none()
    if review is not None:
        await _recount(db, review)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"review.finding_{new_status}", entity_type="close_review_finding", entity_id=finding.id,
        metadata={"summary": f"{body.action} review finding '{finding.title}'"
                             + (f" — {note}" if note else ""),
                  "severity": finding.severity, "reason": note or None},
    )
    await db.commit()
    return await _load_state(db, finding.period_end)


class SignOffBody(BaseModel):
    """The reviewing partner's statement, printed under the signature."""
    note: str | None = None


@router.post("/signoff")
async def sign_off(
    tenant_id: CurrentTenantId,
    period: str = Query(...),
    body: SignOffBody | None = None,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    period_end = _parse_period(period)
    review = (await db.execute(
        select(CloseReview).where(CloseReview.period_end == period_end)
    )).scalar_one_or_none()
    if review is None:
        raise HTTPException(status_code=409, detail="Run the review before signing off.")
    if review.high_count > 0:
        raise HTTPException(
            status_code=409,
            detail="Clear or accept the high-priority items before signing off.",
        )
    review.status = "signed_off"
    review.signed_off_by = user.id
    review.signed_off_at = datetime.now(UTC)
    review.signoff_note = ((body.note or "").strip()[:2000] or None) if body else None
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="review.signed_off", entity_type="period", entity_id=None,
        metadata={"summary": f"Signed off the {period_end.strftime('%b %Y')} close review"},
    )
    await db.commit()
    return await _load_state(db, period_end)
