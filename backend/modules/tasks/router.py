"""
Tasks API.

  GET   /tasks                  list tasks (recon + flux + manual)
  GET   /tasks/count            unread count for the sidebar badge
  POST  /tasks/action           upsert an overlay action on a derived task
                                (assign / snooze / notes / dismiss)
  POST  /tasks/manual           create a manual task
  PATCH /tasks/manual/{id}      update a manual task
  POST  /tasks/{id}/complete    mark a task done (manual or overlay)

Task derivation:

  One task per balance-sheet account currently visible in QuickBooks
  (pulled via the same /query call the recons dashboard uses), per
  unclosed period. Status mirrors AccountReviewStatus when a row
  exists; otherwise pending. Each row carries preparer + reviewer +
  timestamps + due date so the Tasks UI can render a true workflow
  table.

  PLUS one task per Flux trial-balance analysis that's either ready
  for review or complete-but-unapproved. Variance work tasks come
  with their own deep-link into the flux module.

  Plus any manual tasks the user created.

Why pull QBO live for the recon side?
  Account names are the headline info on the task ("Reconcile
  Accounts Receivable") and we don't persist them locally — the
  source of truth lives in QBO. One /query per /tasks request
  keeps the data fresh without a sync table. If QBO is unreachable
  we degrade to account-id-as-title.
"""
import logging
import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.account_review_status import AccountReviewStatus
from models.closed_period import ClosedPeriod
from models.qbo_connection import QboConnection
from models.task_action import TaskAction
from models.tenant import Tenant
from models.trial_balance import TrialBalance

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────

class TaskOut(BaseModel):
    """A single row in the user-facing task list."""
    key:           str
    source_type:   str                   # 'recon_account' | 'flux' | 'manual'
    source_id:     str | None
    period_end:    str | None
    subject:       str                   # human-readable title
    description:   str | None
    severity:      str                   # 'info' | 'warn' | 'critical'
    deep_link:     str | None

    # Workflow status — driven by the underlying source row.
    status:        str                   # 'pending' | 'reviewed' (=prepared)
                                          # | 'approved' | 'flagged' | 'manual'
    # Actor stamps (UUIDs as strings — frontend resolves names)
    prepared_by:   str | None
    prepared_at:   str | None
    approved_by:   str | None            # also serves as "reviewer"
    approved_at:   str | None            # = "completed_at" for derived recon
    due_date:      str | None

    # Overlay fields (null on fresh derived tasks the user hasn't touched)
    action_id:     str | None
    assignee_id:   str | None
    snooze_until:  str | None
    notes:         str | None
    completed_at:  str | None            # manual completion stamp
    dismissed_at:  str | None
    # Manual-only
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
    dismissed:     bool | None = None


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

def _recon_key(qbo_id: str, period_end: date) -> str:
    return f"recon_account:{qbo_id}:{period_end.isoformat()}"


def _flux_key(tb_id: uuid.UUID) -> str:
    return f"flux:{tb_id}"


def _manual_key(task_id: uuid.UUID) -> str:
    return f"manual:{task_id}"


def _due_date_for(period_end: date) -> date:
    """
    Standard month-end close SLA: 15 calendar days after period_end.
    Most small-firm month-end close happens within ~10 business days
    (~15 calendar days). Configurable later via tenant settings.
    """
    return period_end + timedelta(days=15)


def _severity_for_recon(review_status: str, due_date: date) -> str:
    """
    Critical: flagged. Warn: open AND overdue. Info: open and on time.
    Approved tasks are completed and don't surface in the open view,
    so they get info-level when displayed in completed/all tabs.
    """
    if review_status == "flagged":
        return "critical"
    if review_status in ("pending", "reviewed") and date.today() > due_date:
        return "warn"
    return "info"


def _is_open(t: TaskOut) -> bool:
    if t.completed_at:
        return False
    if t.dismissed_at:
        return False
    if t.snooze_until:
        try:
            d = date.fromisoformat(t.snooze_until)
            if d >= date.today():
                return False
        except Exception:
            pass
    # Approved recons + flux are "done" from a workflow perspective even
    # without an overlay completed_at — they don't belong in the open list.
    if t.status == "approved":
        return False
    return True


async def _list_qbo_accounts(
    db: AsyncSession, tenant_id: uuid.UUID,
) -> dict[str, dict]:
    """
    {qbo_id: {Name, AccountType, AcctNum}} for every active
    balance-sheet account in QBO. Single /query call; empty dict when
    QBO isn't connected.
    """
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        return {}

    try:
        from modules.recons.overview import _list_balance_sheet_accounts
        accts = await _list_balance_sheet_accounts(conn, db)
    except Exception:
        logger.exception("Could not list QBO accounts for tasks")
        return {}

    return {str(a.get("Id")): a for a in accts if a.get("Id")}


async def _enumerate_open_periods(
    db: AsyncSession, tenant_id: uuid.UUID,
) -> list[date]:
    """Month-end dates from books_start through current month, minus
    any periods already closed. Defines which months get one
    recon-task-per-account."""
    from calendar import monthrange

    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t is None or t.books_start_date is None:
        return []

    today = date.today()
    cur = date(t.books_start_date.year, t.books_start_date.month, 1)
    out: list[date] = []
    while cur <= today.replace(day=1):
        last = monthrange(cur.year, cur.month)[1]
        out.append(date(cur.year, cur.month, last))
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)
    return out


# ── Derivation ───────────────────────────────────────────────────────────────

async def _derive_recon_tasks(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    overlays_by_key: dict[str, TaskAction],
) -> list[TaskOut]:
    """
    One task per (period, account). Pulls all balance-sheet accounts
    from QBO so accounts that have never been touched still show up
    as pending tasks. Status / actors / timestamps are joined from
    AccountReviewStatus where rows exist; otherwise default to pending.
    """
    periods = await _enumerate_open_periods(db, tenant_id)
    if not periods:
        return []

    accounts = await _list_qbo_accounts(db, tenant_id)

    # Closed periods are read-only — we still surface them as tasks
    # (with status=approved) so the Completed tab shows the historical
    # work, but they're never "open".
    closed_rows = list((await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end.in_(periods))
    )).scalars().all())
    closed_set = {c.period_end for c in closed_rows}

    # Bulk-load status rows for these periods.
    status_rows = list((await db.execute(
        select(AccountReviewStatus)
        .where(AccountReviewStatus.period_end.in_(periods))
    )).scalars().all())
    by_key: dict[tuple[date, str], AccountReviewStatus] = {
        (r.period_end, r.qbo_account_id): r for r in status_rows
    }

    out: list[TaskOut] = []
    for pe in periods:
        period_label = pe.strftime("%b %Y")
        due = _due_date_for(pe)
        is_closed = pe in closed_set

        # Iterate every QBO account (so untouched accounts surface as
        # pending tasks). If QBO isn't connected `accounts` is empty —
        # fall back to whatever review rows we DO have, so the user
        # still sees their historical work.
        ids_to_render: set[str] = set(accounts.keys())
        for (period, qid) in by_key.keys():
            if period == pe:
                ids_to_render.add(qid)

        for qid in ids_to_render:
            row = by_key.get((pe, qid))
            acct = accounts.get(qid, {})
            acct_name = acct.get("Name") or row and "(no QBO data)" or qid
            acct_num  = acct.get("AcctNum") or ""

            # Status for closed periods: treat as approved even if the
            # row's status didn't make it to approved (shouldn't happen
            # — the close gate blocks it — but defend anyway).
            if is_closed:
                effective_status = "approved"
            else:
                effective_status = row.status if row else "pending"

            subject_acct = f"{acct_num} {acct_name}".strip() if acct_num else acct_name
            subject = f"Reconciliation — {subject_acct} · {period_label}"
            description = None

            severity = _severity_for_recon(effective_status, due)
            deep_link = f"/app/reconciliations/period/{pe.isoformat()}"

            key = _recon_key(qid, pe)
            overlay = overlays_by_key.get(key)

            out.append(TaskOut(
                key=key,
                source_type="recon_account",
                source_id=qid,
                period_end=pe.isoformat(),
                subject=subject,
                description=description,
                severity=severity,
                deep_link=deep_link,
                status=effective_status,
                prepared_by = str(row.prepared_by) if row and row.prepared_by else None,
                prepared_at = row.prepared_at.isoformat() if row and row.prepared_at else None,
                approved_by = str(row.approved_by) if row and row.approved_by else None,
                approved_at = row.approved_at.isoformat() if row and row.approved_at else None,
                due_date    = due.isoformat(),
                action_id   = str(overlay.id) if overlay else None,
                assignee_id = str(overlay.assignee_id) if overlay and overlay.assignee_id else None,
                snooze_until= overlay.snooze_until.isoformat() if overlay and overlay.snooze_until else None,
                notes       = (overlay.notes if overlay else None) or (row.notes if row else None),
                completed_at= overlay.completed_at.isoformat() if overlay and overlay.completed_at else None,
                dismissed_at= overlay.dismissed_at.isoformat() if overlay and overlay.dismissed_at else None,
                priority    = None,
                created_by  = None,
                created_at  = row.created_at.isoformat() if row and row.created_at else None,
            ))
    return out


async def _derive_flux_tasks(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    overlays_by_key: dict[str, TaskAction],
) -> list[TaskOut]:
    """
    One task per flux trial-balance analysis. Status mapping:
      pending / processing / parsed / ready_for_review / generating
        → still working, surfaces as open ("Review flux ...")
      complete (approved_at is null)
        → "Approve flux ..."
      complete (approved_at set)
        → status=approved, lives in Completed
      error → critical, "Investigate flux error..."
    """
    tbs = list((await db.execute(select(TrialBalance))).scalars().all())

    out: list[TaskOut] = []
    for tb in tbs:
        key = _flux_key(tb.id)
        overlay = overlays_by_key.get(key)

        # Pick a label for the period this analysis covers — use the
        # year-month of period_current so it lines up with recon months.
        try:
            tb_pe = tb.period_current  # date
            period_iso = tb_pe.isoformat()
            period_label = tb_pe.strftime("%b %Y")
        except Exception:
            period_iso = None
            period_label = "(unknown period)"

        action_verb = "Review"
        sev = "info"
        if tb.status == "complete":
            if tb.approved_at:
                effective_status = "approved"
                action_verb = "Approve"
            else:
                effective_status = "reviewed"  # ready for the reviewer
                action_verb = "Approve"
        elif tb.status in ("parsed", "ready_for_review"):
            effective_status = "reviewed"
            action_verb = "Review"
        elif tb.status == "error":
            effective_status = "flagged"
            action_verb = "Investigate"
            sev = "critical"
        elif tb.status in ("pending", "processing", "generating"):
            # In-progress; surface as pending so the user can see it,
            # but no due-date pressure yet.
            effective_status = "pending"
            action_verb = "Continue"
        else:
            effective_status = "pending"

        subject = f"Flux analysis — {action_verb} {tb.name or 'analysis'} · {period_label}"

        out.append(TaskOut(
            key=key,
            source_type="flux",
            source_id=str(tb.id),
            period_end=period_iso,
            subject=subject,
            description=f"Status: {tb.status}.",
            severity=sev,
            deep_link=f"/app/flux/{tb.id}",
            status=effective_status,
            prepared_by=None,    # flux module doesn't track prep actor separately yet
            prepared_at=None,
            approved_by=str(tb.approved_by) if tb.approved_by else None,
            approved_at=tb.approved_at.isoformat() if tb.approved_at else None,
            due_date=_due_date_for(tb.period_current).isoformat() if tb.period_current else None,
            action_id   = str(overlay.id) if overlay else None,
            assignee_id = str(overlay.assignee_id) if overlay and overlay.assignee_id else None,
            snooze_until= overlay.snooze_until.isoformat() if overlay and overlay.snooze_until else None,
            notes       = overlay.notes if overlay else None,
            completed_at= overlay.completed_at.isoformat() if overlay and overlay.completed_at else None,
            dismissed_at= overlay.dismissed_at.isoformat() if overlay and overlay.dismissed_at else None,
            priority    = None,
            created_by  = None,
            created_at  = tb.created_at.isoformat() if tb.created_at else None,
        ))
    return out


async def _load_overlays(db: AsyncSession, tenant_id: uuid.UUID) -> tuple[dict[str, TaskAction], list[TaskAction]]:
    all_rows = list((await db.execute(select(TaskAction))).scalars().all())
    overlays_by_key: dict[str, TaskAction] = {}
    manual_rows: list[TaskAction] = []
    for r in all_rows:
        if r.source_type == "manual":
            manual_rows.append(r)
        elif r.source_type == "recon_account" and r.source_id and r.period_end:
            overlays_by_key[_recon_key(r.source_id, r.period_end)] = r
        elif r.source_type == "flux" and r.source_id:
            try:
                overlays_by_key[_flux_key(uuid.UUID(r.source_id))] = r
            except ValueError:
                pass
    return overlays_by_key, manual_rows


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("", response_model=TasksResponse)
async def list_tasks(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
    include_closed: bool = False,
) -> TasksResponse:
    """All tasks visible to the current tenant — derived + manual."""
    overlays_by_key, manual_rows = await _load_overlays(db, tenant_id)
    recon  = await _derive_recon_tasks(db, tenant_id, overlays_by_key)
    flux   = await _derive_flux_tasks(db, tenant_id, overlays_by_key)

    manual_tasks: list[TaskOut] = []
    for m in manual_rows:
        manual_tasks.append(TaskOut(
            key          = _manual_key(m.id),
            source_type  = "manual",
            source_id    = None,
            period_end   = m.period_end.isoformat() if m.period_end else None,
            subject      = m.subject or "(no subject)",
            description  = m.description,
            severity     = (
                "critical" if m.priority == "critical"
                else "warn" if m.priority == "high"
                else "info"
            ),
            deep_link    = None,
            status       = "manual",
            prepared_by  = None,
            prepared_at  = None,
            approved_by  = None,
            approved_at  = None,
            due_date     = m.period_end.isoformat() if m.period_end else None,
            action_id    = str(m.id),
            assignee_id  = str(m.assignee_id) if m.assignee_id else None,
            snooze_until = m.snooze_until.isoformat() if m.snooze_until else None,
            notes        = m.notes,
            completed_at = m.completed_at.isoformat() if m.completed_at else None,
            dismissed_at = m.dismissed_at.isoformat() if m.dismissed_at else None,
            priority     = m.priority,
            created_by   = str(m.created_by),
            created_at   = m.created_at.isoformat() if m.created_at else None,
        ))

    tasks = recon + flux + manual_tasks
    if not include_closed:
        tasks = [t for t in tasks if _is_open(t)]

    # Sort: severity first, then earliest due date.
    sev_order = {"critical": 0, "warn": 1, "info": 2}
    tasks.sort(key=lambda t: (
        sev_order.get(t.severity, 3),
        t.due_date or "9999-12-31",
        t.period_end or "9999-12-31",
        t.subject,
    ))
    return TasksResponse(tasks=tasks)


@router.get("/count")
async def count_open_tasks(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Sidebar badge — lightweight counts only."""
    overlays_by_key, manual_rows = await _load_overlays(db, tenant_id)
    recon = await _derive_recon_tasks(db, tenant_id, overlays_by_key)
    flux  = await _derive_flux_tasks(db, tenant_id, overlays_by_key)

    manual_open = [m for m in manual_rows
                   if not m.completed_at and not m.dismissed_at
                   and (not m.snooze_until or m.snooze_until >= date.today())]
    open_recon = [t for t in recon if _is_open(t)]
    open_flux  = [t for t in flux  if _is_open(t)]
    all_open   = open_recon + open_flux
    return {
        "open":      len(all_open) + len(manual_open),
        "critical":  sum(1 for t in all_open if t.severity == "critical"),
        "manual":    len(manual_open),
        "derived":   len(all_open),
    }


@router.post("/action")
async def upsert_action(
    body: TaskActionUpsert,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    if body.source_type == "manual":
        raise HTTPException(400, "Use /tasks/manual for manual tasks.")
    if body.source_type not in ("recon_account", "flux"):
        raise HTTPException(400, "Unknown source_type.")
    if not body.source_id:
        raise HTTPException(400, "source_id is required.")

    pe: date | None = None
    if body.source_type == "recon_account":
        if not body.period_end:
            raise HTTPException(400, "period_end is required for recon_account overlays.")
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

    existing = (await db.execute(
        select(TaskAction).where(
            TaskAction.source_type == body.source_type,
            TaskAction.source_id == body.source_id,
            TaskAction.period_end == pe,
        )
    )).scalar_one_or_none()

    if existing is None:
        existing = TaskAction(
            source_type=body.source_type,
            source_id  =body.source_id,
            period_end =pe,
            created_by =user.id,
        )
        db.add(existing)

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
    return {"ok": True, "action_id": str(existing.id)}


@router.post("/manual", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_manual_task(
    body: ManualTaskCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
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
        source_type="manual",
        source_id=None,
        period_end=pe,
        subject=body.subject,
        description=body.description,
        priority=body.priority or "normal",
        assignee_id=assignee,
        created_by=user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    return TaskOut(
        key=_manual_key(row.id),
        source_type="manual",
        source_id=None,
        period_end=row.period_end.isoformat() if row.period_end else None,
        subject=row.subject or "",
        description=row.description,
        severity=(
            "critical" if row.priority == "critical"
            else "warn" if row.priority == "high"
            else "info"
        ),
        deep_link=None,
        status="manual",
        prepared_by=None, prepared_at=None,
        approved_by=None, approved_at=None,
        due_date=row.period_end.isoformat() if row.period_end else None,
        action_id=str(row.id),
        assignee_id=str(row.assignee_id) if row.assignee_id else None,
        snooze_until=row.snooze_until.isoformat() if row.snooze_until else None,
        notes=row.notes,
        completed_at=None, dismissed_at=None,
        priority=row.priority,
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else None,
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
    return TaskOut(
        key=_manual_key(row.id),
        source_type="manual",
        source_id=None,
        period_end=row.period_end.isoformat() if row.period_end else None,
        subject=row.subject or "",
        description=row.description,
        severity=(
            "critical" if row.priority == "critical"
            else "warn" if row.priority == "high"
            else "info"
        ),
        deep_link=None,
        status="manual",
        prepared_by=None, prepared_at=None,
        approved_by=None, approved_at=None,
        due_date=row.period_end.isoformat() if row.period_end else None,
        action_id=str(row.id),
        assignee_id=str(row.assignee_id) if row.assignee_id else None,
        snooze_until=row.snooze_until.isoformat() if row.snooze_until else None,
        notes=row.notes,
        completed_at=row.completed_at.isoformat() if row.completed_at else None,
        dismissed_at=row.dismissed_at.isoformat() if row.dismissed_at else None,
        priority=row.priority,
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else None,
    )


@router.post("/{action_id}/complete")
async def complete_task(
    action_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    row = (await db.execute(
        select(TaskAction).where(TaskAction.id == action_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task not found.")
    row.completed_at = datetime.now(UTC)
    await db.commit()
    return {"id": str(row.id), "completed_at": row.completed_at.isoformat()}
