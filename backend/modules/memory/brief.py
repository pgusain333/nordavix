"""The close brief — what Nordavix already knows about this client.

Client Memory learns a firm's conventions and applies them all over the
product: a confirmed pairing stops Risk Radar re-flagging a vendor, a recurring
expectation explains a movement before anyone investigates it, an offset
convention pre-fills an entry. Every one of those fires REACTIVELY, mid-task,
at the moment the user is already deep in something — so the knowledge is real,
it is working, and it is invisible at the one moment it would land: opening the
month.

This is that moment. "23 things I already know about this client. 21 held last
month. 2 need a look."

Two halves, and the second is the one that matters.

The COUNT is easy and, on its own, a vanity metric. A memory that only
accumulates eventually lies: an expectation for rent that stopped in May, a
vendor rule for a supplier nobody uses any more. Those quietly suppress flags
the firm now wants to see, and the longer they sit the more confidently wrong
the product becomes.

So every fact is also asked whether it is still earning its place. The rule is
deliberately conservative — a fact is only questioned when it has had a clear
OPPORTUNITY to fire and didn't, never merely for being old. Telling a CPA that
a correct rule looks stale teaches them to ignore the card, which is the same
failure as a daily email nobody opens.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.client_memory import ClientMemoryApplication, ClientMemoryFact

# How many consecutive periods a fact may go unused, having had the chance to
# fire, before the brief asks about it. Three is a quarter: long enough that a
# quiet month or a late close doesn't trigger it, short enough that a rule
# which stopped being true is caught inside a reporting cycle.
STALE_AFTER_PERIODS = 3

# A fact needs a track record before its silence means anything. One that has
# never fired may simply be new — the close it was learned in is often the only
# one it has seen.
MIN_HISTORY_TO_JUDGE = 1

_KIND_LABEL = {
    "gl_accuracy_exception": "Confirmed classifications",
    "variance_expectation":  "Expected movements",
    "vendor_schedule":       "Schedule setups",
    "offset_account":        "Offset conventions",
    "recon_recurring_item":  "Recurring reconciling items",
}

# What each kind is asked when it goes quiet. Phrased as a question, because
# the product does not know that the fact is wrong — only that it stopped
# being needed, which has innocent explanations.
_STALE_QUESTION = {
    "gl_accuracy_exception": "this vendor hasn't appeared in {n} closes — still expected?",
    "variance_expectation":  "this movement hasn't matched in {n} closes — has the pattern changed?",
    "vendor_schedule":       "no schedule has used this setup in {n} closes — still current?",
    "offset_account":        "no entry has used this offset in {n} closes — still right?",
    "recon_recurring_item":  "this item hasn't recurred in {n} closes — still expected?",
}


@dataclass(frozen=True)
class FactUse:
    """One fact's firing record, as the staleness rule needs to see it."""
    fact_id: uuid.UUID
    kind: str
    title: str
    confirmed_at: datetime | None
    periods_fired: frozenset[date]


def is_stale(
    use: FactUse,
    *,
    closed_periods: list[date],
    stale_after: int = STALE_AFTER_PERIODS,
) -> bool:
    """Has this fact had a clear chance to fire and not taken it?

    `closed_periods` is the run of periods the workspace has actually closed,
    oldest first — the fact's OPPORTUNITIES. Only closes that happened after
    the fact was confirmed count: a fact cannot be blamed for silence in months
    that predate it.

    Deliberately conservative, in three ways, because a false "this looks
    stale" on a correct rule is worse than a late one on a wrong rule — the
    first teaches people to dismiss the card without reading it.

      * Age alone never counts. A rule for an annual insurance renewal is
        eleven months idle and perfectly correct; only a missed OPPORTUNITY
        counts against it.
      * A fact with too little history is left alone. The close it was learned
        in is frequently the only one it has seen.
      * The run must be unbroken and recent. A fact that fired last month is
        not stale however long it slept before that.

    Pure, so the judgement can be tested without a database — and so this
    module can be argued with rather than trusted.
    """
    since = [
        p for p in closed_periods
        if use.confirmed_at is None or p >= use.confirmed_at.date()
    ]
    if len(since) < stale_after + MIN_HISTORY_TO_JUDGE:
        return False          # not enough chances yet to read anything into silence
    recent = since[-stale_after:]
    return not any(p in use.periods_fired for p in recent)


def stale_reason(use: FactUse, *, stale_after: int = STALE_AFTER_PERIODS) -> str:
    q = _STALE_QUESTION.get(use.kind, "hasn't been used in {n} closes — still current?")
    return q.format(n=stale_after)


async def close_brief(
    db: AsyncSession, period_end: date, prior_period_end: date | None = None,
) -> dict:
    """What the client's memory brings to this close.

    `prior_period_end` is what "held last month" is measured against. Passed in
    rather than derived, because "the previous close" is the close workflow's
    idea of the calendar and not this module's to reinvent.
    """
    facts = list((await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.status == "active")
    )).scalars().all())
    if not facts:
        return {
            "period_end": period_end.isoformat(), "carried": 0,
            "by_kind": [], "reused_last_period": 0, "needs_review": [],
        }

    fact_ids = [f.id for f in facts]
    rows = (await db.execute(
        select(ClientMemoryApplication.fact_id, ClientMemoryApplication.period_end)
        .where(ClientMemoryApplication.fact_id.in_(fact_ids))
    )).all()
    fired: dict[uuid.UUID, set[date]] = {}
    for fid, pe in rows:
        fired.setdefault(fid, set()).add(pe)

    closed = await _closed_periods(db)

    by_kind: dict[str, list[ClientMemoryFact]] = {}
    needs_review: list[dict] = []
    for f in facts:
        by_kind.setdefault(f.kind, []).append(f)
        use = FactUse(
            fact_id=f.id, kind=f.kind, title=f.title,
            confirmed_at=f.confirmed_at,
            periods_fired=frozenset(fired.get(f.id, set())),
        )
        if is_stale(use, closed_periods=closed):
            needs_review.append({
                "fact_id": str(f.id), "kind": f.kind, "title": f.title,
                "reason": stale_reason(use),
                "last_fired": max(use.periods_fired).isoformat() if use.periods_fired else None,
            })

    reused = 0
    if prior_period_end is not None:
        reused = sum(1 for f in facts if prior_period_end in fired.get(f.id, set()))

    return {
        "period_end": period_end.isoformat(),
        "prior_period_end": prior_period_end.isoformat() if prior_period_end else None,
        "carried": len(facts),
        "by_kind": [
            {
                "kind": k,
                "label": _KIND_LABEL.get(k, k.replace("_", " ").capitalize()),
                "count": len(v),
                # Two is enough to make the count concrete without turning the
                # card into the inventory the /facts page already is.
                "examples": [x.title for x in v[:2]],
            }
            for k, v in sorted(by_kind.items(), key=lambda kv: -len(kv[1]))
        ],
        "reused_last_period": reused,
        "needs_review": needs_review,
    }


async def _closed_periods(db: AsyncSession) -> list[date]:
    """Every period this workspace has closed, oldest first.

    A fact's opportunities to fire. Closed periods rather than all periods: a
    month still in progress has not finished offering the chance, and counting
    it would age every fact by one the moment a new month began.
    """
    from models.closed_period import ClosedPeriod

    rows = (await db.execute(
        select(ClosedPeriod.period_end).order_by(ClosedPeriod.period_end)
    )).scalars().all()
    return list(rows)


async def reuse_count(db: AsyncSession, period_end: date) -> int:
    """How many distinct facts did something in this period. The headline."""
    return int((await db.execute(
        select(func.count(func.distinct(ClientMemoryApplication.fact_id)))
        .where(ClientMemoryApplication.period_end == period_end)
    )).scalar_one() or 0)
