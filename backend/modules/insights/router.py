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
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD")
    return await compute_overview(db, tenant_id, pe)
