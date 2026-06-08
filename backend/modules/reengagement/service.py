"""
Re-engagement drip sweep.

Finds users who signed up but never activated (no QuickBooks connection AND no
reconciliation across any tenant they belong to), enrolls them, and sends each
one the next email in the 5-step sequence when it's due (every 3 days from their
welcome). Exits anyone who has since activated or unsubscribed.

Runs WITHOUT a request/tenant context — it sweeps across every tenant — so each
tenant-scoped query passes ``skip_tenant_filter`` (the same pattern as the tenant
purge job, ``modules/workspace/purge.py``). Idempotent and safe to run daily: a
3-day gap on ``last_sent_at`` means a daily cron never double-sends, and a hard
cap of 5 steps ends the sequence.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

import models  # noqa: F401 — ensure every model is registered on Base.metadata
from core.config import settings
from core.db.session import AsyncSessionLocal
from core.email.reengagement import MAX_STEPS, send_reengagement_email
from models.qbo_connection import QboConnection
from models.reconciliation import Reconciliation
from models.reengagement_enrollment import ReengagementEnrollment
from models.tenant import Tenant
from models.user import User
from modules.email.tokens import make_unsubscribe_token

logger = logging.getLogger(__name__)

# This sweep runs without a request-scoped current_tenant_id and deliberately
# queries across tenants, so the SELECT auto-tenant-filter must be skipped.
_SKIP = {"skip_tenant_filter": True}

STEP_DAYS = 3


def _unsubscribe_url(clerk_user_id: str) -> str:
    """Backend (not frontend) URL for the one-click unsubscribe link."""
    return f"{settings.api_url}/api/email/unsubscribe?token={make_unsubscribe_token(clerk_user_id)}"


async def run_reengagement(*, now: datetime | None = None, dry_run: bool = False) -> dict:
    """Run one sweep. Returns a summary dict. ``dry_run=True`` computes everything
    (who would be enrolled / is due) but performs no writes and sends nothing."""
    now = now or datetime.now(UTC)
    can_send = bool(settings.email_enabled and settings.api_url)
    cta_url = f"{settings.web_url}/app"

    summary: dict = {
        "checked": 0, "enrolled": 0, "activated": 0, "sent": 0, "completed": 0,
        "due": 0, "skipped": {}, "dry_run": dry_run,
        "email_enabled": settings.email_enabled, "api_base_set": bool(settings.api_url),
    }

    def skip(reason: str) -> None:
        summary["skipped"][reason] = summary["skipped"].get(reason, 0) + 1

    async with AsyncSessionLocal() as session:
        # ── Candidates: welcomed humans, collapsed to the earliest welcome per person.
        rows = (await session.execute(
            select(User.clerk_user_id, User.email, User.welcomed_at, User.tenant_id)
            .where(User.welcomed_at.is_not(None)),
            execution_options=_SKIP,
        )).all()

        candidates: dict[str, dict] = {}
        for cuid, email, welcomed, tid in rows:
            c = candidates.get(cuid)
            if c is None:
                candidates[cuid] = {"email": email or "", "welcomed": welcomed, "tenants": {tid}}
                continue
            c["tenants"].add(tid)
            if welcomed and (c["welcomed"] is None or welcomed < c["welcomed"]):
                c["welcomed"] = welcomed
                if email:
                    c["email"] = email
            elif not c["email"] and email:
                c["email"] = email

        # ── Activation: any QBO connection OR any reconciliation in a shared tenant.
        qbo_clerks = set((await session.execute(
            select(User.clerk_user_id)
            .join(QboConnection, QboConnection.tenant_id == User.tenant_id)
            .distinct(),
            execution_options=_SKIP,
        )).scalars().all())
        recon_clerks = set((await session.execute(
            select(User.clerk_user_id)
            .join(Reconciliation, Reconciliation.tenant_id == User.tenant_id)
            .distinct(),
            execution_options=_SKIP,
        )).scalars().all())
        activated = qbo_clerks | recon_clerks

        # ── Demo tenants (exclude demo-only humans).
        demo_tenant_ids = set((await session.execute(
            select(Tenant.id).where(Tenant.is_demo.is_(True)),
            execution_options=_SKIP,
        )).scalars().all())

        # ── Humans with email enabled in at least one membership.
        email_on = set((await session.execute(
            select(User.clerk_user_id)
            .where(User.email_notifications_enabled.is_(True))
            .distinct(),
            execution_options=_SKIP,
        )).scalars().all())

        # ── Existing enrollments (Base table — not tenant-filtered).
        existing = (await session.execute(select(ReengagementEnrollment))).scalars().all()
        by_clerk: dict[str, ReengagementEnrollment] = {e.clerk_user_id: e for e in existing}

        for cuid, info in candidates.items():
            summary["checked"] += 1
            email = (info["email"] or "").strip()
            tenants: set = info["tenants"]
            welcomed = info["welcomed"]
            enr = by_clerk.get(cuid)

            if "@" not in email:
                skip("no_email")
                continue
            if tenants and tenants <= demo_tenant_ids:
                skip("demo_only")
                continue

            # Activated → exit. Mark an existing active enrollment; never enroll fresh.
            if cuid in activated:
                if enr is not None and enr.status == "active":
                    summary["activated"] += 1
                    if not dry_run:
                        enr.status = "activated"
                        enr.activated_at = now
                continue

            # Not activated → ensure an active enrollment exists.
            if enr is None:
                if welcomed is None:  # defensive; candidates filter on welcomed_at
                    continue
                summary["enrolled"] += 1
                enr = ReengagementEnrollment(
                    clerk_user_id=cuid, email=email, status="active",
                    step_sent=0, enrolled_at=welcomed,
                )
                by_clerk[cuid] = enr
                if not dry_run:
                    session.add(enr)
            elif enr.status != "active":
                continue
            elif enr.email != email and not dry_run:
                enr.email = email

            # Due for the next step?
            if enr.step_sent >= MAX_STEPS:
                continue
            due_at = enr.enrolled_at + timedelta(days=STEP_DAYS * (enr.step_sent + 1))
            if now < due_at:
                continue
            if enr.last_sent_at is not None and (now - enr.last_sent_at) < timedelta(days=STEP_DAYS):
                continue
            if cuid not in email_on:
                skip("email_off")
                continue

            step = enr.step_sent + 1
            summary["due"] += 1

            if dry_run:
                continue
            if not can_send:
                skip("no_email_config")
                continue

            ok = await send_reengagement_email(
                to_email=email, clerk_user_id=cuid, step=step,
                cta_url=cta_url, unsubscribe_url=_unsubscribe_url(cuid),
            )
            if ok:
                enr.step_sent = step
                enr.last_sent_at = now
                if enr.step_sent >= MAX_STEPS:
                    enr.status = "completed"
                    summary["completed"] += 1
                summary["sent"] += 1
                await session.commit()  # persist per-send so a crash can't resend
            else:
                skip("send_failed")

        if not dry_run:
            await session.commit()

    logger.info("Re-engagement sweep complete: %s", summary)
    return summary
