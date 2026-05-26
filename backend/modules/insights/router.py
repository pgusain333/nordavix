"""
Insights API.

  GET /insights/overview?period_end=YYYY-MM-DD
    → Liquidity, AR/AP, profitability, expenses, and heuristic
      recommendations for the requested period. Reads from
      gl_balance_snapshots + period_sync; calls QBO live for
      AR/AP aging detail (degrades gracefully if not connected).
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from modules.insights.service import compute_overview

router = APIRouter()


@router.get("/overview")
async def get_overview(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    period_start: str | None = Query(default=None, description="YYYY-MM-DD — optional. When provided, P&L metrics span [period_start, period_end] via a live QBO ProfitAndLoss call instead of the calendar month containing period_end."),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD")
    ps: date | None = None
    if period_start:
        try:
            ps = date.fromisoformat(period_start)
        except ValueError:
            raise HTTPException(status_code=400, detail="period_start must be YYYY-MM-DD")
        if ps > pe:
            raise HTTPException(status_code=400, detail="period_start must be on or before period_end")
    return await compute_overview(db, tenant_id, pe, period_start=ps)
