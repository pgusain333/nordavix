"""Nordavix Allocate — HTTP surface for the monthly §471(c) run.

    POST /api/allocation/runs             compute (or recompute) a period
    GET  /api/allocation/runs             list runs, newest period first
    GET  /api/allocation/runs/{id}        one run + its per-account detail
    POST /api/allocation/runs/{id}/approve   maker-checker sign-off

Every handler is tenant-scoped by the standard dependencies; TenantBase filters
SELECTs automatically and writes carry tenant_id explicitly.

Maker-checker mirrors the close app: a preparer can compute a run, but approving
one requires `reviewer`, and nobody can approve a run they prepared themselves.
"""
import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_role
from core.db.session import get_db
from models.cost_allocation import AllocRun, AllocRunLine
from models.user import User
from modules.cost_allocation.service import run_allocation, serialize_run

router = APIRouter()


class RunRequest(BaseModel):
    period_start: date
    period_end: date
    # Optional roll-forward inputs. Supplied together they produce COGS on the
    # run; omitted, the allocation still computes and COGS is filled in later.
    beginning_inventory: float | None = Field(default=None)
    ending_inventory: float | None = Field(default=None)
    purchases: float | None = Field(default=None)


def _dec(v: float | None):
    from decimal import Decimal
    return Decimal(str(v)) if v is not None else None


@router.post("/runs", status_code=status.HTTP_201_CREATED)
async def create_run(
    body: RunRequest,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Compute the allocation for a period, superseding any live run for it.

    Returns 201 with the run either way: a run that couldn't be computed comes
    back as a draft carrying `blocked_reason`, because "this client has no square
    footage on file" is a task for the practice, not an error to swallow.
    """
    if body.period_end < body.period_start:
        raise HTTPException(status_code=422, detail="period_end must be on or after period_start.")

    run = await run_allocation(
        db,
        tenant_id=tenant_id,
        period_start=body.period_start,
        period_end=body.period_end,
        user_id=user.id,
        beginning_inventory=_dec(body.beginning_inventory),
        ending_inventory=_dec(body.ending_inventory),
        purchases=_dec(body.purchases),
    )
    await db.commit()
    await db.refresh(run)
    return serialize_run(run)


@router.get("/runs")
async def list_runs(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Runs for this client, newest period first. Superseded ones included so
    the history of what was issued stays visible."""
    runs = (await db.execute(
        select(AllocRun).order_by(AllocRun.period_end.desc(), AllocRun.created_at.desc())
    )).scalars().all()
    return [serialize_run(r) for r in runs]


@router.get("/runs/{run_id}")
async def get_run(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One run plus its per-account allocation detail — the workpaper body."""
    run = (await db.execute(select(AllocRun).where(AllocRun.id == run_id))).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Allocation run not found.")

    lines = (await db.execute(
        select(AllocRunLine)
        .where(AllocRunLine.run_id == run_id)
        .order_by(AllocRunLine.pool_name, AllocRunLine.account_number, AllocRunLine.qbo_account_id)
    )).scalars().all()
    return serialize_run(run, list(lines))


@router.post("/runs/{run_id}/approve")
async def approve_run(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Sign off a run. Reviewer+ only, and never your own work."""
    run = (await db.execute(select(AllocRun).where(AllocRun.id == run_id))).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Allocation run not found.")
    if run.status == "superseded":
        raise HTTPException(status_code=409, detail="This run has been superseded by a newer one.")
    if run.blocked_reason:
        raise HTTPException(
            status_code=409,
            detail=f"This run is blocked and can't be approved: {run.blocked_reason}",
        )
    if run.status == "approved":
        return serialize_run(run)
    # Maker-checker: the preparer can't be the approver.
    if run.prepared_by is not None and run.prepared_by == user.id:
        raise HTTPException(
            status_code=403,
            detail="An allocation must be approved by someone other than the person who prepared it.",
        )

    run.status = "approved"
    run.approved_by = user.id
    run.approved_at = datetime.now(UTC)

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.run_approved", entity_type="alloc_run", entity_id=run.id,
        metadata={"summary": (
            f"Approved §471(c) allocation for {run.period_end.isoformat()} "
            f"({run.capitalized_total} capitalized)"
        )},
    )
    await db.commit()
    await db.refresh(run)
    return serialize_run(run)
