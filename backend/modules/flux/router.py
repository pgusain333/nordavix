import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.trial_balance import TrialBalance
from modules.flux.schemas import FluxRunResponse, TrialBalanceCreate, TrialBalanceResponse

router = APIRouter()


@router.get("/trial-balances", response_model=list[TrialBalanceResponse])
async def list_trial_balances(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> list[TrialBalance]:
    """List all trial balances for the current tenant, newest first."""
    result = await db.execute(
        select(TrialBalance).order_by(TrialBalance.created_at.desc())
    )
    return list(result.scalars().all())


@router.post("/trial-balances", response_model=TrialBalanceResponse, status_code=status.HTTP_201_CREATED)
async def create_trial_balance(
    body: TrialBalanceCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TrialBalance:
    """Create a new trial balance record (before file upload)."""
    tb = TrialBalance(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=body.name,
        period_current=body.period_current,
        period_prior=body.period_prior,
        materiality_threshold=body.materiality_threshold,
        created_by=user.id,
        status="pending",
    )
    db.add(tb)
    await db.commit()
    await db.refresh(tb)
    return tb


@router.get("/trial-balances/{tb_id}", response_model=TrialBalanceResponse)
async def get_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> TrialBalance:
    """Get a single trial balance. Tenant filter is applied automatically by the ORM."""
    result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trial balance not found")
    return tb


@router.post("/trial-balances/{tb_id}/run", response_model=FluxRunResponse)
async def run_flux(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> FluxRunResponse:
    """
    Trigger async flux analysis for a trial balance.
    Enqueues a Celery task and returns the task ID for polling.
    Full implementation in Phase 4 — returns 202 stub for Phase 1.
    """
    result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trial balance not found")
    if tb.status not in ("parsed", "error"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot run flux on a trial balance with status '{tb.status}'",
        )

    # Phase 4 will enqueue the Celery task here
    return FluxRunResponse(
        trial_balance_id=tb_id,
        task_id="pending-phase-4",
        status="queued",
        message="Flux analysis queued. Poll /api/flux/trial-balances/{id} for status updates.",
    )
