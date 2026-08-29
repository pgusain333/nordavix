"""The continuous-close sweep — the loop that checks the books without being asked.

Hit hourly by the cron. Every workspace with continuous close enabled fires in
its OWN hour, on its own clock, at most once a day; `schedule.is_due` owns that
rule and is tested against a full day and both clock-change weekends.

What runs is the Risk Radar scan that already exists. Of its detectors, the ones
that matter here read the TRANSACTION STREAM — vendor coding, duplicates, blank
memos, and the four written for this loop: a new payee, an account running above
its own norm, a future-dated entry, an expense with no payee. The structural
detectors read a month-end balance snapshot, which the current month does not
have, so they correctly stand down. This module decides WHEN, skips what it
should not touch, and speaks only when there is something new to say.

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
    """When THE SCHEDULE last completed a check for this workspace.

    Scheduled runs only, and this is the whole point. The guard exists to stop
    the hourly cron re-running the sweep it already ran today — it is not "have
    these books been looked at recently". Counting every successful scan meant a
    single press of Check now, or the automatic pass after a QuickBooks sync,
    satisfied it and suppressed the day's scheduled check entirely. The users
    most likely to lose the feature were the ones using the product most: open
    it in the morning, sync, and the 9am watch never fires. The digest email
    only sends from the scheduled sweep, so it never arrived either.

    Worse still, the sync-triggered pass usually scans the month being CLOSED —
    so a successful scan of July was suppressing the watch on August.

    Successful only: a crashed run must not satisfy the guard, or a workspace
    whose scans keep failing would be quietly skipped forever while the strip
    showed a failure nobody was acting on.
    """
    return (await session.execute(
        select(GlScanRun.finished_at)
        .where(
            GlScanRun.tenant_id == tenant_id,
            GlScanRun.ok.is_(True),
            GlScanRun.trigger == "scheduled",
        )
        .order_by(GlScanRun.finished_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _periods_to_watch(session, tenant: Tenant, today: date) -> list[date]:
    """The month continuous close tracks: the CURRENT one.

    Not the month being closed — that is Risk Radar's job and the user drives
    it on whichever period they have selected. Two features, two months, on
    purpose.
    """
    closed = {
        r for r in (await session.execute(
            select(ClosedPeriod.period_end).where(ClosedPeriod.tenant_id == tenant.id)
        )).scalars().all()
    }
    return watch_periods(
        books_start=tenant.books_start_date, closed=closed, today=today,
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
                for pe in periods:
                    summary = await scan_period(
                        conn, session, tenant_id=tenant.id, period_end=pe,
                        trigger="scheduled",
                    )
                    await session.commit()
                    await _notify_if_new(session, tenant, pe, summary, cfg)
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


async def _notify_if_new(
    session, tenant: Tenant, pe: date, summary: dict, cfg: AutopilotConfig
) -> None:
    """Tell the workspace only when this check turned up something NEW.

    `summary["new"]` counts findings whose first_seen_at was set by this run, so
    a problem already reported yesterday stays quiet. Silence on a clean day is
    the feature: a daily "0 anomalies" is how a channel gets muted.

    In-app always; email when the workspace asked for it. The email is sent
    inline rather than through BackgroundTasks — there is no request here to
    defer against, and `send_batch` already swallows its own failures, so a
    Resend outage can't take the sweep down with it.
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
        return

    if getattr(cfg, "continuous_email", False):
        try:
            await _email_digest(session, tenant, pe, summary, recipients)
        except Exception:
            logger.warning("continuous-close digest email failed for %s", tenant.id, exc_info=True)


# How many findings the digest names before it says "and N more". Enough that
# the mail is useful on its own, few enough that it stays a nudge rather than a
# report someone reads instead of opening the product.
_DIGEST_ITEMS = 6


async def _email_digest(
    session, tenant: Tenant, pe: date, summary: dict, recipient_ids: list
) -> None:
    """One branded email per opted-in member, listing what today's check found.

    The findings are looked up by the keys this run stamped as new, not by a
    time window: `first_seen_at >= started_at` looks equivalent and quietly goes
    wrong when two scans overlap or a clock skews.
    """
    from core import links
    from core.config import settings
    from core.email.sender import send_batch
    from core.email.templates import render_watch_digest_email
    from models.gl_accuracy_finding import GlAccuracyFinding
    from modules.notifications.service import resolve_email_targets

    if not settings.email_enabled:
        return
    targets = await resolve_email_targets(session, recipient_ids)
    if not targets:
        return

    keys = list(summary.get("new_keys") or [])
    items: list[dict] = []
    if keys:
        rows = list((await session.execute(
            select(GlAccuracyFinding).where(
                GlAccuracyFinding.tenant_id == tenant.id,
                GlAccuracyFinding.period_end == pe,
                GlAccuracyFinding.finding_key.in_(keys),
            ),
            execution_options={"skip_tenant_filter": True},
        )).scalars().all())
        rank = {"high": 0, "medium": 1, "low": 2}
        rows.sort(key=lambda f: (rank.get(f.severity or "medium", 1), -abs(_amount(f.amount))))
        items = [{
            "title": f.title or f"{f.vendor}: review",
            "detail": f.detail,
            "severity": f.severity,
            # Review-only flags carry a real figure too (a spike's total, a
            # first payment) — the dollars only stop meaning "to reclassify".
            "amount": _money(f.amount),
        } for f in rows[:_DIGEST_ITEMS]]

    subject, html, text = render_watch_digest_email(
        period_label=pe.strftime("%B %Y"),
        items=items,
        new_count=int(summary.get("new") or 0),
        scanned=int(summary.get("scanned") or 0),
        cta_url=settings.web_url + links.risk_radar(pe),
        workspace_name=tenant.name or None,
    )
    await send_batch([
        {"from": settings.notifications_from_email, "to": [email],
         "subject": subject, "html": html, "text": text}
        for (_uid, email) in targets
    ])


def _amount(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _money(v) -> str:
    n = abs(_amount(v))
    if not n:
        return ""
    s = f"{n:,.2f}"
    return "$" + (s[:-3] if s.endswith(".00") else s)
