"""
Close Management workflow API — the milestone checklist above Tasks.

  GET   /api/close/periods             month list + focus period (any member)
  GET   /api/close/checklist?period_end=…   the period's ordered checklist
  POST  /api/close/step                update one step (complete / assign / note)
  GET   /api/close/template            the reusable step template (any member)
  POST  /api/close/template            add a custom step          (admin)
  PATCH /api/close/template/{id}       edit / (de)activate a step (admin)
  DELETE /api/close/template/{id}      remove a CUSTOM step       (admin)
  POST  /api/close/template/reorder    reorder steps              (admin)

LINKED steps (sync / recon / schedule / flux / close) derive their status from
the underlying module and can't be ticked by hand; manual steps are toggled by
any member. Assign / due-date changes are admin-only (matches the Tasks rules).
"""
import logging
import uuid
from datetime import date

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_role
from core.db.base import current_request_readonly
from core.db.session import get_db
from models.close_step import CloseStepInstance, CloseTemplateStep
from models.closed_period import ClosedPeriod
from models.tenant import Tenant
from models.user import User
from modules.close_workflow import service

logger = logging.getLogger(__name__)
router = APIRouter()

_DEFAULT_KEYS = {s["key"] for s in service.DEFAULT_STEPS}


def _parse_period(period_end: str) -> date:
    try:
        return date.fromisoformat(period_end)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid period_end (expected YYYY-MM-DD).")


async def _tenant(db: AsyncSession, tenant_id: uuid.UUID) -> Tenant:
    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    return t


@router.get("/periods")
async def get_periods(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    from datetime import date as _date
    t = await _tenant(db, tenant_id)
    closed = {r[0] for r in (await db.execute(select(ClosedPeriod.period_end))).all()}
    today = _date.today()
    focus = service.focus_period(t, closed, today)
    return {
        "books_start_date": t.books_start_date.isoformat() if t.books_start_date else None,
        "periods": service.list_periods(t, closed, today),
        "focus":   focus.isoformat() if focus else None,
    }


@router.get("/checklist")
async def get_checklist(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    pe = _parse_period(period_end)
    steps = await service.build_checklist(db, tenant_id, pe, user.id)
    # build_checklist may have generated instance rows / stamped completions.
    # The read-only (demo) path never persists, so skip the commit there.
    if not current_request_readonly.get():
        await db.commit()
    total = len(steps)
    done = sum(1 for s in steps if s["status"] == "done")
    closed = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == pe)
    )).scalar_one_or_none() is not None
    return {
        "period_end": pe.isoformat(),
        "closed":     closed,
        "steps":      steps,
        "summary":    {"total": total, "done": done,
                       "pct": round(done / total * 100) if total else 0},
    }


@router.post("/step")
async def update_step(
    tenant_id: CurrentTenantId,
    background_tasks: BackgroundTasks,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
    period_end: str = Body(...),
    step_key: str = Body(...),
    status: str | None = Body(None),
    assignee_id: str | None = Body(None),
    due_date: str | None = Body(None),
    notes: str | None = Body(None),
    clear_assignee: bool = Body(False),
    clear_due: bool = Body(False),
) -> dict:
    pe = _parse_period(period_end)
    inst = await service.get_or_create_instance(db, tenant_id, pe, step_key, user.id)
    if inst is None:
        raise HTTPException(status_code=404, detail="Step not found for this workspace.")

    is_linked = inst.linked_module in service.VALID_LINKED
    is_admin = user.role == "admin"

    if status is not None:
        if is_linked:
            raise HTTPException(
                status_code=400,
                detail="This step updates automatically from its module — it can't be ticked by hand.",
            )
        if status not in service.VALID_STATUS:
            raise HTTPException(status_code=400, detail="Invalid status.")
        # Dependency gate: can't complete a step while its prerequisite is open.
        if status == "done":
            blocked, prereq_title = await service.blocked_for(db, pe, step_key)
            if blocked:
                raise HTTPException(
                    status_code=400,
                    detail=f"Complete “{prereq_title}” first — this step is blocked until then.",
                )
        inst.status = status
        now = service.utcnow()
        if status == "done":
            inst.completed_by = user.id
            inst.completed_at = now
        else:
            inst.completed_by = None
            inst.completed_at = None
        if status == "in_progress" and inst.started_at is None:
            inst.started_at = now

    # Assign / due — admin only (matches the Tasks rules).
    notify_assignee: uuid.UUID | None = None
    if assignee_id is not None or clear_assignee or due_date is not None or clear_due:
        if not is_admin:
            raise HTTPException(status_code=403, detail="Only an admin can assign owners or set due dates.")
        if clear_assignee:
            inst.assignee_id = None
        elif assignee_id is not None:
            try:
                new_uid = uuid.UUID(assignee_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid assignee_id.")
            # The assignee must be a member of THIS workspace — the User SELECT is
            # tenant-auto-filtered, so this rejects cross-tenant / garbage UUIDs
            # (and prevents an orphan notification to a non-member).
            member = (await db.execute(
                select(User.id).where(User.id == new_uid)
            )).scalar_one_or_none()
            if member is None:
                raise HTTPException(status_code=400, detail="Assignee is not a member of this workspace.")
            # Notify the new owner — but not when re-assigning to the same person
            # or assigning the step to yourself.
            if new_uid != inst.assignee_id and new_uid != user.id:
                notify_assignee = new_uid
            inst.assignee_id = new_uid
        if clear_due:
            inst.due_date = None
        elif due_date is not None:
            inst.due_date = _parse_period(due_date)

    if notes is not None:
        inst.notes = notes.strip() or None

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id, action="close.step_update",
        entity_type="close_step_instance", entity_id=inst.id,
        metadata={"step_key": step_key, "period_end": pe.isoformat(), "status": inst.status},
    )
    step_title = inst.title
    await db.commit()
    await db.refresh(inst)

    # Best-effort "assigned to you" notification — after the commit, never blocks
    # the assignment if it fails.
    if notify_assignee is not None:
        try:
            from modules.notifications.emails import notify_and_email_users
            await notify_and_email_users(
                db, background_tasks, tenant_id=tenant_id, recipient_ids=[notify_assignee],
                type="close_step_assigned",
                title=f"Close step assigned: {step_title}",
                body=f"{user.email} assigned you “{step_title}” for {pe.strftime('%b %Y')}.",
                link="/app/close",
                entity_type="close_step_instance", entity_id=str(inst.id),
                actor_name=user.email,
            )
        except Exception:
            logger.warning("close step assignment notification failed", exc_info=True)

    # Re-derive live status for linked steps so the response is accurate.
    linked = inst.linked_module in service.VALID_LINKED
    if linked:
        live, completed_at = await service.linked_status(db, inst.linked_module, pe)
        inst.status = live
        inst.completed_at = completed_at if live == "done" else None
    return service._serialize_instance(inst, linked=linked)


# ── Template (admin-managed) ──────────────────────────────────────────────


@router.get("/template")
async def get_template(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    steps = await service.get_or_seed_template(db, tenant_id, user.id)
    # Seeding (first use) writes rows; persist them (never on the demo tenant).
    if not current_request_readonly.get():
        await db.commit()
    return {"steps": [service.serialize_template_step(s) for s in
                      sorted(steps, key=lambda s: s.order_index)]}


async def _resolve_dependency(db: AsyncSession, step_key: str, dep_key: str | None) -> str | None:
    """Validate a prerequisite key for `step_key`: must exist, not be itself, and
    not create a cycle. Returns the normalized key or None. The SELECT is
    tenant-auto-filtered, so cross-tenant keys are invisible."""
    dep = (dep_key or "").strip()
    if not dep:
        return None
    if dep == step_key:
        raise HTTPException(status_code=400, detail="A step can't depend on itself.")
    rows = list((await db.execute(select(CloseTemplateStep))).scalars().all())
    by_key = {r.key: r for r in rows}
    if dep not in by_key:
        raise HTTPException(status_code=400, detail="Prerequisite step not found.")
    if not by_key[dep].is_active:
        raise HTTPException(status_code=400, detail="A hidden step can't be a prerequisite.")
    # Walk the chain from dep — if it leads back to step_key, it's circular.
    seen: set[str] = set()
    cur: str | None = dep
    while cur:
        if cur == step_key:
            raise HTTPException(status_code=400, detail="That would create a circular dependency.")
        if cur in seen:
            break
        seen.add(cur)
        nxt = by_key.get(cur)
        cur = nxt.depends_on_key if nxt else None
    return dep


@router.post("/template")
async def add_step(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
    title: str = Body(...),
    description: str | None = Body(None),
    category: str = Body("custom"),
    due_offset_days: int | None = Body(None),
    default_assignee_role: str | None = Body(None),
    depends_on_key: str | None = Body(None),
) -> dict:
    if not title.strip():
        raise HTTPException(status_code=400, detail="Title is required.")
    if category not in service.VALID_CATEGORIES:
        category = "custom"
    # Ensure the default template exists first, then append the custom step.
    existing = await service.get_or_seed_template(db, tenant_id, user.id)
    max_order = max((s.order_index for s in existing), default=-1)
    new_key = f"custom-{uuid.uuid4().hex[:8]}"
    dep = await _resolve_dependency(db, new_key, depends_on_key)
    step = CloseTemplateStep(
        id=uuid.uuid4(), tenant_id=tenant_id, key=new_key,
        order_index=max_order + 1, title=title.strip(), description=(description or None),
        category=category, linked_module=None, due_offset_days=due_offset_days,
        default_assignee_role=default_assignee_role, depends_on_key=dep,
        is_active=True, created_by=user.id,
    )
    db.add(step)
    await db.commit()
    await db.refresh(step)
    return service.serialize_template_step(step)


@router.patch("/template/{step_id}")
async def edit_step(
    step_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
    title: str | None = Body(None),
    description: str | None = Body(None),
    category: str | None = Body(None),
    due_offset_days: int | None = Body(None),
    default_assignee_role: str | None = Body(None),
    is_active: bool | None = Body(None),
    order_index: int | None = Body(None),
    depends_on_key: str | None = Body(None),
    clear_depends_on: bool = Body(False),
) -> dict:
    try:
        sid = uuid.UUID(step_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid step id.")
    step = (await db.execute(
        select(CloseTemplateStep).where(CloseTemplateStep.id == sid)
    )).scalar_one_or_none()
    if step is None:
        raise HTTPException(status_code=404, detail="Step not found.")

    if title is not None:
        if not title.strip():
            raise HTTPException(status_code=400, detail="Title can't be empty.")
        step.title = title.strip()
    if description is not None:
        step.description = description.strip() or None
    if category is not None and category in service.VALID_CATEGORIES:
        step.category = category
    if due_offset_days is not None:
        step.due_offset_days = due_offset_days
    if default_assignee_role is not None:
        step.default_assignee_role = default_assignee_role or None
    if is_active is not None:
        step.is_active = is_active
    if order_index is not None:
        step.order_index = order_index
    if clear_depends_on:
        step.depends_on_key = None
    elif depends_on_key is not None:
        step.depends_on_key = await _resolve_dependency(db, step.key, depends_on_key)

    await db.commit()
    await db.refresh(step)
    return service.serialize_template_step(step)


@router.delete("/template/{step_id}")
async def delete_step(
    step_id: str,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        sid = uuid.UUID(step_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid step id.")
    step = (await db.execute(
        select(CloseTemplateStep).where(CloseTemplateStep.id == sid)
    )).scalar_one_or_none()
    if step is None:
        raise HTTPException(status_code=404, detail="Step not found.")
    if step.key in _DEFAULT_KEYS:
        raise HTTPException(
            status_code=400,
            detail="Default steps can't be deleted — deactivate it instead to hide it.",
        )
    # Hard-delete a custom step and its per-period instances (keyed by step_key).
    # Tenant-scope the bulk DELETE explicitly — the session auto-filter only
    # rewrites SELECTs, not DML (see TenantBase docstring).
    await db.execute(
        delete(CloseStepInstance).where(
            CloseStepInstance.tenant_id == tenant_id,
            CloseStepInstance.step_key == step.key,
        )
    )
    await db.delete(step)
    await db.commit()
    return {"deleted": True}


@router.post("/template/reorder")
async def reorder_steps(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
    ordered_ids: list[str] = Body(..., embed=True),
) -> dict:
    rows = list((await db.execute(select(CloseTemplateStep))).scalars().all())
    by_id = {str(r.id): r for r in rows}
    for i, sid in enumerate(ordered_ids):
        row = by_id.get(sid)
        if row is not None:
            row.order_index = i
    await db.commit()
    return {"steps": [service.serialize_template_step(s) for s in
                      sorted(rows, key=lambda s: s.order_index)]}
