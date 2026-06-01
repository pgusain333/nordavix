"""
Per-tenant AI spend cap — a runaway/abuse backstop, not a meter for normal use.

Sums the tenant's estimated Anthropic cost (the AIUsage rows written by
core.ai.usage) over the current calendar month. When that reaches the configured
cap, AI endpoints are blocked (see core.ai.guard) until the month resets.

Postgres-backed (not Redis): the source of truth is the AIUsage ledger, which is
durable and already per-tenant indexed on (tenant_id, created_at).
"""
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import func, select

from core.config import settings
from core.db.session import AsyncSessionLocal
from models.ai_usage import AIUsage

logger = logging.getLogger(__name__)


def _month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _reset_at(now: datetime) -> datetime:
    """First instant of next month (UTC) — when the cap window rolls over."""
    if now.month == 12:
        return now.replace(year=now.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    return now.replace(month=now.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)


@dataclass
class BudgetStatus:
    cap_usd: Decimal          # 0 => no dollar cap configured
    spent_usd: Decimal        # estimated spend this calendar month
    remaining_usd: Decimal    # max(0, cap - spent); 0 when no cap
    exceeded: bool            # spent >= cap (always False when cap is 0/disabled)
    enforced: bool            # whether breaches actually block (ai_cap_enforce)
    resets_at: datetime       # first instant of next month (UTC)

    def as_dict(self) -> dict:
        return {
            "cap_usd": float(self.cap_usd),
            "spent_usd": round(float(self.spent_usd), 4),
            "remaining_usd": round(float(self.remaining_usd), 4),
            "exceeded": self.exceeded,
            "enforced": self.enforced,
            "resets_at": self.resets_at.isoformat(),
        }


async def current_month_spend(tenant_id: uuid.UUID, *, now: datetime | None = None) -> Decimal:
    """Sum AIUsage.cost_usd_estimate for the tenant since the start of the
    current calendar month (UTC). Fails soft to 0 on a read error so a transient
    DB hiccup can't wrongly block AI."""
    now = now or datetime.now(UTC)
    start = _month_start(now)
    try:
        async with AsyncSessionLocal() as session:
            total = (await session.execute(
                select(func.coalesce(func.sum(AIUsage.cost_usd_estimate), 0)).where(
                    AIUsage.tenant_id == tenant_id,
                    AIUsage.created_at >= start,
                ),
                # Explicit tenant filter above; skip the auto-filter so this is
                # correct regardless of whether a request context is set.
                execution_options={"skip_tenant_filter": True},
            )).scalar_one()
        return Decimal(str(total or 0))
    except Exception:
        logger.exception("AI spend lookup failed for tenant %s — treating as 0.", tenant_id)
        return Decimal("0")


async def get_budget_status(tenant_id: uuid.UUID, *, now: datetime | None = None) -> BudgetStatus:
    now = now or datetime.now(UTC)
    cap = Decimal(str(settings.ai_monthly_cost_cap_usd or 0))
    spent = await current_month_spend(tenant_id, now=now)
    has_cap = cap > 0
    remaining = max(Decimal("0"), cap - spent) if has_cap else Decimal("0")
    exceeded = bool(has_cap and spent >= cap)
    return BudgetStatus(
        cap_usd=cap,
        spent_usd=spent,
        remaining_usd=remaining,
        exceeded=exceeded,
        enforced=bool(settings.ai_cap_enforce),
        resets_at=_reset_at(now),
    )
