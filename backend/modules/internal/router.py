"""
Internal / scheduled-task endpoints.

These are NOT called by users — they're triggered by a scheduler (a Fly
scheduled machine, cron, or an external uptime-style pinger). The tenancy
middleware lets `/api/internal/*` through without a Clerk JWT (it has no tenant
context), so every endpoint here is instead gated by a shared secret in the
`X-Internal-Secret` header, compared in constant time.

If `INTERNAL_TASK_SECRET` is unset the endpoints are DISABLED (503) — a missing
secret can never leave them publicly callable.
"""
import hmac
import logging

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException

from core.config import settings
from modules.assistant.retention import purge_expired_threads
from modules.reengagement.service import run_reengagement
from modules.workspace.purge import purge_expired_tenants

logger = logging.getLogger(__name__)

router = APIRouter()


def _require_internal_secret(provided: str | None) -> None:
    """Constant-time check of the X-Internal-Secret header. 503 if the feature
    isn't configured; 401 if the secret is missing/wrong."""
    expected = (settings.internal_task_secret or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Internal tasks are disabled (INTERNAL_TASK_SECRET not set).",
        )
    if not provided or not hmac.compare_digest(provided.strip(), expected):
        raise HTTPException(status_code=401, detail="Invalid internal task secret.")


@router.post("/purge-expired-tenants")
async def run_purge_expired_tenants(
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Hard-delete every soft-deleted tenant whose 30-day grace window has elapsed.
    Idempotent — safe to call on a daily schedule. Returns a per-tenant summary.
    """
    _require_internal_secret(x_internal_secret)
    summaries = await purge_expired_tenants()
    purged = sum(1 for s in summaries if s.get("ok"))
    failed = sum(1 for s in summaries if not s.get("ok"))
    logger.info("Purge endpoint ran: %d purged, %d failed.", purged, failed)
    return {"purged": purged, "failed": failed, "results": summaries}


@router.post("/purge-expired-assistant-threads")
async def run_purge_expired_assistant_threads(
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Hard-delete NDVX Copilot conversations that have been inactive longer than the
    retention window (ASSISTANT_RETENTION_DAYS, default 90). Chat is a convenience
    layer — recons / proposed entries / the audit log are untouched. Idempotent;
    safe to call daily. Returns {threads, messages, retention_days}.
    """
    _require_internal_secret(x_internal_secret)
    summary = await purge_expired_threads()
    logger.info("Assistant retention endpoint ran: %s", summary)
    return summary


@router.post("/run-reengagement")
async def run_reengagement_endpoint(
    dry_run: int = 0,
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Run the re-engagement drip sweep: enroll signed-up-but-inactive users, exit
    anyone who has since activated or unsubscribed, and send each due person the
    next email in the 5-step sequence. Idempotent — safe to call daily.
    ?dry_run=1 computes the summary without sending or writing anything.
    """
    _require_internal_secret(x_internal_secret)
    summary = await run_reengagement(dry_run=bool(dry_run))
    logger.info("Re-engagement endpoint ran (dry_run=%s): %s", bool(dry_run), summary)
    return summary


async def _run_autopilot_sweep() -> dict:
    """The actual daily sweep — runs in the BACKGROUND (the synchronous version
    blew past the cron's curl timeout when several workspaces were due). Opens
    its own session. For every enabled workspace whose run_day matches today
    (UTC), runs the close kickoff for the focus period — unless a
    completed/partial/running run for that period already exists (scheduled runs
    are idempotent; only the in-app "Run now" repeats a period). Demo workspaces
    never run. Tenants run SEQUENTIALLY: each is fenced, one failure can't stop
    the sweep, and the QBO/AI load stays gentle.
    """
    from datetime import date as _date

    from sqlalchemy import select as _select

    from core.db.session import get_async_session_context
    from models.autopilot import AutopilotConfig, AutopilotRun
    from models.closed_period import ClosedPeriod
    from models.tenant import Tenant
    from modules.autopilot.engine import focus_period_for, run_autopilot_for_tenant

    today = _date.today()
    ran, skipped, failed = [], 0, 0

    async with get_async_session_context() as db:
        configs = list((await db.execute(
            _select(AutopilotConfig).where(
                AutopilotConfig.enabled == True,  # noqa: E712
                AutopilotConfig.run_day == today.day,
            ),
            execution_options={"skip_tenant_filter": True},
        )).scalars().all())

        for config in configs:
            try:
                tenant = (await db.execute(
                    _select(Tenant).where(Tenant.id == config.tenant_id),
                    execution_options={"skip_tenant_filter": True},
                )).scalar_one_or_none()
                if tenant is None or tenant.is_demo or tenant.deleted_at is not None:
                    skipped += 1
                    continue
                closed = {
                    r[0] for r in (await db.execute(
                        _select(ClosedPeriod.period_end)
                        .where(ClosedPeriod.tenant_id == tenant.id),
                        execution_options={"skip_tenant_filter": True},
                    )).all()
                }
                focus = focus_period_for(tenant, closed, today)
                if focus is None:
                    skipped += 1
                    continue
                prior = (await db.execute(
                    _select(AutopilotRun).where(
                        AutopilotRun.tenant_id == tenant.id,
                        AutopilotRun.period_end == focus,
                        AutopilotRun.status.in_(("completed", "partial", "running")),
                    ).limit(1),
                    execution_options={"skip_tenant_filter": True},
                )).scalar_one_or_none()
                if prior is not None:
                    skipped += 1
                    continue
                run = await run_autopilot_for_tenant(
                    db, tenant, config, focus,
                    triggered_by="schedule", started_by=None,
                )
                ran.append({"tenant": str(tenant.id), "period": focus.isoformat(), "status": run.status})
            except Exception:
                logger.exception("Autopilot sweep failed for tenant %s", config.tenant_id)
                failed += 1

    summary = {"ran": ran, "skipped": skipped, "failed": failed, "day": today.day}
    logger.info("Autopilot sweep done: %s", summary)
    return summary


@router.post("/run-autopilot")
async def run_autopilot_endpoint(
    background_tasks: BackgroundTasks,
    x_internal_secret: str | None = Header(default=None),
) -> dict:
    """
    Daily Autopilot trigger (hit by the GitHub Actions cron). Validates the
    secret, then kicks the sweep off in the BACKGROUND and returns immediately
    so the cron's HTTP request never times out — the prior synchronous version
    awaited every due workspace's full close inline and exceeded the 590s curl
    budget. The sweep ([_run_autopilot_sweep]) does the real work: every enabled
    workspace whose run_day matches today, idempotent per period, demo excluded.
    """
    from datetime import date as _date

    _require_internal_secret(x_internal_secret)
    background_tasks.add_task(_run_autopilot_sweep)
    return {"scheduled": True, "day": _date.today().day}
