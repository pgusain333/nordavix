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

import logging
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from models.insights_snapshot import InsightsSnapshot
from models.period_sync import PeriodSync
from models.tenant import Tenant
from modules.insights.service import cache_is_fresh, compute_overview, window_is_perishable

logger = logging.getLogger(__name__)
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

    # Serve the cached snapshot, but only while it still describes the data it
    # was computed from. The cache used to be served unconditionally and was
    # never invalidated by anything — so re-syncing a period from QuickBooks,
    # posting adjusting entries, or fixing a misclassification left Insights
    # showing the figures from whenever the month was first opened, with
    # nothing on screen to say so. AR, AP and cash all drifted from
    # QuickBooks that way, by a different amount in each month.
    #
    # Compared against the period's CURRENT sync stamp rather than cleared by
    # the writers: a cache that heals itself cannot be broken by a future write
    # path forgetting to call an invalidation hook.
    # Which year this period belongs to. NULL means December, which is what
    # every workspace was implicitly on — so this changes nothing until a firm
    # sets it, and everything for the one that does.
    fye = (await db.execute(
        select(Tenant.fiscal_year_end).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()

    if not refresh:
        saved = (await db.execute(_snapshot_query(pe, ps))).scalar_one_or_none()
        if saved is not None:
            current_sync = (await db.execute(
                select(PeriodSync.synced_at).where(PeriodSync.period_end == pe)
            )).scalar_one_or_none()
            current_iso = current_sync.isoformat() if current_sync else None
            payload = dict(saved.payload)
            # A custom window's P&L is a LIVE QuickBooks pull, so the period's
            # sync stamp — the only thing the staleness check compares — says
            # nothing about whether those figures are still true. Such a payload
            # could never go stale: post entries in QuickBooks, reload the same
            # window, and the first computed number came back indefinitely.
            # Age it out instead.
            # Ask about the WINDOW, not about whether a period_start arrived.
            # `ps is not None` was a stand-in for "custom range" until the page
            # began sending period_start on every view — after which every
            # ordinary month expired in fifteen minutes and recomputed itself
            # live, five sequential QuickBooks calls deep, on essentially every
            # visit. A finished calendar month is not a custom range.
            # Two ways a payload can be live-sourced, and the second is the
            # honest one: the window SHAPE may need a live report, or the
            # computation may have fallen back to one because a snapshot it
            # wanted was missing. The payload records which actually happened,
            # so ask it rather than predicting.
            if cache_is_fresh(payload, current_iso,
                              live_sourced=(window_is_perishable(ps, pe, fiscal_year_end=fye)
                                            or payload.get("pl_source") == "live"),
                              computed_at=saved.computed_at):
                payload["saved_at"] = saved.computed_at.isoformat()
                return payload
            logger.info(
                "Insights cache stale for %s%s (computed against %s at %s, period now "
                "synced %s) — recomputing",
                pe, f" [from {ps}]" if ps else "",
                payload.get("source_synced_at"), saved.computed_at, current_iso,
            )

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
