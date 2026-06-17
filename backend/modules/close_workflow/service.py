"""
Close Management workflow — service layer.

The close checklist is a milestone layer ABOVE the granular Tasks list:

  • A per-tenant TEMPLATE defines the steps (seeded with a sensible default;
    the firm can edit/reorder/deactivate them per client).
  • Per period, the template is instantiated into CloseStepInstance rows that
    hold owner / due / status / notes / completion stamps.
  • LINKED steps (sync / recon / schedule / flux / close) have their status
    DERIVED live from the underlying module's state for that period — so the
    checklist reflects reality without anyone re-ticking it. MANUAL steps
    (adjustments / financials / review / custom) are toggled by the user.

All writes are guarded by the read-only (demo) flag: a demo workspace gets a
fully-rendered, ephemeral checklist without ever persisting a row.
"""
import uuid
from calendar import monthrange
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from core.db.base import current_request_readonly
from models.account_review_status import AccountReviewStatus
from models.close_step import CloseStepInstance, CloseTemplateStep
from models.closed_period import ClosedPeriod
from models.period_sync import PeriodSync
from models.schedule import (
    ScheduleAccrual,
    ScheduleFixedAsset,
    ScheduleLease,
    ScheduleLoan,
    SchedulePrepaid,
    ScheduleSnapshot,
)
from models.tenant import Tenant
from models.trial_balance import TrialBalance

VALID_CATEGORIES = {
    "sync", "recon", "schedule", "adjustments",
    "flux", "financials", "review", "close", "custom",
}
# linked_module values that auto-derive status from a real module.
VALID_LINKED = {"sync", "recon", "schedule", "flux", "close"}
VALID_STATUS = {"pending", "in_progress", "done", "skipped"}
# A prerequisite is satisfied (doesn't block its dependents) when it's done OR
# explicitly skipped ("not applicable") — so a skipped step never dead-ends a chain.
DEP_SATISFIED = ("done", "skipped")

_SCHEDULE_MODELS = (
    SchedulePrepaid, ScheduleAccrual, ScheduleFixedAsset, ScheduleLease, ScheduleLoan,
)
# Kind ↔ model ↔ human label (labels mirror the schedules module's _HUMAN_NAMES).
_SCHEDULE_KIND_FOR = {
    SchedulePrepaid: "prepaid", ScheduleAccrual: "accrual",
    ScheduleFixedAsset: "fixed_asset", ScheduleLease: "lease", ScheduleLoan: "loan",
}
_SCHEDULE_KIND_LABEL = {
    "prepaid": "Prepaid Expenses", "accrual": "Accrued Expenses",
    "fixed_asset": "Fixed Assets", "lease": "Leases", "loan": "Loans",
}

# The default close checklist seeded for a new workspace. Order matters — it
# mirrors the real month-end sequence. Linked steps auto-complete from their
# module; the rest are manual confirmations the reviewer ticks.
DEFAULT_STEPS: list[dict[str, Any]] = [
    {"key": "sync", "title": "Sync QuickBooks",
     "description": "Pull the latest trial balance and balances from QuickBooks for the period.",
     "category": "sync", "linked_module": "sync", "due_offset_days": 3,
     "default_assignee_role": "preparer", "depends_on_key": None},
    {"key": "recon", "title": "Reconcile balance-sheet accounts",
     "description": "Prepare and approve every balance-sheet reconciliation for the period.",
     "category": "recon", "linked_module": "recon", "due_offset_days": 10,
     "default_assignee_role": "preparer", "depends_on_key": "sync"},
    {"key": "schedule", "title": "Update supporting schedules",
     "description": "Roll forward prepaids, accruals, fixed assets, leases and loans, and commit the snapshots.",
     "category": "schedule", "linked_module": "schedule", "due_offset_days": 10,
     "default_assignee_role": "preparer", "depends_on_key": "sync"},
    {"key": "adjustments", "title": "Post adjusting entries",
     "description": "Review the proposed adjusting entries and book the approved ones in QuickBooks.",
     "category": "adjustments", "linked_module": None, "due_offset_days": 12,
     "default_assignee_role": "preparer", "depends_on_key": "recon"},
    {"key": "flux", "title": "Flux / variance analysis",
     "description": "Run flux analysis and approve the commentary for material variances.",
     "category": "flux", "linked_module": "flux", "due_offset_days": 12,
     "default_assignee_role": "preparer", "depends_on_key": "recon"},
    {"key": "financials", "title": "Review financial statements",
     "description": "Generate the financial package and review the statements for the period.",
     "category": "financials", "linked_module": None, "due_offset_days": 13,
     "default_assignee_role": "reviewer", "depends_on_key": "flux"},
    {"key": "review", "title": "Manager review",
     "description": "Final manager review of the close before locking the books.",
     "category": "review", "linked_module": None, "due_offset_days": 14,
     "default_assignee_role": "reviewer", "depends_on_key": "financials"},
    {"key": "close", "title": "Close the books",
     "description": "Lock the period once every reconciliation and flux analysis is approved.",
     "category": "close", "linked_module": "close", "due_offset_days": 15,
     "default_assignee_role": "admin", "depends_on_key": "review"},
]


def month_end(d: date) -> date:
    return date(d.year, d.month, monthrange(d.year, d.month)[1])


def _due_date_for(pe: date, offset: int | None) -> date | None:
    return pe + timedelta(days=offset) if offset is not None else None


# ── Template ──────────────────────────────────────────────────────────────


async def get_or_seed_template(
    db: AsyncSession, tenant_id: uuid.UUID, actor_id: uuid.UUID | None,
) -> list[CloseTemplateStep]:
    """Return this tenant's template steps (all of them, active first by order).
    Seeds the default checklist on first use — unless the request is read-only
    (demo), in which case ephemeral, un-persisted default rows are returned so
    the page still renders."""
    rows = list((await db.execute(
        select(CloseTemplateStep).order_by(CloseTemplateStep.order_index)
    )).scalars().all())
    if rows:
        return rows

    if current_request_readonly.get():
        # Ephemeral defaults — never written for the read-only sample company.
        return [
            CloseTemplateStep(
                id=uuid.uuid4(), tenant_id=tenant_id, key=s["key"], order_index=i,
                title=s["title"], description=s["description"], category=s["category"],
                linked_module=s["linked_module"], due_offset_days=s["due_offset_days"],
                default_assignee_role=s["default_assignee_role"],
                depends_on_key=s["depends_on_key"], is_active=True,
            )
            for i, s in enumerate(DEFAULT_STEPS)
        ]

    seeded: list[CloseTemplateStep] = []
    for i, s in enumerate(DEFAULT_STEPS):
        row = CloseTemplateStep(
            id=uuid.uuid4(), tenant_id=tenant_id, key=s["key"], order_index=i,
            title=s["title"], description=s["description"], category=s["category"],
            linked_module=s["linked_module"], due_offset_days=s["due_offset_days"],
            default_assignee_role=s["default_assignee_role"],
            depends_on_key=s["depends_on_key"], is_active=True,
            created_by=actor_id,
        )
        db.add(row)
        seeded.append(row)
    await db.flush()
    return seeded


# ── Linked-module status derivation ───────────────────────────────────────


async def _recon_status(db: AsyncSession, pe: date) -> tuple[str, datetime | None]:
    rows = list((await db.execute(
        select(AccountReviewStatus).where(AccountReviewStatus.period_end == pe)
    )).scalars().all())
    if not rows:
        return "pending", None
    if all(r.status == "approved" for r in rows):
        stamps = [r.approved_at for r in rows if r.approved_at]
        return "done", (max(stamps) if stamps else None)
    if any(r.status in ("reviewed", "approved", "flagged") for r in rows):
        return "in_progress", None
    return "pending", None


async def _flux_status(db: AsyncSession, pe: date) -> tuple[str, datetime | None]:
    # Latest-TB-wins: a period can have several trial balances (re-runs,
    # corrections, an errored upload). Keying "done" off the most recent one's
    # approval — rather than requiring EVERY historical row to be approved —
    # mirrors how autopilot picks the period's TB and avoids a stale/errored
    # row pinning the step at in_progress forever.
    first = pe.replace(day=1)
    latest = (await db.execute(
        select(TrialBalance)
        .where(TrialBalance.period_current >= first, TrialBalance.period_current <= pe)
        .order_by(TrialBalance.period_current.desc(), TrialBalance.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if latest is None:
        return "pending", None
    if latest.approved_at is not None:
        return "done", latest.approved_at
    return "in_progress", None


async def _active_schedule_kinds(db: AsyncSession) -> set[str]:
    """Schedule kinds with at least one active item that HAS a GL account — i.e.
    something the commit flow can actually roll forward. A kind whose only active
    items lack a GL account isn't committable (the schedule page shows "Nothing to
    commit"), so it must never be required by the close — this keeps the close
    requirement and the per-schedule commit button in lockstep."""
    kinds: set[str] = set()
    for model in _SCHEDULE_MODELS:
        accts = (await db.execute(
            select(model.qbo_account_id).where(model.is_active.is_(True))
        )).scalars().all()
        if any((a or "").strip() for a in accts):
            kinds.add(_SCHEDULE_KIND_FOR[model])
    return kinds


async def _schedule_status(db: AsyncSession, pe: date) -> tuple[str, datetime | None]:
    # Only kinds with committable items (active + a GL account) gate the close.
    active_kinds = await _active_schedule_kinds(db)
    if not active_kinds:
        # Nothing committable to schedule for this client — step not applicable.
        return "done", None

    snaps = list((await db.execute(
        select(ScheduleSnapshot).where(
            ScheduleSnapshot.period_end == pe,
            ScheduleSnapshot.status == "committed",
        )
    )).scalars().all())
    committed_kinds = {s.schedule_type for s in snaps}
    if active_kinds <= committed_kinds:
        stamps = [s.committed_at for s in snaps if s.committed_at]
        return "done", (max(stamps) if stamps else None)
    if snaps:
        return "in_progress", None
    return "pending", None


async def _schedule_detail(db: AsyncSession, pe: date) -> dict[str, Any]:
    """Per-kind commit state for the schedule step, scoped to the EXACT close
    period `pe`. Powers the dynamic description + per-kind chips so a stuck
    schedule step is never a mystery: which kind still needs a commit, which went
    stale (committed, then items changed) and needs a re-commit, and — the common
    gotcha — which was committed for a DIFFERENT month than the one being closed.
    Pure reads; never mutates a row, so it's safe on the read-only (demo) path."""
    active_set = await _active_schedule_kinds(db)
    active_kinds = [_SCHEDULE_KIND_FOR[m] for m in _SCHEDULE_MODELS if _SCHEDULE_KIND_FOR[m] in active_set]
    if not active_kinds:
        return {"applicable": False, "kinds": []}

    # Every snapshot for the in-use kinds, any period — one query. We look across
    # periods so a kind committed for the WRONG month can be surfaced explicitly.
    snaps = list((await db.execute(
        select(ScheduleSnapshot).where(ScheduleSnapshot.schedule_type.in_(active_kinds))
    )).scalars().all())

    kinds_out: list[dict[str, Any]] = []
    for kind in active_kinds:
        ks = [s for s in snaps if s.schedule_type == kind]
        committed_here = [s for s in ks if s.period_end == pe and s.status == "committed"]
        stale_here = [s for s in ks if s.period_end == pe and s.status == "stale"]
        other: date | None = None
        if committed_here:
            stamps = [s.committed_at for s in committed_here if s.committed_at]
            state, committed_at = "committed", (max(stamps) if stamps else None)
        elif stale_here:
            stamps = [s.committed_at for s in stale_here if s.committed_at]
            state, committed_at = "stale", (max(stamps) if stamps else None)
        else:
            state, committed_at = "missing", None
            # Committed for a different period? That's why the close step is stuck.
            elsewhere = [s.period_end for s in ks if s.status == "committed" and s.period_end != pe]
            other = max(elsewhere) if elsewhere else None
        kinds_out.append({
            "kind": kind,
            "label": _SCHEDULE_KIND_LABEL.get(kind, kind),
            "state": state,
            "committed_at": committed_at.isoformat() if committed_at else None,
            "committed_other_period": other.isoformat() if other else None,
        })
    return {"applicable": True, "kinds": kinds_out}


async def _sync_status(db: AsyncSession, pe: date) -> tuple[str, datetime | None]:
    row = (await db.execute(
        select(PeriodSync).where(PeriodSync.period_end == pe)
    )).scalar_one_or_none()
    if row is None:
        return "pending", None
    return "done", row.synced_at


async def _close_status(db: AsyncSession, pe: date) -> tuple[str, datetime | None]:
    row = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == pe)
    )).scalar_one_or_none()
    if row is None:
        return "pending", None
    return "done", row.closed_at


async def linked_status(
    db: AsyncSession, module: str, pe: date,
) -> tuple[str, datetime | None]:
    """(status, completed_at) derived from the underlying module for `pe`."""
    if module == "recon":
        return await _recon_status(db, pe)
    if module == "flux":
        return await _flux_status(db, pe)
    if module == "schedule":
        return await _schedule_status(db, pe)
    if module == "sync":
        return await _sync_status(db, pe)
    if module == "close":
        return await _close_status(db, pe)
    return "pending", None


# ── Per-period checklist (generate + overlay) ─────────────────────────────


async def build_checklist(
    db: AsyncSession, tenant_id: uuid.UUID, pe: date, actor_id: uuid.UUID | None,
) -> list[dict[str, Any]]:
    """The ordered checklist for a period: generate any missing instances from
    the active template, then overlay live linked-module status. Read-only
    (demo) requests get a fully-computed ephemeral checklist with no writes."""
    readonly = current_request_readonly.get()
    template = await get_or_seed_template(db, tenant_id, actor_id)
    active_steps = [s for s in template if s.is_active]

    # Idempotently create any missing instances up front. ON CONFLICT DO NOTHING
    # makes a concurrent first-build of the same period race-safe — without it the
    # unique (tenant_id, period_end, step_key) constraint would 500 the loser of
    # two simultaneous requests. Skipped entirely on the read-only (demo /
    # suspended-member) path, which must never write.
    if not readonly and active_steps:
        values = [
            {
                "id": uuid.uuid4(), "tenant_id": tenant_id, "period_end": pe,
                "step_key": step.key, "order_index": step.order_index,
                "title": step.title, "description": step.description,
                "category": step.category, "linked_module": step.linked_module,
                "status": "pending", "due_date": _due_date_for(pe, step.due_offset_days),
                "created_by": actor_id,
            }
            for step in active_steps
        ]
        await db.execute(
            pg_insert(CloseStepInstance).values(values)
            .on_conflict_do_nothing(constraint="uq_close_step_instances_tenant_period_step")
        )
        await db.flush()

    existing = {
        r.step_key: r for r in (await db.execute(
            select(CloseStepInstance).where(CloseStepInstance.period_end == pe)
        )).scalars().all()
    }

    out: list[dict[str, Any]] = []
    for step in active_steps:
        linked = step.linked_module in VALID_LINKED
        inst = existing.get(step.key)
        if inst is None:
            # Read-only path with no persisted row — a transient view object,
            # never added to the session so it can't dirty or trigger a flush.
            inst = CloseStepInstance(
                id=uuid.uuid4(), tenant_id=tenant_id, period_end=pe, step_key=step.key,
                order_index=step.order_index, title=step.title, description=step.description,
                category=step.category, linked_module=step.linked_module,
                status="pending", due_date=_due_date_for(pe, step.due_offset_days),
            )

        if linked:
            live, completed_at = await linked_status(db, step.linked_module, pe)
            done_stamp = completed_at if live == "done" else None
            if readonly:
                # NEVER mutate a session-tracked row on a read-only request — a
                # dirty row would trip the read-only flush guard (demo tenant or
                # a suspended member) and 403 the whole page. Serialize the live
                # values into the response instead.
                out.append(_serialize_instance(
                    inst, linked=True, status_override=live, completed_at_override=done_stamp))
                continue
            inst.status = live
            if live == "done" and inst.completed_at is None and completed_at is not None:
                inst.completed_at = completed_at
            elif live != "done":
                # Module regressed (e.g. a recon was reset) — clear stale stamp.
                inst.completed_at = None

        out.append(_serialize_instance(inst, linked=linked))

    # Dependency gating: a step is "blocked" until its prerequisite (by key, and
    # only when that prerequisite is itself an active step) is done. Derived from
    # the effective statuses just resolved — order-independent, no extra queries.
    status_by_key = {o["step_key"]: o["status"] for o in out}
    dep_by_key = {s.key: s.depends_on_key for s in active_steps}
    title_by_key = {s.key: s.title for s in active_steps}
    tmpl_by_key = {s.key: s for s in active_steps}
    # Closed periods keep the title/order they were generated with (audit trail).
    # OPEN periods overlay the CURRENT template, so an admin's renames, reordering,
    # and re-categorising in "Customize the checklist" show up on the live
    # checklist right away instead of being frozen at the period's snapshot.
    # (Per-instance fields — status, owner, due date, notes — are never touched.)
    period_is_closed = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == pe)
    )).scalar_one_or_none() is not None
    for o in out:
        if not period_is_closed:
            t = tmpl_by_key.get(o["step_key"])
            if t is not None:
                o["title"] = t.title
                o["description"] = t.description
                o["category"] = t.category
                o["order_index"] = t.order_index
        dep = dep_by_key.get(o["step_key"])
        # Only an ACTIVE prerequisite (one present in status_by_key) can gate a
        # step; a hidden/deleted prereq neither blocks nor is advertised here.
        active_dep = dep if dep in status_by_key else None
        blocked = bool(active_dep and status_by_key[active_dep] not in DEP_SATISFIED)
        o["depends_on_key"] = active_dep
        o["blocked"] = blocked
        o["blocked_by"] = title_by_key.get(active_dep) if blocked else None

    # Schedule step: attach per-kind commit detail + a description that names only
    # the schedule kinds this client actually uses — so it never implies the blank
    # ones must be committed, and the chips show exactly what's missing, stale, or
    # committed for the wrong month. Pure reads (safe on the read-only path).
    for o in out:
        if o.get("linked_module") == "schedule":
            detail = await _schedule_detail(db, pe)
            o["schedule_detail"] = detail
            if not detail["applicable"]:
                o["description"] = "No supporting schedules in use for this client — nothing to commit."
            else:
                labels = ", ".join(k["label"] for k in detail["kinds"])
                o["description"] = f"Roll forward and commit your schedules for this period: {labels}."
            break

    if not readonly:
        await db.flush()

    out.sort(key=lambda r: r["order_index"])
    return out


def _serialize_instance(
    inst: CloseStepInstance, *, linked: bool,
    status_override: str | None = None, completed_at_override: datetime | None = None,
) -> dict[str, Any]:
    # status_override is only passed on the read-only linked path, where we must
    # report live values WITHOUT writing them onto the tracked row. When it's set,
    # completed_at_override carries the matching stamp (datetime or None).
    status = status_override if status_override is not None else inst.status
    completed_at = completed_at_override if status_override is not None else inst.completed_at
    return {
        "step_key":      inst.step_key,
        "order_index":   inst.order_index,
        "title":         inst.title,
        "description":   inst.description,
        "category":      inst.category,
        "linked_module": inst.linked_module,
        "linked":        linked,
        "status":        status,
        "assignee_id":   str(inst.assignee_id) if inst.assignee_id else None,
        "due_date":      inst.due_date.isoformat() if inst.due_date else None,
        "completed_at":  completed_at.isoformat() if completed_at else None,
        "completed_by":  str(inst.completed_by) if inst.completed_by else None,
        "notes":         inst.notes,
    }


def serialize_template_step(s: CloseTemplateStep) -> dict[str, Any]:
    return {
        "id":            str(s.id),
        "key":           s.key,
        "order_index":   s.order_index,
        "title":         s.title,
        "description":   s.description,
        "category":      s.category,
        "linked_module": s.linked_module,
        "due_offset_days": s.due_offset_days,
        "default_assignee_role": s.default_assignee_role,
        "depends_on_key": s.depends_on_key,
        "is_active":     s.is_active,
    }


async def _effective_status_of(db: AsyncSession, step: CloseTemplateStep, pe: date) -> str:
    """The status that gates dependents: live module status for linked steps,
    else the stored instance status (pending if no instance yet)."""
    if step.linked_module in VALID_LINKED:
        live, _ = await linked_status(db, step.linked_module, pe)
        return live
    inst = (await db.execute(
        select(CloseStepInstance).where(
            CloseStepInstance.period_end == pe,
            CloseStepInstance.step_key == step.key,
        )
    )).scalar_one_or_none()
    return inst.status if inst else "pending"


async def blocked_for(
    db: AsyncSession, pe: date, step_key: str,
) -> tuple[bool, str | None]:
    """(blocked, prerequisite_title) for a step in this period. Blocked when the
    step's prerequisite is an active step that isn't done yet. Used to gate
    'mark done' on the server (the checklist computes the same thing for display)."""
    step = (await db.execute(
        select(CloseTemplateStep).where(CloseTemplateStep.key == step_key)
    )).scalar_one_or_none()
    if step is None or not step.depends_on_key:
        return False, None
    prereq = (await db.execute(
        select(CloseTemplateStep).where(CloseTemplateStep.key == step.depends_on_key)
    )).scalar_one_or_none()
    if prereq is None or not prereq.is_active:
        return False, None
    status = await _effective_status_of(db, prereq, pe)
    return (status not in DEP_SATISFIED), prereq.title


async def get_or_create_instance(
    db: AsyncSession, tenant_id: uuid.UUID, pe: date, step_key: str,
    actor_id: uuid.UUID | None,
) -> CloseStepInstance | None:
    """Fetch the instance for a (period, step), creating it from the template
    if missing. Returns None if the step_key isn't an active template step."""
    sel = select(CloseStepInstance).where(
        CloseStepInstance.period_end == pe,
        CloseStepInstance.step_key == step_key,
    )
    inst = (await db.execute(sel)).scalar_one_or_none()
    if inst is not None:
        return inst

    step = (await db.execute(
        select(CloseTemplateStep).where(CloseTemplateStep.key == step_key)
    )).scalar_one_or_none()
    if step is None or not step.is_active:
        return None
    new = CloseStepInstance(
        id=uuid.uuid4(), tenant_id=tenant_id, period_end=pe, step_key=step_key,
        order_index=step.order_index, title=step.title, description=step.description,
        category=step.category, linked_module=step.linked_module,
        status="pending", due_date=_due_date_for(pe, step.due_offset_days),
        created_by=actor_id,
    )
    # Insert inside a SAVEPOINT so a concurrent create racing on the unique
    # (tenant_id, period_end, step_key) constraint doesn't poison the whole
    # transaction — on conflict we just return the row the other request won.
    # (A read-only request still trips the flush guard here → 403, as intended.)
    try:
        async with db.begin_nested():
            db.add(new)
        return new
    except IntegrityError:
        return (await db.execute(sel)).scalar_one_or_none()


def list_periods(tenant: Tenant, closed: set[date], today: date) -> list[dict[str, Any]]:
    """Month-ends from books start through the current month, newest first,
    with a closed flag — drives the period picker on the close page."""
    if not tenant.books_start_date:
        return []
    out: list[dict[str, Any]] = []
    cur = date(tenant.books_start_date.year, tenant.books_start_date.month, 1)
    first_of_this = today.replace(day=1)
    while cur <= first_of_this:
        pe = month_end(cur)
        if pe >= tenant.books_start_date:
            out.append({
                "period_end": pe.isoformat(),
                "label":      pe.strftime("%b %Y"),
                "closed":     pe in closed,
            })
        cur = date(cur.year + 1, 1, 1) if cur.month == 12 else date(cur.year, cur.month + 1, 1)
    out.reverse()
    return out


def focus_period(tenant: Tenant, closed: set[date], today: date) -> date | None:
    """Oldest non-closed fully-elapsed month-end — the period the close is
    about (mirrors autopilot's focus_period_for)."""
    if not tenant.books_start_date:
        return None
    cur = date(tenant.books_start_date.year, tenant.books_start_date.month, 1)
    first_of_this = today.replace(day=1)
    while cur < first_of_this:
        pe = month_end(cur)
        if pe not in closed:
            return pe
        cur = date(cur.year + 1, 1, 1) if cur.month == 12 else date(cur.year, cur.month + 1, 1)
    return None


def utcnow() -> datetime:
    return datetime.now(UTC)


# ── Cycle-time analytics ──────────────────────────────────────────────────


async def compute_analytics(db: AsyncSession, tenant_id: uuid.UUID) -> dict[str, Any]:
    """Close-cycle analytics across every period (read-only):
      - days-to-close per closed period (period_end → ClosedPeriod.closed_at) + average + trend,
      - per-step average days-to-complete (completed_at − period_end) + on-time rate,
      - overall on-time %, and the bottleneck (slowest) step.
    All SELECTs are tenant-auto-filtered."""
    insts = list((await db.execute(select(CloseStepInstance))).scalars().all())
    closed = list((await db.execute(select(ClosedPeriod))).scalars().all())

    # Days to close per closed period (clamp negatives to 0).
    trend: list[dict[str, Any]] = []
    dtc: list[int] = []
    for c in sorted(closed, key=lambda c: c.period_end):
        if c.closed_at is None:
            continue
        days = max(0, (c.closed_at.date() - c.period_end).days)
        dtc.append(days)
        trend.append({
            "period_end": c.period_end.isoformat(),
            "label":      c.period_end.strftime("%b %Y"),
            "days":       days,
        })

    # Per-step duration + on-time, single pass over instances.
    dur: dict[str, list[int]] = defaultdict(list)
    st_hit: dict[str, int] = defaultdict(int)
    st_tot: dict[str, int] = defaultdict(int)
    title: dict[str, str] = {}
    cat: dict[str, str] = {}
    order: dict[str, int] = {}
    for i in insts:
        title[i.step_key] = i.title
        cat[i.step_key] = i.category
        order[i.step_key] = i.order_index
        if i.completed_at is not None:
            dur[i.step_key].append(max(0, (i.completed_at.date() - i.period_end).days))
            if i.due_date is not None:
                st_tot[i.step_key] += 1
                if i.completed_at.date() <= i.due_date:
                    st_hit[i.step_key] += 1

    steps: list[dict[str, Any]] = []
    for k, vals in dur.items():
        tot = st_tot.get(k, 0)
        steps.append({
            "step_key":        k,
            "title":           title.get(k, k),
            "category":        cat.get(k, "custom"),
            "order_index":     order.get(k, 0),
            "avg_days":        round(sum(vals) / len(vals), 1),
            "completed_count": len(vals),
            "on_time_pct":     (round(st_hit.get(k, 0) / tot * 100) if tot else None),
        })
    # Bottleneck = slowest average step (with at least one completion). Tie-break
    # deterministically on earliest workflow position, then key — otherwise the
    # pick would depend on the unordered query's row order.
    bottleneck = (
        max(steps, key=lambda s: (s["avg_days"], -s["order_index"], s["step_key"]))["step_key"]
        if steps else None
    )
    steps.sort(key=lambda s: s["order_index"])

    total_tot = sum(st_tot.values())
    total_hit = sum(st_hit.values())

    return {
        "periods_closed":      len(dtc),
        "avg_days_to_close":   (round(sum(dtc) / len(dtc), 1) if dtc else None),
        "on_time_pct":         (round(total_hit / total_tot * 100) if total_tot else None),
        "days_to_close_trend": trend,
        "steps":               steps,
        "bottleneck_step_key": bottleneck,
    }
