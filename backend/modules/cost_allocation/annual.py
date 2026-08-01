"""Nordavix Allocate — the year-end roll-up.

Twelve approved months become one number on a tax return. The arithmetic is
addition; the work is proving the addition is of the right things. A total that
quietly omits August, or includes a draft nobody reviewed, or opens April at a
figure March never closed at, is wrong on the return and looks entirely ordinary
in the workpaper.

So this module reports what the annual figure is MADE OF before it reports the
figure: which periods are missing, which were never approved, which were never
confirmed posted in the client's books, and where the inventory chain breaks.
`complete` is true only when there is nothing left to say.

The engine does the deciding (roll_up_year, check_inventory_continuity,
build_form_1125a); this module only fetches and shapes.
"""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.cost_allocation import (
    AllocEligibility,
    AllocPool,
    AllocRun,
    AllocRunLine,
    AllocSettings,
)
from modules.cost_allocation.engine import (
    MonthlyResult,
    build_form_1125a,
    check_inventory_continuity,
    expected_period_ends,
    fiscal_year_bounds,
    roll_forward_cogs,
    roll_up_year,
    tax_year_for,
)

ZERO = Decimal("0.00")


def _s(v: Any) -> str | None:
    return str(v) if v is not None else None


async def build_annual(
    db: AsyncSession, *, tenant_id: uuid.UUID, tax_year: int,
) -> dict:
    """Everything the year-end review needs, in one round trip.

    Superseded runs are excluded from every total but stay countable, because
    "we reran November" is part of the story of the year.
    """
    cfg = (await db.execute(select(AllocSettings))).scalars().first()
    fye = cfg.fiscal_year_end if cfg else None
    year_start, year_end = fiscal_year_bounds(tax_year, fye)
    periods = expected_period_ends(tax_year, fye)

    runs = list((await db.execute(
        select(AllocRun)
        .where(AllocRun.period_end >= year_start, AllocRun.period_end <= year_end)
        .order_by(AllocRun.period_end, AllocRun.created_at)
    )).scalars().all())

    # Per-pool and per-account capitalized cost, for the 1125-A split and the
    # annual workpaper. One query for the whole year rather than one per month.
    by_pool_per_run: dict[uuid.UUID, dict[str, Decimal]] = {}
    accounts: dict[str, dict[str, Any]] = {}
    live_ids = {r.id for r in runs if r.status != "superseded"}
    if live_ids:
        lines = (await db.execute(
            select(AllocRunLine).where(AllocRunLine.run_id.in_(live_ids))
        )).scalars().all()
        for ln in lines:
            pool_bucket = by_pool_per_run.setdefault(ln.run_id, {})
            pool_bucket[ln.pool_name] = (
                pool_bucket.get(ln.pool_name, ZERO) + (ln.capitalized_amount or ZERO)
            )
            key = ln.qbo_account_id
            acc = accounts.get(key)
            if acc is None:
                acc = accounts[key] = {
                    "qbo_account_id": key,
                    "account_number": ln.account_number,
                    "account_name": ln.account_name,
                    "pool_name": ln.pool_name,
                    "treatment": ln.treatment,
                    "gross": ZERO, "capitalized": ZERO, "disallowed": ZERO,
                }
            acc["gross"] += ln.gross_amount or ZERO
            acc["capitalized"] += ln.capitalized_amount or ZERO
            acc["disallowed"] += ln.disallowed_amount or ZERO

    months = [
        MonthlyResult(
            period_end=r.period_end,
            total_expenses=r.total_expenses or ZERO,
            capitalized=r.capitalized_total or ZERO,
            disallowed=r.disallowed_total or ZERO,
            status=r.status,
            posted=r.posted_at is not None,
            by_pool=by_pool_per_run.get(r.id, {}),
            beginning_inventory=r.beginning_inventory,
            ending_inventory=r.ending_inventory,
            purchases=r.additions_purchases,
        )
        for r in runs
    ]
    rollup = roll_up_year(months, tax_year, periods)
    breaks = check_inventory_continuity(months)

    # ── The annual roll-forward ───────────────────────────────────────────────
    # Beginning comes from the FIRST month of the year and ending from the LAST,
    # not from summing: inventory is a balance, not a flow. Purchases do sum.
    live = sorted(
        (m for m in months if m.status != "superseded"), key=lambda m: m.period_end,
    )
    beginning = live[0].beginning_inventory if live else None
    ending = live[-1].ending_inventory if live else None
    purchases = sum((m.purchases for m in live if m.purchases is not None), ZERO)
    missing_inventory = [
        m.period_end.isoformat() for m in live
        if m.beginning_inventory is None or m.ending_inventory is None
    ]

    cogs = None
    if beginning is not None and ending is not None:
        cogs = roll_forward_cogs(beginning, rollup.capitalized, purchases, ending)

    # ── Form 1125-A ───────────────────────────────────────────────────────────
    # Which pools are cost of labor is stated on the pool, never inferred. A pool
    # that no longer exists (renamed mid-year) falls to other costs — the answer
    # that understates line 3 rather than overstating it, and line 6 is the same
    # either way, so the total on the return is unaffected.
    pools = (await db.execute(select(AllocPool))).scalars().all()
    labor_pools = {p.name for p in pools if (p.form_1125a_line or "other") == "labor"}
    labor = sum(
        (amt for name, amt in rollup.by_pool.items() if name in labor_pools), ZERO,
    )
    other = rollup.capitalized - labor
    form = build_form_1125a(
        beginning_inventory=beginning if beginning is not None else ZERO,
        purchases=purchases,
        labor_capitalized=labor,
        other_capitalized=other,
        ending_inventory=ending if ending is not None else ZERO,
    )

    # ── The §448(c) conclusion for this year ──────────────────────────────────
    elig = (await db.execute(
        select(AllocEligibility).where(AllocEligibility.tax_year == tax_year)
    )).scalars().first()

    return {
        "tax_year": tax_year,
        "fiscal_year_end": fye,
        "year_start": year_start.isoformat(),
        "year_end": year_end.isoformat(),
        "expected_periods": [p.isoformat() for p in periods],
        "complete": rollup.complete and not breaks and not missing_inventory,
        "checklist": {
            "months_expected": rollup.months_expected,
            "months_present": rollup.months_present,
            "missing_periods": [p.isoformat() for p in rollup.missing_periods],
            "unapproved_periods": [p.isoformat() for p in rollup.unapproved_periods],
            "unposted_periods": [p.isoformat() for p in rollup.unposted_periods],
            "inventory_breaks": [{
                "period_end": b.period_end.isoformat(),
                "prior_period_end": b.prior_period_end.isoformat(),
                "prior_ending": _s(b.prior_ending),
                "beginning": _s(b.beginning),
                "difference": _s(b.difference),
            } for b in breaks],
            "periods_missing_inventory": missing_inventory,
            "eligibility_concluded": elig is not None,
            "eligible": elig.eligible if elig else None,
        },
        "totals": {
            "total_expenses": _s(rollup.total_expenses),
            "capitalized": _s(rollup.capitalized),
            "disallowed": _s(rollup.disallowed),
        },
        "by_pool": [
            {"pool_name": name, "capitalized": _s(amount),
             "form_1125a_line": "labor" if name in labor_pools else "other"}
            for name, amount in sorted(rollup.by_pool.items())
        ],
        "by_account": sorted(
            ({**a, "gross": _s(a["gross"]), "capitalized": _s(a["capitalized"]),
              "disallowed": _s(a["disallowed"])} for a in accounts.values()),
            key=lambda a: (a["pool_name"], a["account_number"] or "", a["account_name"] or ""),
        ),
        "months": [{
            "period_end": m.period_end.isoformat(),
            "status": m.status,
            "posted": m.posted,
            "total_expenses": _s(m.total_expenses),
            "capitalized": _s(m.capitalized),
            "disallowed": _s(m.disallowed),
            "beginning_inventory": _s(m.beginning_inventory),
            "ending_inventory": _s(m.ending_inventory),
            "purchases": _s(m.purchases),
        } for m in sorted(months, key=lambda m: m.period_end)],
        "roll_forward": None if cogs is None else {
            "beginning_inventory": _s(cogs.beginning_inventory),
            "capitalized": _s(cogs.capitalized),
            "purchases": _s(cogs.purchases),
            "ending_inventory": _s(cogs.ending_inventory),
            "cogs": _s(cogs.cogs),
        },
        "form_1125a": {
            "line_1_beginning_inventory": _s(form.line_1_beginning_inventory),
            "line_2_purchases": _s(form.line_2_purchases),
            "line_3_cost_of_labor": _s(form.line_3_cost_of_labor),
            "line_5_other_costs": _s(form.line_5_other_costs),
            "line_6_total": _s(form.line_6_total),
            "line_7_ending_inventory": _s(form.line_7_ending_inventory),
            "line_8_cogs": _s(form.line_8_cogs),
            # Stated rather than left to be noticed: the form is only as good as
            # the roll-up behind it.
            "based_on_complete_year": rollup.complete and not breaks and not missing_inventory,
        },
    }


def available_tax_years(
    period_ends: list[date], today: date, fiscal_year_end: str | None,
) -> list[int]:
    """Years worth offering in the picker — those with runs, plus the current one.

    Mapped through the fiscal calendar, so a June-year-end client sees September
    2024 offered under 2025 and not under a return that is already filed.
    """
    years = {tax_year_for(d, fiscal_year_end) for d in period_ends}
    years.add(tax_year_for(today, fiscal_year_end))
    return sorted(years, reverse=True)
