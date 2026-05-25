"""
Tasks API.

  GET   /tasks                  list open tasks for the current tenant
                                (derived from pending/flagged recons,
                                 merged with any overlay actions,
                                 plus any manual tasks)
  GET   /tasks/count            unread count for the sidebar badge
  POST  /tasks/action           upsert an overlay action on a derived task
                                (assign / snooze / notes / dismiss)
  POST  /tasks/manual           create a manual task
  PATCH /tasks/manual/{id}      update a manual task
  POST  /tasks/{id}/complete    mark a task done (manual or overlay)

Derived task identity:
  source_type='recon_account', source_id=qbo_account_id, period_end=YYYY-MM-DD

Overlay rows attach by that triple. When the underlying status flips
to approved (no longer in the derived list), the overlay row is left
in place — orphaned, but harmless. We can prune on a cadence later
if it matters.
"""
import logging
import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.account_review_status import AccountReviewStatus
from models.qbo_connection import QboConnection
from models.task_action import TaskAction

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────

class TaskOut(BaseModel):
    """A single row in the user-facing task list."""
    # Stable identity. For derived tasks: "recon_account:<qbo_id>:<YYYY-MM-DD>".
    # For manual tasks: "manual:<uuid>".
    key:           str
    source_type:   str                   # 'recon_account' | 'manual'
    source_id:     str | None
    period_end:    str | None
    subject:       str                   # human-readable title
    description:   str | None            # extra context
    severity:      str                   # 'info' | 'warn' | 'critical'
    deep_link:     str | None            # frontend route to resolve
    # Overlay fields — null on derived tasks the user hasn't touched yet.
    action_id:     str | None
    assignee_id:   str | None
    snooze_until:  str | None
    notes:         str | None
    completed_at:  str | None
    dismissed_at:  str | None
    # For manual tasks
    priority:      str | None
    created_by:    str | None
    created_at:    str | None


class TasksResponse(BaseModel):
    tasks: list[TaskOut]


class TaskActionUpsert(BaseModel):
    source_type:   str
    source_id:     str | None = None
    period_end:    str | None = None
    assignee_id:   str | None = None
    snooze_until:  str | None = None
    notes:         str | None = None
    dismissed:     bool | None = None    # True → set dismissed_at, False → clear


class ManualTaskCreate(BaseModel):
    subject:      str = Field(..., min_length=1, max_length=200)
    description:  str | None = None
    priority:     str | None = "normal"
    assignee_id:  str | None = None
    period_end:   str | None = None


class ManualTaskUpdate(BaseModel):
    subject:      str | None = None
    description:  str | None = None
    priority:     str | None = None
    assignee_id:  str | None = None
    snooze_until: str | None = None
    notes:        str | None = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _derived_key(source_type: str, source_id: str, period_end: date) -> str:
    return f"{source_type}:{source_id}:{period_end.isoformat()}"


def _manual_key(task_id: uuid.UUID) -> str:
    return f"manual:{task_id}"


def _severity_for_recon(review_status: str, variance: float) -> str:
    """Pending = info; flagged = warn; flagged with big variance = critical."""
    if review_status == "flagged":
        return "critical" if abs(variance) >= 1000 else "warn"
    return "info"


def _serialize_overlay_action(a: TaskAction, subject: str, description: str | None,
                              severity: str, deep_link: str | None) -> TaskOut:
    return TaskOut(
        key          = (_manual_key(a.id) if a.source_type == "manual"
                        else _derived_key(a.source_type, a.source_id or "", a.period_end or date.min)),
        source_type  = a.source_type,
        source_id    = a.source_id,
        period_end   = a.period_end.isoformat() if a.period_end else None,
        subject      = subject,
        description  = description,
        severity     = severity,
        deep_link    = deep_link,
        action_id    = str(a.id),
        assignee_id  = str(a.assignee_id) if a.assignee_id else None,
        snooze_until = a.snooze_until.isoformat() if a.snooze_until else None,
        notes        = a.notes,
        completed_at = a.completed_at.isoformat() if a.completed_at else None,
        dismissed_at = a.dismissed_at.isoformat() if a.dismissed_at else None,
        priority     = a.priority,
        created_by   = str(a.created_by),
        created_at   = a.created_at.isoformat() if a.created_at else None,
    )


# ── Derivation ───────────────────────────────────────────────────────────────

async def _derive_recon_tasks(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    overlays_by_key: dict[str, TaskAction],
) -> list[TaskOut]:
    """
    Pending + flagged recon accounts across ALL periods, joined with
    any overlay rows that exist. Each surfaces as one task.

    Doesn't need a live QBO call — we read the persisted
    AccountReviewStatus rows. Newly-synced accounts that haven't been
    touched yet won't have a row here (they're implicitly "pending"
    in the dashboard via the no-row-means-pending convention), but
    they ALSO won't have any open work tracked against them, so we
    skip them. Once the user opens the dashboard and a sync writes
    a row, the task appears.

    NOTE: We could also surface "no-row = implicit pending" tasks
    by reading the QBO TB at request time — costs a network round
    trip. Defer until users ask for it.
    """
    rows = list((await db.execute(
        select(AccountReviewStatus)
        .where(AccountReviewStatus.status.in_(("pending", "flagged")))
    )).scalars().all())

    out: list[TaskOut] = []
    for r in rows:
        key = _derived_key("recon_account", r.qbo_account_id, r.period_end)
        overlay = overlays_by_key.get(key)
        # Variance: re-derive from override values if present, else
        # 0 (we don't store GL balance on the review row).
        variance = float(r.subledger_total or 0)  # signed estimate

        period_label = r.period_end.strftime("%b %Y")
        # We don't have account name here — would need a join to QBO accounts
        # table (we don't store it). Frontend can hydrate the name from the
        # overview cache or display the qbo_account_id as a fallback.
        subject = f"Reconcile account {r.qbo_account_id} for {period_label}"
        description = (
            f"Status: {r.status}. Open the reconciliations dashboard "
            f"for {period_label} to tick reconciling items and approve."
        )
        severity = _severity_for_recon(r.status, variance)
        deep_link = f"/app/reconciliations/period/{r.period_end.isoformat()}"

        if overlay:
            # User-touched overlay: serialize that
            t = _serialize_overlay_action(overlay, subject, description, severity, deep_link)
        else:
            # Fresh derived task with no overlay yet — synthesize a TaskOut.
            t = TaskOut(
                key=key,
                source_type="recon_account",
                source_id=r.qbo_account_id,
                period_end=r.period_end.isoformat(),
                subject=subject,
                description=description,
                severity=severity,
                deep_link=deep_link,
                action_id=None,
                assignee_id=None,
                snooze_until=None,
                notes=None,
                completed_at=None,
                dismissed_at=None,
                priority=None,
                created_by=None,
                created_at=r.created_at.isoformat() if r.created_at else None,
            )
        out.append(t)
    return out


async def _load_overlays(db: AsyncSession, tenant_id: uuid.UUID) -> tuple[dict[str, TaskAction], list[TaskAction]]:
    """
    Returns (overlays_by_key, manual_rows).
    """
    all_rows = list((await db.execute(select(TaskAction))).scalars().all())
    overlays_by_key: dict[str, TaskAction] = {}
    manual_rows: list[TaskAction] = []
    for r in all_rows:
        if r.source_type == "manual":
            manual_rows.append(r)
        elif r.source_id and r.period_end:
            overlays_by_key[_derived_key(r.source_type, r.source_id, r.period_end)] = r
    return overlays_by_key, manual_rows


def _is_open(t: TaskOut) -> bool:
    if t.completed_at:
        return False
    if t.dismissed_at:
        return False
    if t.snooze_until:
        try:
            d = date.fromisoformat(t.snooze_until)
            if d >= date.today():
                return False  # snoozed into the future = not open right now
        except Exception:
            pass
    return True


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("", response_model=TasksResponse)
async def list_tasks(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
    include_closed: bool = False,
) -> TasksResponse:
    """All tasks visible to the current tenant — derived + manual."""
    overlays_by_key, manual_rows = await _load_overlays(db, tenant_id)
    derived = await _derive_recon_tasks(db, tenant_id, overlays_by_key)

    # Manual tasks → TaskOut
    manual_tasks: list[TaskOut] = []
    for m in manual_rows:
        manual_tasks.append(_serialize_overlay_action(
            m,
            subject     = m.subject or "(no subject)",
            description = m.description,
            severity    = (m.priority == "critical" and "critical")
                           or (m.priority == "high" and "warn")
                           or "info",
            deep_link   = None,
        ))

    tasks = derived + manual_tasks
    if not include_closed:
        tasks = [t for t in tasks if _is_open(t)]

    # Sort: severity (critical → warn → info), then newest period first.
    sev_order = {"critical": 0, "warn": 1, "info": 2}
    tasks.sort(key=lambda t: (
        sev_order.get(t.severity, 3),
        t.period_end or "0000-00-00",
    ))
    return TasksResponse(tasks=tasks)


@router.get("/count")
async def count_open_tasks(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Just the count — for the sidebar badge. Lighter than the full list."""
    overlays_by_key, manual_rows = await _load_overlays(db, tenant_id)
    derived = await _derive_recon_tasks(db, tenant_id, overlays_by_key)

    manual_open = [m for m in manual_rows
                   if not m.completed_at and not m.dismissed_at
                   and (not m.snooze_until or m.snooze_until >= date.today())]
    derived_open = [t for t in derived if _is_open(t)]
    return {
        "open":      len(derived_open) + len(manual_open),
        "critical":  sum(1 for t in derived_open if t.severity == "critical"),
        "manual":    len(manual_open),
        "derived":   len(derived_open),
    }


@router.post("/action")
async def upsert_action(
    body: TaskActionUpsert,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    """Create/update an overlay on a derived task."""
    if body.source_type == "manual":
        raise HTTPException(400, "Use /tasks/manual for manual tasks.")
    if not body.source_id or not body.period_end:
        raise HTTPException(400, "source_id and period_end are required for derived overlays.")
    try:
        pe = date.fromisoformat(body.period_end)
    except ValueError:
        raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    snooze: date | None = None
    if body.snooze_until:
        try:
            snooze = date.fromisoformat(body.snooze_until)
        except ValueError:
            raise HTTPException(400, "snooze_until must be YYYY-MM-DD.")

    assignee: uuid.UUID | None = None
    if body.assignee_id:
        try:
            assignee = uuid.UUID(body.assignee_id)
        except ValueError:
            raise HTTPException(400, "assignee_id must be a UUID.")

    # Look up existing overlay row (unique by source_type+source_id+period_end+tenant).
    existing = (await db.execute(
        select(TaskAction)
        .where(
            TaskAction.source_type == body.source_type,
            TaskAction.source_id == body.source_id,
            TaskAction.period_end == pe,
        )
    )).scalar_one_or_none()

    if existing is None:
        existing = TaskAction(
            source_type = body.source_type,
            source_id   = body.source_id,
            period_end  = pe,
            created_by  = user.id,
        )
        db.add(existing)

    # Apply patches — None means "leave alone" for assignee/snooze/notes;
    # to clear, send an explicit empty string for notes or use the
    # dedicated POST /complete endpoint to mark done.
    if body.assignee_id is not None:
        existing.assignee_id = assignee
    if body.snooze_until is not None:
        existing.snooze_until = snooze
    if body.notes is not None:
        existing.notes = body.notes or None
    if body.dismissed is True:
        existing.dismissed_at = datetime.now(UTC)
    elif body.dismissed is False:
        existing.dismissed_at = None

    await db.commit()
    await db.refresh(existing)

    # Reconstruct the derived subject for the response (so the client
    # gets back the same shape as the list endpoint).
    period_label = pe.strftime("%b %Y")
    subject = f"Reconcile account {body.source_id} for {period_label}"
    description = f"Status: pending. Open the reconciliations dashboard for {period_label}."
    return _serialize_overlay_action(existing, subject, description, "info",
                                     f"/app/reconciliations/period/{body.period_end}")


@router.post("/manual", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_manual_task(
    body: ManualTaskCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    """Create a freeform task that isn't tied to any derived source."""
    pe: date | None = None
    if body.period_end:
        try:
            pe = date.fromisoformat(body.period_end)
        except ValueError:
            raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    assignee: uuid.UUID | None = None
    if body.assignee_id:
        try:
            assignee = uuid.UUID(body.assignee_id)
        except ValueError:
            raise HTTPException(400, "assignee_id must be a UUID.")

    row = TaskAction(
        source_type = "manual",
        source_id   = None,
        period_end  = pe,
        subject     = body.subject,
        description = body.description,
        priority    = body.priority or "normal",
        assignee_id = assignee,
        created_by  = user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    return _serialize_overlay_action(
        row,
        subject     = row.subject or "(no subject)",
        description = row.description,
        severity    = (row.priority == "critical" and "critical")
                       or (row.priority == "high" and "warn")
                       or "info",
        deep_link   = None,
    )


@router.patch("/manual/{task_id}", response_model=TaskOut)
async def update_manual_task(
    task_id: uuid.UUID,
    body: ManualTaskUpdate,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    row = (await db.execute(
        select(TaskAction).where(TaskAction.id == task_id, TaskAction.source_type == "manual")
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Manual task not found.")
    if body.subject is not None:
        row.subject = body.subject
    if body.description is not None:
        row.description = body.description or None
    if body.priority is not None:
        row.priority = body.priority
    if body.assignee_id is not None:
        try:
            row.assignee_id = uuid.UUID(body.assignee_id) if body.assignee_id else None
        except ValueError:
            raise HTTPException(400, "assignee_id must be a UUID.")
    if body.snooze_until is not None:
        try:
            row.snooze_until = date.fromisoformat(body.snooze_until) if body.snooze_until else None
        except ValueError:
            raise HTTPException(400, "snooze_until must be YYYY-MM-DD.")
    if body.notes is not None:
        row.notes = body.notes or None
    await db.commit()
    await db.refresh(row)
    return _serialize_overlay_action(
        row,
        subject     = row.subject or "(no subject)",
        description = row.description,
        severity    = (row.priority == "critical" and "critical")
                       or (row.priority == "high" and "warn")
                       or "info",
        deep_link   = None,
    )


@router.post("/{action_id}/complete")
async def complete_task(
    action_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mark a task done — works for both manual and overlay rows."""
    row = (await db.execute(
        select(TaskAction).where(TaskAction.id == action_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task not found.")
    row.completed_at = datetime.now(UTC)
    await db.commit()
    return {"id": str(row.id), "completed_at": row.completed_at.isoformat()}
