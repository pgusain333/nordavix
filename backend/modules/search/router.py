"""Workspace search API.

  GET /api/search?q=…&limit=…    ranked hits across the whole workspace

Read-only and open to any member: it returns nothing a member can't already
reach by clicking, and every SELECT underneath is tenant-auto-filtered.
"""
import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from modules.search.service import DEFAULT_LIMIT, MIN_QUERY, search

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("")
async def search_workspace(
    tenant_id: CurrentTenantId,
    q: str = Query("", max_length=120),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> dict:
    hits = await search(db, tenant_id, q, limit=limit)
    return {"query": q, "min_query": MIN_QUERY, "results": hits}
