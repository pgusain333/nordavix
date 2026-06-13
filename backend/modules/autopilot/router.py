"""
Close Autopilot API.

  GET  /api/autopilot          config + recent runs (any member can view)
  PUT  /api/autopilot/config   one-time setup (ADMIN — enabling auto-AI
                               spend and outward-facing client emails is a
                               deliberate, admin-level choice)
  POST /api/autopilot/run      manual "Run now" (admin) — runs in the
                               background; the UI polls GET for status

The scheduled path lives in /api/internal/run-autopilot (secret-guarded,
hit daily by the GitHub Actions cron) — it loops every enabled workspace
whose run_day matches today.
"""
import logging
import uuid
from datetime import date

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_capability
from core.db.session import get_db
from models.autopilot import AutopilotConfig, AutopilotRun
from models.closed_period import ClosedPeriod
from models.tenant import Tenant
from models.user import User
from modules.autopilot.engine import focus_period_for, run_autopilot_for_tenant

logger = logging.getLogger(__name__)

router = APIRouter()


def _serialize_config(c: AutopilotConfig | None) -> dict | None:
    if c is None:
        return None
    return {
        "enabled":             c.enabled,
        "run_day":             c.run_day,
        "run_flux":            c.run_flux,
        "send_pbc_requests":   c.send_pbc_requests,
        "pbc_recipient_email": c.pbc_recipient_email,
        "updated_at":          c.updated_at.isoformat() if c.updated_at else None,
    }


def _serialize_run(r: AutopilotRun) -> dict:
    return {
        "id":           str(r.id),
        "period_end":   r.period_end.isoformat(),
        "period_label": r.period_end.strftime("%b %Y"),
        "status":       r.status,
        "triggered_by": r.triggered_by,
        "results":      r.results or {},
        "started_at":   r.started_at.isoformat() if r.started_at else None,
        "finished_at":  r.finished_at.isoformat() if r.finished_at else None,
    }


@router.get("")
async def get_autopilot(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    config = (await db.execute(select(AutopilotConfig))).scalar_one_or_none()
    runs = list((await db.execute(
        select(AutopilotRun).order_by(desc(AutopilotRun.started_at)).limit(12)
    )).scalars().all())

    # Tell the UI which period a run would target right now.
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    closed = {
        r[0] for r in (await db.execute(select(ClosedPeriod.period_end))).all()
    }
    focus = focus_period_for(tenant, closed, date.today()) if tenant else None

    return {
        "config": _serialize_config(config),
        "runs":   [_serialize_run(r) for r in runs],
        "next_period": focus.isoformat() if focus else None,
        "next_period_label": focus.strftime("%b %Y") if focus else None,
        "running": any(r.status == "running" for r in runs),
    }


class ConfigBody(BaseModel):
    enabled: bool
    run_day: int = Field(ge=1, le=28, default=1)
    run_flux: bool = True
    send_pbc_requests: bool = False
    pbc_recipient_email: str | None = Field(default=None, max_length=255)


@router.put("/config")
async def put_config(
    body: ConfigBody,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_capability("autopilot")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if body.send_pbc_requests and not (body.pbc_recipient_email or "").strip():
        raise HTTPException(
            status_code=400,
            detail="Add the client's email address to enable automatic evidence requests.",
        )
    config = (await db.execute(select(AutopilotConfig))).scalar_one_or_none()
    if config is None:
        config = AutopilotConfig(id=uuid.uuid4(), tenant_id=tenant_id, updated_by=user.id)
        db.add(config)
    config.enabled             = body.enabled
    config.run_day             = body.run_day
    config.run_flux            = body.run_flux
    config.send_pbc_requests   = body.send_pbc_requests
    config.pbc_recipient_email = (body.pbc_recipient_email or "").strip().lower() or None
    config.updated_by          = user.id
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="autopilot.config_updated", entity_type="workspace", entity_id=None,
        metadata={"summary": (
            f"Autopilot {'enabled' if body.enabled else 'disabled'} — "
            f"day {body.run_day}, flux {'on' if body.run_flux else 'off'}, "
            f"client evidence emails {'ON to ' + (config.pbc_recipient_email or '') if body.send_pbc_requests else 'off'}"
        )},
    )
    await db.commit()
    return _serialize_config(config)


async def _run_in_background(tenant_id: uuid.UUID, period_end: date, user_id: uuid.UUID) -> None:
    """Manual-run worker — opens its own session (the request's is gone)."""
    from core.db.session import get_async_session_context
    try:
        async with get_async_session_context() as session:
            tenant = (await session.execute(
                select(Tenant).where(Tenant.id == tenant_id),
                execution_options={"skip_tenant_filter": True},
            )).scalar_one_or_none()
            config = (await session.execute(
                select(AutopilotConfig).where(AutopilotConfig.tenant_id == tenant_id),
                execution_options={"skip_tenant_filter": True},
            )).scalar_one_or_none()
            if tenant is None or config is None:
                return
            await run_autopilot_for_tenant(
                session, tenant, config, period_end,
                triggered_by="manual", started_by=user_id,
            )
    except Exception:
        logger.exception("Autopilot manual run crashed for tenant %s", tenant_id)


@router.post("/run")
async def run_now(
    tenant_id: CurrentTenantId,
    background_tasks: BackgroundTasks,
    user: User = Depends(require_capability("autopilot")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    tenant = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if tenant is None or tenant.is_demo:
        raise HTTPException(status_code=403, detail="Autopilot can't run on the sample company.")
    config = (await db.execute(select(AutopilotConfig))).scalar_one_or_none()
    if config is None:
        raise HTTPException(status_code=409, detail="Save the Autopilot setup first.")

    closed = {r[0] for r in (await db.execute(select(ClosedPeriod.period_end))).all()}
    focus = focus_period_for(tenant, closed, date.today())
    if focus is None:
        raise HTTPException(
            status_code=409,
            detail="Nothing to run — every elapsed month is closed (or books aren't set up).",
        )
    already_running = (await db.execute(
        select(AutopilotRun).where(AutopilotRun.status == "running").limit(1)
    )).scalar_one_or_none()
    if already_running:
        raise HTTPException(status_code=409, detail="An Autopilot run is already in progress.")

    background_tasks.add_task(_run_in_background, tenant_id, focus, user.id)
    return {"started": True, "period_end": focus.isoformat(), "period_label": focus.strftime("%b %Y")}
