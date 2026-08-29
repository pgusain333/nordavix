"""The continuous-close sweep — the loop that checks the books without being asked.

Hit hourly by the cron. Every workspace with continuous close enabled fires in
its OWN hour, on its own clock, at most once a day; `schedule.is_due` owns that
rule and is tested against a full day and both clock-change weekends.

What runs is the Risk Radar scan that already exists — eight transaction-level
detectors over the open period. This module decides WHEN, skips what it should
not touch, and speaks only when there is something new to say.

Three things it deliberately does not do:

  * It does not run the monthly close. That is Autopilot, and running it daily
    would burn AI spend and analyse a month that isn't over.
  * It does not notify on a quiet day. A daily "0 anomalies" trains people to
    ignore the channel, and the silence is the product working.
  * It does not touch a closed period. There is nothing continuous to watch in
    a month that has been signed off and locked.
"""
import logging
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select

from core.db.base import current_tenant_id
from core.db.session import AsyncSessionLocal
from models.autopilot import AutopilotConfig
from models.closed_period import ClosedPeriod
from models.gl_scan_run import GlScanRun
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from modules.gl_accuracy.schedule import is_due, watch_periods

logger = logging.getLogger(__name__)


async def _last_ok_scan_at(session, tenant_id: uuid.UUID) -> datetime | None:
    """When this workspace was last checked SUCCESSFULLY, any period.

    Successful only: a crashed run must not satisfy the once-a-day guard, or a
    workspace whose scans keep failing would be quietly skipped forever while
    the strip showed the failure nobody was acting on.
    """
    return (await session.execute(
        select(GlScanRun.finished_at)
        .where(GlScanRun.tenant_id == tenant_id, GlScanRun.ok.is_(True))
        .order_by(GlScanRun.finished_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _periods_to_watch(session, tenant: Tenant, today: date) -> list[date]:
    """The months to check: the CURRENT, in-progress one and the prior unclosed one.

    This used to borrow Autopilot's focus_period_for, which returns the oldest
    non-closed FULLY-ELAPSED month. Right for a monthly close, wrong for a daily
    watch — it meant an entry made today, dated today, was never looked at, and
    the whole point of checking daily is that it is.
    """
    from modules.autopilot.engine import focus_period_for

    closed = {
        r for r in (await session.execute(
            select(ClosedPeriod.period_end).where(ClosedPeriod.tenant_id == tenant.id)
        )).scalars().all()
    }
    return watch_periods(
        books_start=tenant.books_start_date,
        closed=closed,
        today=today,
        elapsed_focus=focus_period_for(tenant, closed, today),
    )


async def run_continuous_sweep(now_utc: datetime | None = None) -> dict:
    """One hourly tick across every workspace with continuous close enabled.

    Workspaces run SEQUENTIALLY and each is fenced: one failure records itself
    and the sweep carries on. A tick that dies partway must not leave the rest
    of the estate unchecked.
    """
    now = now_utc or datetime.now(UTC)
    checked: list[str] = []
    skipped = 0
    failed: list[dict] = []

    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            select(Tenant, AutopilotConfig)
            .join(AutopilotConfig, AutopilotConfig.tenant_id == Tenant.id)
            .where(
                AutopilotConfig.continuous_enabled.is_(True),
                Tenant.deleted_at.is_(None),
                Tenant.is_demo.is_(False),
            ),
            execution_options={"skip_tenant_filter": True},
        )).all()

    for tenant, cfg in rows:
        try:
            current_tenant_id.set(tenant.id)
            async with AsyncSessionLocal() as session:
                last_ok = await _last_ok_scan_at(session, tenant.id)
                if not is_due(
                    timezone=tenant.timezone,
                    check_hour=cfg.check_hour,
                    last_ok_scan_at=last_ok,
                    now_utc=now,
                ):
                    skipped += 1
                    continue

                # Nothing continuous to watch in a fully closed set of books.
                periods = await _periods_to_watch(session, tenant, now.date())
                if not periods:
                    skipped += 1
                    continue

                conn = (await session.execute(
                    select(QboConnection).where(QboConnection.tenant_id == tenant.id),
                    execution_options={"skip_tenant_filter": True},
                )).scalar_one_or_none()
                if conn is None:
                    skipped += 1
                    continue

                from modules.gl_accuracy.service import scan_period
                # Newest first, so the open month is scanned before the one
                # being closed — if a tick is cut short, the current month is
                # the one that mattered most.
                for pe in periods:
                    summary = await scan_period(
                        conn, session, tenant_id=tenant.id, period_end=pe,
                        trigger="scheduled",
                    )
                    await session.commit()
                    await _notify_if_new(session, tenant, pe, summary)
                checked.append(str(tenant.id))
        except Exception as exc:  # noqa: BLE001 — one tenant must not stop the sweep
            logger.exception("continuous sweep failed for tenant %s", tenant.id)
            failed.append({"tenant_id": str(tenant.id), "error": str(exc)[:300]})
        finally:
            current_tenant_id.set(None)

    logger.info(
        "continuous sweep: %d checked, %d skipped, %d failed",
        len(checked), skipped, len(failed),
    )
    return {"checked": len(checked), "skipped": skipped, "failed": failed}


async def _notify_if_new(session, tenant: Tenant, pe: date, summary: dict) -> None:
    """Tell the workspace only when this check turned up something NEW.

    `summary["new"]` counts findings whose first_seen_at was set by this run, so
    a problem already reported yesterday stays quiet. Silence on a clean day is
    the feature: a daily "0 anomalies" is how a channel gets muted.
    """
    new = int(summary.get("new") or 0)
    if new <= 0:
        return
    try:
        from core import links
        from models.user import User
        from modules.notifications.service import notify

        recipients = list((await session.execute(
            select(User.id).where(User.tenant_id == tenant.id),
            execution_options={"skip_tenant_filter": True},
        )).scalars().all())
        if not recipients:
            return
        plural = "" if new == 1 else "s"
        title = f"{new} new item{plural} flagged in {pe.strftime('%b %Y')}"
        body = (
            f"Nordavix checked {summary.get('scanned', 0):,} transactions and found "
            f"{new} new item{plural} to review."
        )
        # In-app only. The email path takes a request's BackgroundTasks to defer
        # the send, and a cron sweep has no request — passing None there would
        # create the notification, commit it, and then throw on the email,
        # leaving a half-delivered ping and a stack trace nobody reads.
        # Emailing a daily sweep is its own decision (opt-in, frequency) rather
        # than something to inherit from the monthly digest.
        for uid in recipients:
            notify(
                session, tenant_id=tenant.id, recipient_user_id=uid,
                type="risk_findings", title=title, body=body,
                link=links.risk_radar(pe),
                entity_type="period", entity_id=pe.isoformat(),
            )
        await session.commit()
    except Exception:
        logger.warning("continuous-close notification failed for %s", tenant.id, exc_info=True)
