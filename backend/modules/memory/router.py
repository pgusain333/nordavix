"""
Client Memory API — review + confirm the conventions the AI has learned.

  GET   /memory/facts?status=        list learned facts (any member)
  POST  /memory/facts/{id}/confirm   suggested -> active   (reviewer+)
  POST  /memory/facts/{id}/dismiss   -> dismissed          (reviewer+)
  GET   /memory/facts/{id}/evidence  the signals behind a fact (provenance)

Confirm-first: a fact never changes AI output until a reviewer confirms it.
"""
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_role
from core.db.session import get_db
from models.client_memory import ClientMemoryFact, ClientMemorySignal
from models.user import User
from modules.memory.service import (
    VALID_FACT_STATUSES,
    active_schedule_default,
    serialize_fact,
)

logger = logging.getLogger(__name__)
router = APIRouter()


async def _load(db: AsyncSession, fact_id: str) -> ClientMemoryFact:
    try:
        fid = uuid.UUID(fact_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid fact id.")
    # Tenant auto-filter on the SELECT scopes this to the caller's workspace.
    row = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.id == fid)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Learned fact not found.")
    return row


@router.get("/facts")
async def list_facts(
    tenant_id: CurrentTenantId,
    status: str | None = Query(None, description="suggested | active | dismissed | stale"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Every fact the AI has learned for this workspace. Suggested first so the
    user sees what's awaiting their confirmation."""
    stmt = select(ClientMemoryFact)
    if status in VALID_FACT_STATUSES:
        stmt = stmt.where(ClientMemoryFact.status == status)
    # suggested (0) before active (1) before the rest; newest activity first.
    stmt = stmt.order_by(ClientMemoryFact.last_seen_at.desc())
    rows = list((await db.execute(stmt)).scalars().all())
    order = {"suggested": 0, "active": 1, "stale": 2, "dismissed": 3}
    rows.sort(key=lambda r: order.get(r.status, 9))
    return {
        "items": [serialize_fact(r) for r in rows],
        "suggested_count": sum(1 for r in rows if r.status == "suggested"),
    }


async def _transition(
    db: AsyncSession, tenant_id: uuid.UUID, user: User, fact_id: str,
    *, new_status: str, action: str,
) -> dict:
    fact = await _load(db, fact_id)
    fact.status = new_status
    now = datetime.now(UTC)
    if new_status == "active":
        fact.confirmed_by = user.id
        fact.confirmed_at = now
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id, action=action,
        entity_type="client_memory_fact", entity_id=fact.id,
        metadata={"kind": fact.kind, "fact_key": fact.fact_key, "status_after": new_status},
    )
    await db.commit()
    await db.refresh(fact)
    return serialize_fact(fact)


@router.post("/facts/{fact_id}/confirm")
async def confirm_fact(
    fact_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Promote a suggested convention to active — from now on the AI applies it.
    Reviewer+: confirming a standing rule is a review decision."""
    return await _transition(
        db, tenant_id, user, fact_id, new_status="active", action="memory.confirm"
    )


@router.post("/facts/{fact_id}/dismiss")
async def dismiss_fact(
    fact_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Reject a learned convention (or forget a confirmed one). It won't be
    re-suggested. Reviewer+."""
    return await _transition(
        db, tenant_id, user, fact_id, new_status="dismissed", action="memory.dismiss"
    )


@router.get("/schedule-default")
async def schedule_default(
    tenant_id: CurrentTenantId,
    schedule_type: str = Query(..., description="prepaid"),
    vendor: str = Query(..., description="vendor name to look up a confirmed setup for"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The CONFIRMED vendor setup to pre-fill a new schedule item, if any. Any
    member can read it (preparers use the pre-fill); only `active` facts apply,
    so nothing surfaces until a reviewer has confirmed it."""
    fact = await active_schedule_default(db, schedule_type=schedule_type, vendor=vendor)
    return {
        "default": (fact.value if fact else None),
        "fact_id": (str(fact.id) if fact else None),
    }


@router.get("/facts/{fact_id}/evidence")
async def fact_evidence(
    fact_id: str,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The signals that taught this fact — provenance the user can inspect
    before confirming."""
    fact = await _load(db, fact_id)
    ids: list[uuid.UUID] = []
    for s in (fact.provenance or {}).get("signal_ids", []):
        try:
            ids.append(uuid.UUID(str(s)))
        except (ValueError, TypeError):
            continue
    rows: list[ClientMemorySignal] = []
    if ids:
        rows = list((await db.execute(
            select(ClientMemorySignal)
            .where(ClientMemorySignal.id.in_(ids))
            .order_by(ClientMemorySignal.created_at.desc())
        )).scalars().all())
    return {
        "fact": serialize_fact(fact),
        "signals": [
            {
                "id": str(s.id),
                "signal_type": s.signal_type,
                "period_end": s.period_end.isoformat(),
                "before": s.before or {},
                "after": s.after or {},
                "created_at": s.created_at.isoformat() if s.created_at else None,
            }
            for s in rows
        ],
    }
