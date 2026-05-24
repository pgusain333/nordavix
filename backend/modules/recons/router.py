"""
Reconciliations API.

  GET    /reconciliations                       list (with optional ?type=AR filter)
  POST   /reconciliations                       create + start QBO sync
  GET    /reconciliations/dashboard             KPIs + activity + insights
  GET    /reconciliations/{id}                  detail (recon + items + txns + notes)
  POST   /reconciliations/{id}/sync             re-pull from QBO + recompute
  POST   /reconciliations/{id}/approve          mark approved
  POST   /reconciliations/{id}/assign           assign to user (or null to clear)
  POST   /reconciliations/{id}/notes            add a note
  PUT    /reconciliations/{id}/items/{itemId}/status   set item status
  POST   /reconciliations/{id}/items/{itemId}/regenerate  rerun AI for one item
  DELETE /reconciliations/{id}                  hard delete
  GET    /reconciliations/{id}/export           Excel support package
"""
import io
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pandas as pd
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.reconciliation import (
    Reconciliation,
    ReconciliationItem,
    ReconNote,
    ReconTransaction,
)
from modules.recons.schemas import (
    ActivityFeedEntry,
    AssignBody,
    ItemStatusUpdate,
    NoteCreate,
    ReconciliationCreate,
    ReconciliationDashboard,
    ReconciliationDashboardStats,
    ReconciliationDetail,
    ReconciliationItemResponse,
    ReconciliationResponse,
    ReconNoteResponse,
    ReconTransactionResponse,
)
from modules.recons.service import insights_from, run_sync

router = APIRouter()


# ── List + create ────────────────────────────────────────────────────────────

@router.get("", response_model=list[ReconciliationResponse])
async def list_reconciliations(
    tenant_id: CurrentTenantId,
    recon_type: str | None = Query(default=None, alias="type"),
    db: AsyncSession = Depends(get_db),
) -> list[Reconciliation]:
    stmt = select(Reconciliation).order_by(desc(Reconciliation.created_at))
    if recon_type:
        stmt = stmt.where(Reconciliation.recon_type == recon_type.upper())
    return list((await db.execute(stmt)).scalars().all())


@router.post("", response_model=ReconciliationResponse, status_code=status.HTTP_201_CREATED)
async def create_reconciliation(
    body: ReconciliationCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = Reconciliation(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=body.name,
        recon_type=body.recon_type,
        period_end=body.period_end,
        status="pending",
        created_by=user.id,
    )
    db.add(recon)
    await db.commit()
    await db.refresh(recon)

    # Sync immediately in the background
    background_tasks.add_task(run_sync, recon.id, tenant_id)
    return recon


# ── Dashboard ─────────────────────────────────────────────────────────────────

@router.get("/dashboard", response_model=ReconciliationDashboard)
async def get_dashboard(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationDashboard:
    recons = list((await db.execute(
        select(Reconciliation).order_by(desc(Reconciliation.created_at))
    )).scalars().all())

    item_rows = list((await db.execute(
        select(ReconciliationItem)
    )).scalars().all())

    total = len(recons)
    completed = sum(1 for r in recons if r.status == "approved")
    pending_review = sum(1 for r in recons if r.status in ("in_review", "computing", "syncing"))
    high_risk = sum(1 for i in item_rows if i.risk_level == "high")
    unresolved = sum((abs(r.difference) for r in recons if r.status != "approved"), Decimal("0"))
    overdue = sum((i.aging_61_90 + i.aging_over_90 for i in item_rows), Decimal("0"))

    stats = ReconciliationDashboardStats(
        total=total,
        completed=completed,
        pending_review=pending_review,
        high_risk_accounts=high_risk,
        unresolved_difference=unresolved,
        overdue_aging_total=overdue,
    )

    recent = recons[:6]

    # Build a synthetic activity feed from recon timestamps + notes.
    activity: list[ActivityFeedEntry] = []
    notes = list((await db.execute(
        select(ReconNote).order_by(desc(ReconNote.created_at)).limit(20)
    )).scalars().all())
    name_lookup = {r.id: r.name for r in recons}

    for r in recons[:10]:
        activity.append(ActivityFeedEntry(
            kind="created",
            recon_id=r.id,
            recon_name=r.name,
            happened_at=r.created_at,
            actor_id=r.created_by,
            summary=f"Created {r.recon_type} reconciliation for {r.period_end}",
        ))
        if r.approved_at:
            activity.append(ActivityFeedEntry(
                kind="approved",
                recon_id=r.id,
                recon_name=r.name,
                happened_at=r.approved_at,
                actor_id=r.approved_by,
                summary=f"Approved {r.name}",
            ))
        if r.ai_summary:
            activity.append(ActivityFeedEntry(
                kind="ai_commentary",
                recon_id=r.id,
                recon_name=r.name,
                happened_at=r.updated_at,
                actor_id=None,
                summary="AI commentary generated",
            ))

    for n in notes:
        activity.append(ActivityFeedEntry(
            kind="noted",
            recon_id=n.reconciliation_id,
            recon_name=name_lookup.get(n.reconciliation_id, "Reconciliation"),
            happened_at=n.created_at,
            actor_id=n.author_id,
            summary=(n.body[:80] + "…") if len(n.body) > 80 else n.body,
        ))

    activity.sort(key=lambda e: e.happened_at, reverse=True)
    activity = activity[:15]

    return ReconciliationDashboard(
        stats=stats,
        recent=[ReconciliationResponse.model_validate(r) for r in recent],
        activity=activity,
        ai_insights=insights_from(recons, item_rows),
    )


# ── Get one ────────────────────────────────────────────────────────────────────

@router.get("/{recon_id}", response_model=ReconciliationDetail)
async def get_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationDetail:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    items = list((await db.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon_id)
        .order_by(desc(ReconciliationItem.subledger_balance))
    )).scalars().all())

    item_ids = [i.id for i in items]
    txns: list[ReconTransaction] = []
    if item_ids:
        txns = list((await db.execute(
            select(ReconTransaction).where(ReconTransaction.reconciliation_item_id.in_(item_ids))
        )).scalars().all())

    notes = list((await db.execute(
        select(ReconNote).where(ReconNote.reconciliation_id == recon_id)
        .order_by(desc(ReconNote.created_at))
    )).scalars().all())

    return ReconciliationDetail(
        recon=ReconciliationResponse.model_validate(recon),
        items=[ReconciliationItemResponse.model_validate(i) for i in items],
        transactions=[ReconTransactionResponse.model_validate(t) for t in txns],
        notes=[ReconNoteResponse.model_validate(n) for n in notes],
    )


# ── Sync (re-pull from QBO) ───────────────────────────────────────────────────

@router.post("/{recon_id}/sync", response_model=ReconciliationResponse)
async def sync_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.status = "syncing"
    recon.error_detail = None
    await db.commit()
    background_tasks.add_task(run_sync, recon_id, tenant_id)
    await db.refresh(recon)
    return recon


# ── Approve / assign ──────────────────────────────────────────────────────────

@router.post("/{recon_id}/approve", response_model=ReconciliationResponse)
async def approve_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.approved_by = user.id
    recon.approved_at = datetime.now(timezone.utc)
    recon.status = "approved"
    await db.commit()
    return recon


@router.post("/{recon_id}/assign", response_model=ReconciliationResponse)
async def assign_reconciliation(
    recon_id: uuid.UUID,
    body: AssignBody,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.assigned_to = body.user_id
    await db.commit()
    return recon


# ── Notes ─────────────────────────────────────────────────────────────────────

@router.post("/{recon_id}/notes", response_model=ReconNoteResponse, status_code=status.HTTP_201_CREATED)
async def add_note(
    recon_id: uuid.UUID,
    body: NoteCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ReconNote:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    note = ReconNote(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        reconciliation_id=recon_id,
        reconciliation_item_id=body.reconciliation_item_id,
        author_id=user.id,
        body=body.body,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


# ── Item-level actions ────────────────────────────────────────────────────────

@router.put("/{recon_id}/items/{item_id}/status", response_model=ReconciliationItemResponse)
async def set_item_status(
    recon_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ItemStatusUpdate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationItem:
    item = (await db.execute(
        select(ReconciliationItem).where(
            ReconciliationItem.id == item_id,
            ReconciliationItem.reconciliation_id == recon_id,
        )
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    item.status = body.status
    if body.status == "approved":
        item.approved_by = user.id
        item.approved_at = datetime.now(timezone.utc)
    await db.commit()
    return item


@router.post("/{recon_id}/items/{item_id}/regenerate", response_model=ReconciliationItemResponse)
async def regenerate_item(
    recon_id: uuid.UUID,
    item_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationItem:
    """Clear and re-run AI commentary for a single item."""
    item = (await db.execute(
        select(ReconciliationItem).where(
            ReconciliationItem.id == item_id,
            ReconciliationItem.reconciliation_id == recon_id,
        )
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    item.ai_commentary = None
    await db.commit()
    # Re-run AI by triggering a full recompute pass; cheap because everything else
    # is already in place. (Per-item AI extraction would be a future refinement.)
    background_tasks.add_task(_regen_one, recon_id, item_id, tenant_id)
    return item


async def _regen_one(recon_id: uuid.UUID, item_id: uuid.UUID, tenant_id: uuid.UUID) -> None:
    """Background helper: run AI commentary for a single item."""
    from core.db.base import current_tenant_id as _tid
    from core.db.session import AsyncSessionLocal as _S
    from modules.recons.service import _generate_ai_commentary  # internal helper

    _tid.set(tenant_id)
    async with _S() as session:
        recon = (await session.execute(
            select(Reconciliation).where(Reconciliation.id == recon_id)
        )).scalar_one_or_none()
        if recon is None:
            return
        # Generate for ALL items (it skips items that already have commentary
        # AND are not high-risk, so this is effectively scoped to ones missing).
        await _generate_ai_commentary(session, recon, tenant_id)
        await session.commit()


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{recon_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> None:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    await db.delete(recon)
    await db.commit()


# ── Export support package (Excel) ────────────────────────────────────────────

@router.get("/{recon_id}/export")
async def export_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    items = list((await db.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon_id)
        .order_by(desc(ReconciliationItem.subledger_balance))
    )).scalars().all())
    item_ids = [i.id for i in items]

    txns: list[ReconTransaction] = []
    if item_ids:
        txns = list((await db.execute(
            select(ReconTransaction).where(ReconTransaction.reconciliation_item_id.in_(item_ids))
        )).scalars().all())

    notes = list((await db.execute(
        select(ReconNote).where(ReconNote.reconciliation_id == recon_id)
        .order_by(ReconNote.created_at)
    )).scalars().all())

    name_by_item = {i.id: i.entity_name for i in items}

    summary_df = pd.DataFrame({
        "Field": ["Reconciliation", "Type", "Period End", "GL Total",
                  "Subledger Total", "Difference", "Status", "AI Summary"],
        "Value": [recon.name, recon.recon_type, str(recon.period_end),
                  f"${float(recon.gl_total):,.2f}",
                  f"${float(recon.subledger_total):,.2f}",
                  f"${float(recon.difference):,.2f}",
                  recon.status, recon.ai_summary or ""],
    })
    items_df = pd.DataFrame([{
        "Entity": i.entity_name,
        "GL Balance": float(i.gl_balance),
        "Subledger Balance": float(i.subledger_balance),
        "Difference": float(i.difference),
        "Current": float(i.aging_current),
        "1-30": float(i.aging_1_30),
        "31-60": float(i.aging_31_60),
        "61-90": float(i.aging_61_90),
        "Over 90": float(i.aging_over_90),
        "Risk": i.risk_level,
        "Status": i.status,
        "AI Commentary": i.ai_commentary or "",
    } for i in items])
    txns_df = pd.DataFrame([{
        "Entity": name_by_item.get(t.reconciliation_item_id, ""),
        "Category": t.category,
        "Type": t.txn_type,
        "Number": t.txn_number or "",
        "Date": str(t.txn_date) if t.txn_date else "",
        "Amount": float(t.amount),
        "Memo": t.memo or "",
    } for t in txns])
    notes_df = pd.DataFrame([{
        "When": n.created_at.isoformat(),
        "Body": n.body,
    } for n in notes])

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        summary_df.to_excel(writer, sheet_name="Summary", index=False)
        items_df.to_excel(writer, sheet_name="Items", index=False)
        if not txns_df.empty:
            txns_df.to_excel(writer, sheet_name="Evidence", index=False)
        if not notes_df.empty:
            notes_df.to_excel(writer, sheet_name="Notes", index=False)
        for sheet in writer.sheets.values():
            for col in sheet.columns:
                max_len = max((len(str(c.value or "")) for c in col), default=10)
                sheet.column_dimensions[col[0].column_letter].width = min(max_len + 2, 60)

    buf.seek(0)
    safe = recon.name.replace(" ", "_").replace("/", "-")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{safe}_reconciliation.xlsx"'},
    )
