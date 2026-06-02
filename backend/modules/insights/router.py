"""
Insights API.

  GET /insights/overview?period_end=YYYY-MM-DD[&period_start=...][&refresh=1]
    → Liquidity, AR/AP, profitability, expenses, and heuristic
      recommendations for the requested period. Reads from
      gl_balance_snapshots + period_sync; calls QBO live for
      AR/AP aging detail (degrades gracefully if not connected).

      The computed payload is cached per (tenant, period_end, period_start)
      in `insights_snapshots`. A revisit returns the saved snapshot instantly
      (no recompute, no live QBO call). Pass refresh=1 (the "Sync" button) to
      recompute and overwrite the cache. Every payload carries `saved_at` —
      the timestamp of the cached compute — for the "Synced {time}" label.
"""
from __future__ import annotations

from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from models.insights_snapshot import InsightsSnapshot
from modules.insights.service import compute_overview

router = APIRouter()


def _snapshot_query(pe: date, ps: date | None):
    """Select the cached snapshot for this exact window (tenant auto-filtered)."""
    stmt = select(InsightsSnapshot).where(InsightsSnapshot.period_end == pe)
    if ps is None:
        return stmt.where(InsightsSnapshot.period_start.is_(None))
    return stmt.where(InsightsSnapshot.period_start == ps)


@router.get("/overview")
async def get_overview(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    period_start: str | None = Query(default=None, description="YYYY-MM-DD — optional. When provided, P&L metrics span [period_start, period_end] via a live QBO ProfitAndLoss call instead of the calendar month containing period_end."),
    refresh: bool = Query(default=False, description="Recompute and overwrite the cached snapshot (the Sync button). When false, a previously computed snapshot is returned as-is."),
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

    # Serve the cached snapshot untouched unless an explicit Sync was requested.
    if not refresh:
        saved = (await db.execute(_snapshot_query(pe, ps))).scalar_one_or_none()
        if saved is not None:
            payload = dict(saved.payload)
            payload["saved_at"] = saved.computed_at.isoformat()
            return payload

    # Compute (this is the expensive path: snapshot read + live QBO aging) and
    # upsert the cache so the next plain load is instant.
    payload = await compute_overview(db, tenant_id, pe, period_start=ps)
    now = datetime.now(UTC)
    existing = (await db.execute(_snapshot_query(pe, ps))).scalar_one_or_none()
    if existing is not None:
        existing.payload = payload
        existing.computed_at = now
    else:
        db.add(
            InsightsSnapshot(
                tenant_id=tenant_id,
                period_end=pe,
                period_start=ps,
                payload=payload,
                computed_at=now,
            )
        )
    await db.commit()

    # Stamp the response only (post-commit) so the DB blob stays free of saved_at.
    payload["saved_at"] = now.isoformat()
    return payload
