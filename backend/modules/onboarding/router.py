"""
Onboarding status — the blank-canvas checklist. It answers one question: is
this workspace ready to work in yet?

SETUP ONLY. It used to also list "complete a reconciliation" and "run a flux
analysis", which are the WORK, not the setup — a reconciliation is a dozen
steps of judgement, and putting it on a first-run checklist implied a single
tick would finish it. Those belong in the close itself. What is left is the
three things that turn an empty workspace into a usable one, plus the one
optional step that matters before real work starts:

    connect QuickBooks → set the books-start date → run the first sync
    (+ invite a teammate, so maker/checker is possible)

Every step is DERIVED from data that already exists — no new tables, no manual
ticking.

GET /api/onboarding/status
  → { steps: [{key,label,description,done,cta,optional}], complete, done, total }

`complete` is true once every NON-optional step is done — the frontend hides the
checklist card at that point.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from models.period_sync import PeriodSync
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from models.user import User

logger = logging.getLogger(__name__)
router = APIRouter()


class OnboardingStep(BaseModel):
    key:         str
    label:       str
    description: str
    done:        bool
    cta:         str            # in-app route the "do it" button links to
    optional:    bool = False


class OnboardingStatus(BaseModel):
    steps:    list[OnboardingStep]
    complete: bool               # all non-optional steps done
    done:     int                # count of done steps (incl. optional)
    total:    int


async def _exists(db: AsyncSession, column) -> bool:
    """True if at least one tenant-scoped row exists (auto-filtered by the
    current tenant for TenantBase models)."""
    return (await db.execute(select(column).limit(1))).first() is not None


@router.get("/status", response_model=OnboardingStatus)
async def onboarding_status(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> OnboardingStatus:
    # Tenant is a cross-tenant table → fetch by id, skip the tenant filter.
    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()

    # QboConnection is tenant-scoped but queried explicitly elsewhere — match that.
    qbo_connected = (await db.execute(
        select(QboConnection.id).where(QboConnection.tenant_id == tenant_id).limit(1),
        execution_options={"skip_tenant_filter": True},
    )).first() is not None

    books_started = bool(t and t.books_start_date)
    synced        = await _exists(db, PeriodSync.id)

    # Team membership comes from CLERK, not from local User rows. Those rows are
    # created LAZILY on a member's first request, so counting them meant an
    # invited teammate who hadn't signed in yet left this step unticked — the
    # checklist told you to do something you had already done. Clerk knows the
    # moment the invitation is accepted. Falls back to the local count if Clerk
    # is unreachable, which is the old behaviour rather than a hard failure.
    has_team = False
    if t and t.clerk_org_id:
        try:
            from core.auth.clerk_users import list_org_memberships
            has_team = len(await list_org_memberships(t.clerk_org_id)) > 1
        except Exception:
            logger.warning("Clerk membership check failed for %s", t.clerk_org_id, exc_info=True)
            has_team = False
    if not has_team:
        has_team = ((await db.execute(select(func.count(User.id)))).scalar() or 0) > 1

    steps = [
        OnboardingStep(key="connect",   label="Connect QuickBooks",
                       description="Link the QuickBooks Online company so Nordavix can read its books.",
                       done=qbo_connected, cta="/app/connections"),
        OnboardingStep(key="books",     label="Set the books start date",
                       description="The first period Nordavix should close. Opening balances roll forward from here.",
                       done=books_started, cta="/app/setup/books"),
        OnboardingStep(key="sync",      label="Run the first sync",
                       description="Pulls the trial balance and account balances. After this the workspace has data to work with.",
                       done=synced, cta="/app/reconciliations"),
        OnboardingStep(key="team",      label="Invite a teammate",
                       description="Approvals need a second person — you can't approve your own work.",
                       done=has_team, cta="/app/team", optional=True),
    ]

    required = [s for s in steps if not s.optional]
    return OnboardingStatus(
        steps=steps,
        complete=all(s.done for s in required),
        done=sum(1 for s in steps if s.done),
        total=len(steps),
    )
