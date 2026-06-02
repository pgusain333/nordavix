"""
Onboarding status — a read-only checklist that tells the dashboard how far a
new workspace has gotten through first-run setup. Every step is DERIVED from
data that already exists (no new tables, no manual ticking): connect QBO, set
the books-start date, run a sync, complete a reconciliation, run a flux
analysis, invite a teammate.

GET /api/onboarding/status
  → { steps: [{key,label,description,done,cta,optional}], complete, done, total }

`complete` is true once every NON-optional step is done — the frontend hides the
checklist card at that point.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId
from core.db.session import get_db
from models.account_review_status import AccountReviewStatus
from models.period_sync import PeriodSync
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from models.user import User
from models.variance import Variance

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
    reconciled    = (await db.execute(
        select(AccountReviewStatus.id)
        .where(AccountReviewStatus.status.in_(("reviewed", "approved")))
        .limit(1)
    )).first() is not None
    fluxed        = await _exists(db, Variance.id)
    # >1 user in this tenant ⇒ at least one teammate joined.
    user_count    = (await db.execute(select(func.count(User.id)))).scalar() or 0
    has_team      = user_count > 1

    steps = [
        OnboardingStep(key="connect",   label="Connect QuickBooks",
                       description="Link your QuickBooks Online company so Nordavix can pull your books.",
                       done=qbo_connected, cta="/app/connections"),
        OnboardingStep(key="books",     label="Set your books start date",
                       description="Tell Nordavix when your books begin so opening balances roll forward correctly.",
                       done=books_started, cta="/app/setup/books"),
        OnboardingStep(key="sync",      label="Run your first sync",
                       description="Pull the trial balance and snapshot your GL for the period.",
                       done=synced, cta="/app/reconciliations"),
        OnboardingStep(key="reconcile", label="Complete a reconciliation",
                       description="Tie out a balance-sheet account against its subledger.",
                       done=reconciled, cta="/app/reconciliations"),
        OnboardingStep(key="flux",      label="Run a flux analysis",
                       description="Explain the material movements in your P&L.",
                       done=fluxed, cta="/app/flux"),
        OnboardingStep(key="team",      label="Invite a teammate",
                       description="Add a preparer or reviewer so you can split maker/checker duties.",
                       done=has_team, cta="/app/team", optional=True),
    ]

    required = [s for s in steps if not s.optional]
    return OnboardingStatus(
        steps=steps,
        complete=all(s.done for s in required),
        done=sum(1 for s in steps if s.done),
        total=len(steps),
    )
