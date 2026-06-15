"""
GL Accuracy API — the watchdog that flags likely-miscoded GL entries.

  POST /api/gl-accuracy/scan?period_end=…        run the check (any member)
  GET  /api/gl-accuracy/findings?period_end=…    list findings + summary
  POST /api/gl-accuracy/findings/{id}/accept     file the reclass into Adjustments
  POST /api/gl-accuracy/findings/{id}/dismiss    mark correct (reviewer+) → learned

Deterministic + evidence-grounded; confirm-first; never writes to QuickBooks.
"""
import logging
import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.db.session import get_db
from models.gl_accuracy_finding import GlAccuracyFinding
from models.qbo_connection import QboConnection
from models.user import User
from modules.gl_accuracy import service

logger = logging.getLogger(__name__)
router = APIRouter()


def _parse_period(period_end: str) -> date:
    try:
        return date.fromisoformat(period_end)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid period_end (expected YYYY-MM-DD).")


async def _load_finding(db: AsyncSession, finding_id: str) -> GlAccuracyFinding:
    try:
        fid = uuid.UUID(finding_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid finding id.")
    # SELECT is tenant-auto-filtered → scoped to the caller's workspace.
    row = (await db.execute(
        select(GlAccuracyFinding).where(GlAccuracyFinding.id == fid)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Finding not found.")
    return row


@router.post("/scan")
async def scan(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Run the accuracy check for a period: pull the GL + a trailing window,
    compare each vendor's coding to its own history, and persist the flags."""
    pe = _parse_period(period_end)
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(
            status_code=400,
            detail="QuickBooks isn't connected for this workspace. Connect QBO and try again.",
        )
    summary = await service.scan_period(conn, db, tenant_id=tenant_id, period_end=pe)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id, action="gl_accuracy.scan",
        entity_type="period", entity_id=None,
        metadata={"summary": f"Ran GL accuracy check for {pe} — {summary['findings']} to review",
                  "period_end": pe.isoformat(), "findings": summary["findings"],
                  "scanned": summary["scanned"]},
    )
    await db.commit()
    return summary


@router.get("/findings")
async def findings(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Findings for the period (open first) + the reassurance-strip summary."""
    pe = _parse_period(period_end)
    return await service.list_findings(db, pe)


@router.post("/findings/{finding_id}/accept")
async def accept(
    finding_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """File the reclass as a draft adjusting entry in the Adjustments queue and
    link it back to this finding. Never posts to QuickBooks — the human does."""
    finding = await _load_finding(db, finding_id)
    if finding.status != "open":
        raise HTTPException(status_code=400, detail="This finding has already been actioned.")
    pe_id = await service.accept_finding(db, tenant_id=tenant_id, finding=finding, user_id=user.id)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id, action="gl_accuracy.accept",
        entity_type="gl_accuracy_finding", entity_id=finding.id,
        metadata={"summary": f"Filed reclass for {finding.vendor} to Adjustments",
                  "proposed_entry_id": str(pe_id), "period_end": finding.period_end.isoformat()},
    )
    await db.commit()
    await db.refresh(finding)
    return service.serialize_finding(finding)


class BulkAcceptBody(BaseModel):
    ids: list[str] = Field(..., min_length=1, max_length=500)


@router.post("/findings/bulk-accept")
async def bulk_accept(
    body: BulkAcceptBody,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """File several open findings' reclasses into Adjustments at once — for the
    reviewer's pre-close sweep. Atomic: one transaction, so all selected
    findings are filed or none are. Accept-only by design; dismiss stays a
    deliberate single action (it teaches the watchdog a permanent exception).
    Already-actioned ids in the selection are silently skipped."""
    ids: list[uuid.UUID] = []
    for raw in body.ids:
        try:
            ids.append(uuid.UUID(raw))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid finding id in selection.")

    # Tenant-auto-filtered SELECT → scoped to the caller's workspace; the
    # status guard means re-submitting a partly-actioned selection is safe.
    rows = (await db.execute(
        select(GlAccuracyFinding).where(
            GlAccuracyFinding.id.in_(ids),
            GlAccuracyFinding.status == "open",
        )
    )).scalars().all()

    accepted = 0
    period_end: date | None = None
    for finding in rows:
        # Review-only flags aren't fixable by a JE — skip them defensively even
        # if one slips into the selection (the UI never offers them for bulk).
        if (finding.action_kind or "reclass") == "flag":
            continue
        await service.accept_finding(db, tenant_id=tenant_id, finding=finding, user_id=user.id)
        period_end = finding.period_end
        accepted += 1

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id, action="gl_accuracy.bulk_accept",
        entity_type="period", entity_id=None,
        metadata={"summary": f"Filed {accepted} reclass entries to Adjustments",
                  "count": accepted,
                  "period_end": period_end.isoformat() if period_end else None},
    )
    await db.commit()
    return {"accepted": accepted}


@router.post("/findings/{finding_id}/dismiss")
async def dismiss(
    finding_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mark the coding correct: records a confirmed vendor→account exception so
    the watchdog never re-flags this pairing. Reviewer+ (a standing decision)."""
    finding = await _load_finding(db, finding_id)
    if finding.status != "open":
        raise HTTPException(status_code=400, detail="This finding has already been actioned.")
    await service.dismiss_finding(db, tenant_id=tenant_id, finding=finding, user_id=user.id)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id, action="gl_accuracy.dismiss",
        entity_type="gl_accuracy_finding", entity_id=finding.id,
        metadata={"summary": f"Confirmed {finding.vendor} → {finding.posted_account_name or finding.posted_account_id} is correct",
                  "period_end": finding.period_end.isoformat()},
    )
    await db.commit()
    await db.refresh(finding)
    return service.serialize_finding(finding)


@router.post("/findings/{finding_id}/acknowledge")
async def acknowledge(
    finding_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mark a review-only flag as handled (no journal entry). For Risk-Radar
    findings whose fix is to investigate, not reclass (duplicates, missing memos,
    …). Distinct from dismiss ('this isn't a problem')."""
    finding = await _load_finding(db, finding_id)
    if finding.status != "open":
        raise HTTPException(status_code=400, detail="This finding has already been actioned.")
    await service.acknowledge_finding(db, finding=finding, user_id=user.id)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id, action="gl_accuracy.acknowledge",
        entity_type="gl_accuracy_finding", entity_id=finding.id,
        metadata={"summary": f"Acknowledged risk finding for {finding.vendor}",
                  "kind": finding.kind, "period_end": finding.period_end.isoformat()},
    )
    await db.commit()
    await db.refresh(finding)
    return service.serialize_finding(finding)
