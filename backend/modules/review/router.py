"""
AI Close Review API.

  GET  /api/review?period=YYYY-MM-DD     review + findings for a period
  POST /api/review/run?period=...        run/refresh the review (reviewer+)
  POST /api/review/finding/{id}/action   clear | action | accept | reopen
  POST /api/review/signoff?period=...     reviewer sign-off

Read is open to any member; mutations require reviewer+. Running is snapshot-
based (no live QuickBooks calls) plus one bounded AI call, so it runs inline.
"""
import logging
import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
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


def _serialize_finding(f: CloseReviewFinding) -> dict:
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
        "status":        f.status,
        "note":          f.note,
        "status_changed_at": f.status_changed_at.isoformat() if f.status_changed_at else None,
    }


def _serialize_review(r: CloseReview | None, findings: list[CloseReviewFinding], period_end: date) -> dict:
    open_findings = [f for f in findings if f.status == "open"]
    open_findings.sort(key=lambda f: (_SEVERITY_ORDER.get(f.severity, 9), f.category))
    resolved = [f for f in findings if f.status != "open"]
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
            "generated_at":  r.generated_at.isoformat() if r.generated_at else None,
            "signed_off_at": r.signed_off_at.isoformat() if r.signed_off_at else None,
        },
        "findings":  [_serialize_finding(f) for f in open_findings],
        "resolved":  [_serialize_finding(f) for f in resolved],
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
    return _serialize_review(review, findings, period_end)


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
    finding.status = new_status
    finding.status_changed_by = user.id
    finding.status_changed_at = datetime.now(UTC)
    if body.note is not None:
        finding.note = body.note[:500]
    review = (await db.execute(
        select(CloseReview).where(CloseReview.id == finding.review_id)
    )).scalar_one_or_none()
    if review is not None:
        await _recount(db, review)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"review.finding_{new_status}", entity_type="close_review_finding", entity_id=finding.id,
        metadata={"summary": f"{body.action} review finding '{finding.title}'"},
    )
    await db.commit()
    return await _load_state(db, finding.period_end)


@router.post("/signoff")
async def sign_off(
    tenant_id: CurrentTenantId,
    period: str = Query(...),
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
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="review.signed_off", entity_type="period", entity_id=None,
        metadata={"summary": f"Signed off the {period_end.strftime('%b %Y')} close review"},
    )
    await db.commit()
    return await _load_state(db, period_end)
