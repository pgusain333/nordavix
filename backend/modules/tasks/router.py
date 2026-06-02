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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.account_review_status import AccountReviewStatus
from models.closed_period import ClosedPeriod
from models.qbo_connection import QboConnection
from models.schedule import (
    ScheduleAccrual,
    ScheduleFixedAsset,
    ScheduleLease,
    ScheduleLoan,
    SchedulePrepaid,
    ScheduleSnapshot,
)
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

    # Effective due date — the admin-set override if present, else
    # the auto-computed default (period_end + 15 days).
    due_date:           str | None
    due_date_overridden:bool             # True when admin set a custom date

    # Admin-set assignments
    assigned_preparer_id: str | None
    assigned_reviewer_id: str | None

    # Overlay fields (null on fresh derived tasks the user hasn't touched)
    action_id:     str | None
    assignee_id:   str | None            # legacy single-assignee; deprecated
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
    # Admin-only fields (server checks the role before honoring them)
    assigned_preparer_id: str | None = None
    assigned_reviewer_id: str | None = None
    due_date:             str | None = None
    # Anyone-can-edit fields
    notes:         str | None = None
    dismissed:     bool | None = None


class TaskBulkAction(BaseModel):
    """Apply one action to many tasks at once."""
    # List of (source_type, source_id, period_end) triples — manual tasks
    # use source_type='manual' and source_id=<action_id> (period_end None).
    targets: list["TaskTarget"]
    # Action types are mutually exclusive — pass exactly one field.
    assigned_preparer_id: str | None = None
    assigned_reviewer_id: str | None = None
    due_date:             str | None = None
    dismissed:            bool | None = None
    completed:            bool | None = None


class TaskTarget(BaseModel):
    source_type: str
    source_id:   str | None = None
    period_end:  str | None = None


class ManualTaskCreate(BaseModel):
    subject:      str = Field(..., min_length=1, max_length=200)
    description:  str | None = None
    priority:     str | None = "normal"
    period_end:   str | None = None
    # Admin-set (silently ignored when caller isn't admin).
    assigned_preparer_id: str | None = None
    assigned_reviewer_id: str | None = None
    due_date:             str | None = None


class ManualTaskUpdate(BaseModel):
    subject:      str | None = None
    description:  str | None = None
    priority:     str | None = None
    notes:        str | None = None
    # Admin-set
    assigned_preparer_id: str | None = None
    assigned_reviewer_id: str | None = None
    due_date:             str | None = None


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
    # Snooze was removed from TaskOut in the v3 schema (workflow noise —
    # users just toggled it for everything). The TaskAction DB model still
    # has the column for back-compat, but TaskOut intentionally drops it,
    # so this function — which takes the API-shape — must NOT read it.
    # Reading it here was raising AttributeError on /tasks/count and
    # PendingRollbackError'ing the request session.
    if t.completed_at:
        return False
    if t.dismissed_at:
        return False
    # Approved recons + flux are "done" from a workflow perspective even
    # without an overlay completed_at — they don't belong in the open list.
    return t.status != "approved"


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
        for (period, qid) in by_key:
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

            key = _recon_key(qid, pe)
            overlay = overlays_by_key.get(key)
            # Effective due date: admin override on the overlay wins,
            # otherwise the auto-computed default.
            effective_due = overlay.due_date if (overlay and overlay.due_date) else due
            severity = _severity_for_recon(effective_status, effective_due)
            deep_link = f"/app/reconciliations/period/{pe.isoformat()}"

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
                due_date    = effective_due.isoformat(),
                due_date_overridden = bool(overlay and overlay.due_date),
                assigned_preparer_id = str(overlay.assigned_preparer_id) if overlay and overlay.assigned_preparer_id else None,
                assigned_reviewer_id = str(overlay.assigned_reviewer_id) if overlay and overlay.assigned_reviewer_id else None,
                action_id   = str(overlay.id) if overlay else None,
                assignee_id = str(overlay.assignee_id) if overlay and overlay.assignee_id else None,
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

        default_due = _due_date_for(tb.period_current) if tb.period_current else None
        effective_due = (overlay.due_date if (overlay and overlay.due_date) else default_due)

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
            due_date=effective_due.isoformat() if effective_due else None,
            due_date_overridden = bool(overlay and overlay.due_date),
            assigned_preparer_id = str(overlay.assigned_preparer_id) if overlay and overlay.assigned_preparer_id else None,
            assigned_reviewer_id = str(overlay.assigned_reviewer_id) if overlay and overlay.assigned_reviewer_id else None,
            action_id   = str(overlay.id) if overlay else None,
            assignee_id = str(overlay.assignee_id) if overlay and overlay.assignee_id else None,
            notes       = overlay.notes if overlay else None,
            completed_at= overlay.completed_at.isoformat() if overlay and overlay.completed_at else None,
            dismissed_at= overlay.dismissed_at.isoformat() if overlay and overlay.dismissed_at else None,
            priority    = None,
            created_by  = None,
            created_at  = tb.created_at.isoformat() if tb.created_at else None,
        ))
    return out


# ── Schedule task derivation ─────────────────────────────────────────
#
# Five schedule kinds (Prepaid / Accrual / Fixed Asset / Lease / Loan)
# each get ONE task per open period — the "commit snapshot" step the
# user takes when their schedule items are reviewed and ready for the
# month-end close. A kind is "active" for a period when at least one
# active item of that kind exists in the tenant's schedule. Empty
# kinds are skipped entirely (no point nagging the user about prepaids
# they don't have).
#
# Completion: task moves to status="approved" when at least one
# ScheduleSnapshot row exists for (tenant, kind, period_end) with
# status="committed". Per-account commit completeness is a refinement
# we can layer on top later if needed — for v1, one commit = done.

_SCHEDULE_KINDS: dict[str, tuple[type, str, str]] = {
    "prepaid":     (SchedulePrepaid,    "Prepaids",      "/app/schedules/prepaids"),
    "accrual":     (ScheduleAccrual,    "Accruals",      "/app/schedules/accruals"),
    "fixed_asset": (ScheduleFixedAsset, "Fixed Assets",  "/app/schedules/fixed-assets"),
    "lease":       (ScheduleLease,      "Leases",        "/app/schedules/leases"),
    "loan":        (ScheduleLoan,       "Loans",         "/app/schedules/loans"),
}


def _schedule_key(kind: str, period_end: date) -> str:
    return f"schedule:{kind}:{period_end.isoformat()}"


async def _derive_schedule_tasks(
    db: AsyncSession,
    tenant_id: uuid.UUID,
) -> list[TaskOut]:
    """One task per (active_kind, period_end). See module-level docstring
    for the activation + completion rules."""
    # Step 1: which kinds have at least one active item? Skip the rest.
    active_kinds: set[str] = set()
    for kind, (Model, _human, _route) in _SCHEDULE_KINDS.items():
        q = select(Model.id).where(Model.is_active == True).limit(1)  # noqa: E712
        if (await db.execute(q)).scalar_one_or_none() is not None:
            active_kinds.add(kind)
    if not active_kinds:
        return []

    # Step 2: which periods to enumerate? Drive off the same periods
    # the recon tracker uses (AccountReviewStatus). This guarantees
    # schedule tasks align with the months the user is actively
    # closing — no schedule tasks for periods the user hasn't started.
    periods_q = select(AccountReviewStatus.period_end).distinct()
    periods = sorted({pe for pe in (await db.execute(periods_q)).scalars().all() if pe})
    if not periods:
        return []

    # Step 3: load committed snapshots, index by (kind, period_end).
    snap_rows = list((await db.execute(
        select(ScheduleSnapshot).where(ScheduleSnapshot.status == "committed")
    )).scalars().all())
    by_kind_period: dict[tuple[str, date], ScheduleSnapshot] = {}
    for s in snap_rows:
        key = (s.schedule_type, s.period_end)
        # First committed snapshot wins for the actor stamps — it's the
        # one that "completed" the task. Later commits (e.g. additional
        # accounts) don't shift the completed-at timestamp.
        if key not in by_kind_period:
            by_kind_period[key] = s

    out: list[TaskOut] = []
    for period_end in periods:
        for kind in sorted(active_kinds):
            human = _SCHEDULE_KINDS[kind][1]
            route = _SCHEDULE_KINDS[kind][2]
            snap = by_kind_period.get((kind, period_end))
            committed = snap is not None
            period_label = period_end.strftime("%b %Y")
            subject = (
                f"{human} schedule — Commit snapshot · {period_label}"
            )
            default_due = _due_date_for(period_end)

            out.append(TaskOut(
                key=_schedule_key(kind, period_end),
                source_type="schedule",
                source_id=kind,
                period_end=period_end.isoformat(),
                subject=subject,
                description=(
                    "Snapshot committed — schedule entries are locked for this period."
                    if committed
                    else "Open the schedule and click 'Commit snapshot' once the items are reviewed for this period."
                ),
                severity="info",
                deep_link=route,
                status="approved" if committed else "pending",
                prepared_by=None,
                prepared_at=None,
                approved_by=str(snap.committed_by) if snap and snap.committed_by else None,
                approved_at=snap.committed_at.isoformat() if snap and snap.committed_at else None,
                due_date=default_due.isoformat() if default_due else None,
                due_date_overridden=False,
                assigned_preparer_id=None,
                assigned_reviewer_id=None,
                action_id=None,
                assignee_id=None,
                notes=None,
                completed_at=None,
                dismissed_at=None,
                priority=None,
                created_by=None,
                created_at=None,
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
    recon    = await _derive_recon_tasks(db, tenant_id, overlays_by_key)
    flux     = await _derive_flux_tasks(db, tenant_id, overlays_by_key)
    schedule = await _derive_schedule_tasks(db, tenant_id)

    manual_tasks: list[TaskOut] = []
    for m in manual_rows:
        # Manual tasks: due_date column wins, then period_end as a
        # convenient fallback so it surfaces in the period filter.
        manual_due = m.due_date or m.period_end
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
            due_date     = manual_due.isoformat() if manual_due else None,
            due_date_overridden = bool(m.due_date),
            assigned_preparer_id = str(m.assigned_preparer_id) if m.assigned_preparer_id else None,
            assigned_reviewer_id = str(m.assigned_reviewer_id) if m.assigned_reviewer_id else None,
            action_id    = str(m.id),
            assignee_id  = str(m.assignee_id) if m.assignee_id else None,
            notes        = m.notes,
            completed_at = m.completed_at.isoformat() if m.completed_at else None,
            dismissed_at = m.dismissed_at.isoformat() if m.dismissed_at else None,
            priority     = m.priority,
            created_by   = str(m.created_by),
            created_at   = m.created_at.isoformat() if m.created_at else None,
        ))

    tasks = recon + flux + schedule + manual_tasks
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
    recon    = await _derive_recon_tasks(db, tenant_id, overlays_by_key)
    flux     = await _derive_flux_tasks(db, tenant_id, overlays_by_key)
    schedule = await _derive_schedule_tasks(db, tenant_id)

    manual_open = [m for m in manual_rows
                   if not m.completed_at and not m.dismissed_at
                   and (not m.snooze_until or m.snooze_until >= date.today())]
    open_recon    = [t for t in recon    if _is_open(t)]
    open_flux     = [t for t in flux     if _is_open(t)]
    open_schedule = [t for t in schedule if _is_open(t)]
    all_open   = open_recon + open_flux + open_schedule
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
    background_tasks: BackgroundTasks,
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

    # Admin-only fields — silently ignored if a non-admin tries to set
    # them (rather than 403'd, which would be confusing because a row
    # might mix admin + non-admin fields). Returns the actually-applied
    # set so the frontend can render a hint when needed.
    is_admin = user.role == "admin"
    apply_admin_fields = is_admin and any(
        v is not None for v in (
            body.assigned_preparer_id, body.assigned_reviewer_id, body.due_date,
        )
    )
    if not is_admin and any(
        v is not None for v in (
            body.assigned_preparer_id, body.assigned_reviewer_id, body.due_date,
        )
    ):
        raise HTTPException(
            403,
            "Only admins can assign preparer/reviewer or set custom due dates.",
        )

    assigned_preparer: uuid.UUID | None = None
    assigned_reviewer: uuid.UUID | None = None
    due_override:    date  | None = None
    if apply_admin_fields:
        if body.assigned_preparer_id:
            try:
                assigned_preparer = uuid.UUID(body.assigned_preparer_id)
            except ValueError:
                raise HTTPException(400, "assigned_preparer_id must be a UUID.")
        if body.assigned_reviewer_id:
            try:
                assigned_reviewer = uuid.UUID(body.assigned_reviewer_id)
            except ValueError:
                raise HTTPException(400, "assigned_reviewer_id must be a UUID.")
        if body.due_date:
            try:
                due_override = date.fromisoformat(body.due_date)
            except ValueError:
                raise HTTPException(400, "due_date must be YYYY-MM-DD.")

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

    # Admin assignments — explicit empty string clears the field.
    if apply_admin_fields and body.assigned_preparer_id is not None:
        existing.assigned_preparer_id = assigned_preparer
    if apply_admin_fields and body.assigned_reviewer_id is not None:
        existing.assigned_reviewer_id = assigned_reviewer
    if apply_admin_fields and body.due_date is not None:
        existing.due_date = due_override

    if body.notes is not None:
        existing.notes = body.notes or None
    if body.dismissed is True:
        existing.dismissed_at = datetime.now(UTC)
    elif body.dismissed is False:
        existing.dismissed_at = None

    await db.commit()

    # Newly assigned preparer / reviewer → tell them work is waiting.
    # Best-effort; only fires when an admin actually set an assignee (and not
    # to themselves). Never block the assignment on a notification failure.
    assignees: list[uuid.UUID] = []
    if apply_admin_fields:
        if assigned_preparer and assigned_preparer != user.id:
            assignees.append(assigned_preparer)
        if assigned_reviewer and assigned_reviewer not in (user.id, assigned_preparer):
            assignees.append(assigned_reviewer)
    if assignees:
        try:
            from modules.notifications.emails import notify_and_email_users
            label = "reconciliation" if body.source_type == "recon_account" else "flux"
            period_txt = f" for {body.period_end}" if body.period_end else ""
            await notify_and_email_users(
                db, background_tasks, tenant_id=tenant_id, recipient_ids=assignees,
                type="task_assigned",
                title="You've been assigned a close task",
                body=f"{user.email} assigned you a {label} task{period_txt}.",
                link="/app/tasks",
            )
        except Exception:
            logger.warning("task-assigned notifications failed", exc_info=True)

    return {"ok": True, "action_id": str(existing.id)}


@router.post("/bulk-action")
async def bulk_action(
    body: TaskBulkAction,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Apply ONE action to many tasks at once. Mutually-exclusive fields:
    pass exactly one of assigned_preparer_id, assigned_reviewer_id,
    due_date, dismissed, completed.

    Admin-only when the action is an assignment or due-date set.
    """
    is_admin = user.role == "admin"
    is_admin_action = any(
        v is not None for v in (
            body.assigned_preparer_id, body.assigned_reviewer_id, body.due_date,
        )
    )
    if is_admin_action and not is_admin:
        raise HTTPException(
            403,
            "Only admins can bulk-assign preparer/reviewer or set custom due dates.",
        )

    # Parse + validate the single action.
    assigned_preparer: uuid.UUID | None = None
    assigned_reviewer: uuid.UUID | None = None
    due_override:    date  | None = None
    if body.assigned_preparer_id:
        try: assigned_preparer = uuid.UUID(body.assigned_preparer_id)
        except ValueError: raise HTTPException(400, "assigned_preparer_id must be a UUID.")
    if body.assigned_reviewer_id:
        try: assigned_reviewer = uuid.UUID(body.assigned_reviewer_id)
        except ValueError: raise HTTPException(400, "assigned_reviewer_id must be a UUID.")
    if body.due_date:
        try: due_override = date.fromisoformat(body.due_date)
        except ValueError: raise HTTPException(400, "due_date must be YYYY-MM-DD.")

    now = datetime.now(UTC)
    applied = 0
    for t in body.targets:
        # Parse period
        pe: date | None = None
        if t.period_end:
            try: pe = date.fromisoformat(t.period_end)
            except ValueError: continue

        # Manual tasks: source_id is the action_id itself; find by id.
        if t.source_type == "manual":
            if not t.source_id:
                continue
            try:
                row = (await db.execute(
                    select(TaskAction).where(TaskAction.id == uuid.UUID(t.source_id),
                                              TaskAction.source_type == "manual")
                )).scalar_one_or_none()
            except ValueError:
                continue
            if row is None:
                continue
        else:
            if t.source_type not in ("recon_account", "flux"):
                continue
            row = (await db.execute(
                select(TaskAction).where(
                    TaskAction.source_type == t.source_type,
                    TaskAction.source_id   == t.source_id,
                    TaskAction.period_end  == pe,
                )
            )).scalar_one_or_none()
            if row is None:
                row = TaskAction(
                    source_type=t.source_type,
                    source_id  =t.source_id,
                    period_end =pe,
                    created_by =user.id,
                )
                db.add(row)

        # Apply the action.
        if body.assigned_preparer_id is not None:
            row.assigned_preparer_id = assigned_preparer
        if body.assigned_reviewer_id is not None:
            row.assigned_reviewer_id = assigned_reviewer
        if body.due_date is not None:
            row.due_date = due_override
        if body.dismissed is True:
            row.dismissed_at = now
        elif body.dismissed is False:
            row.dismissed_at = None
        if body.completed is True:
            row.completed_at = now
        elif body.completed is False:
            row.completed_at = None
        applied += 1

    await db.commit()
    return {"applied": applied}


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

    is_admin = user.role == "admin"
    assigned_preparer = _parse_uuid_if_admin(body.assigned_preparer_id, is_admin, "assigned_preparer_id")
    assigned_reviewer = _parse_uuid_if_admin(body.assigned_reviewer_id, is_admin, "assigned_reviewer_id")
    due_override = _parse_date_if_admin(body.due_date, is_admin, "due_date")

    row = TaskAction(
        source_type="manual",
        source_id=None,
        period_end=pe,
        subject=body.subject,
        description=body.description,
        priority=body.priority or "normal",
        created_by=user.id,
        assigned_preparer_id=assigned_preparer,
        assigned_reviewer_id=assigned_reviewer,
        due_date=due_override,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    return _serialize_manual_task(row)


def _parse_uuid_if_admin(val: str | None, is_admin: bool, field: str) -> uuid.UUID | None:
    if val is None:
        return None
    if not is_admin:
        raise HTTPException(403, f"Only admins can set {field}.")
    if val == "":
        return None
    try:
        return uuid.UUID(val)
    except ValueError:
        raise HTTPException(400, f"{field} must be a UUID.")


def _parse_date_if_admin(val: str | None, is_admin: bool, field: str) -> date | None:
    if val is None:
        return None
    if not is_admin:
        raise HTTPException(403, f"Only admins can set {field}.")
    if val == "":
        return None
    try:
        return date.fromisoformat(val)
    except ValueError:
        raise HTTPException(400, f"{field} must be YYYY-MM-DD.")


def _serialize_manual_task(row: TaskAction) -> TaskOut:
    """Single serializer used by create + update endpoints."""
    manual_due = row.due_date or row.period_end
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
        due_date=manual_due.isoformat() if manual_due else None,
        due_date_overridden=bool(row.due_date),
        assigned_preparer_id=str(row.assigned_preparer_id) if row.assigned_preparer_id else None,
        assigned_reviewer_id=str(row.assigned_reviewer_id) if row.assigned_reviewer_id else None,
        action_id=str(row.id),
        assignee_id=str(row.assignee_id) if row.assignee_id else None,
        notes=row.notes,
        completed_at=row.completed_at.isoformat() if row.completed_at else None,
        dismissed_at=row.dismissed_at.isoformat() if row.dismissed_at else None,
        priority=row.priority,
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else None,
    )


@router.patch("/manual/{task_id}", response_model=TaskOut)
async def update_manual_task(
    task_id: uuid.UUID,
    body: ManualTaskUpdate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TaskOut:
    row = (await db.execute(
        select(TaskAction).where(TaskAction.id == task_id, TaskAction.source_type == "manual")
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Manual task not found.")
    is_admin = user.role == "admin"
    if body.subject is not None:
        row.subject = body.subject
    if body.description is not None:
        row.description = body.description or None
    if body.priority is not None:
        row.priority = body.priority
    if body.notes is not None:
        row.notes = body.notes or None
    if body.assigned_preparer_id is not None:
        row.assigned_preparer_id = _parse_uuid_if_admin(body.assigned_preparer_id, is_admin, "assigned_preparer_id")
    if body.assigned_reviewer_id is not None:
        row.assigned_reviewer_id = _parse_uuid_if_admin(body.assigned_reviewer_id, is_admin, "assigned_reviewer_id")
    if body.due_date is not None:
        row.due_date = _parse_date_if_admin(body.due_date, is_admin, "due_date")
    await db.commit()
    await db.refresh(row)
    return _serialize_manual_task(row)


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
