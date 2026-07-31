"""The §471(c) allocation engine — pure, deterministic, no I/O.

Everything here is a function of its arguments: no DB, no QBO, no clock. That's
deliberate. This module decides how much of a cannabis client's expense base
becomes inventoriable cost (and therefore COGS, which reduces gross receipts)
versus what stays disallowed under §280E. It IS the tax position, so it has to
be reproducible and testable in isolation — see tests/test_allocation_engine.py,
which gates the deploy via `pytest -m invariant`.

The shape of a run:

    expenses (from QBO)  ─┐
    account → pool map   ─┼─► allocate_period() ─► per-line capitalized/disallowed
    pools (per client)   ─┤
    factors (drivers)    ─┘

    beginning inventory + capitalized + purchases − ending = COGS

Two conventions that matter:

  * Human-entered percentages are 0–100 (production_pct, fixed_pct, blend
    weights). Engine factors are fractions 0–1 (Factors.payroll/.occupancy,
    AllocLine.driver_pct). Mixing them is the classic 100× error, so they are
    never named the same thing.

  * Rounding uses LARGEST REMAINDER within each pool, so the per-line amounts
    sum exactly to the pool's rounded total. Naive per-line rounding leaks cents
    and a reviewer tying the workpaper to the GL would spot it immediately.

Anything that would make a run unsound raises AllocationInputError rather than
guessing — an unmapped expense account, no square footage, no wages. A blocked
run is a visible task; a silently wrong one is a bad tax return.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal
from typing import Any

CENT = Decimal("0.01")
FACTOR_Q = Decimal("0.000001")   # matches alloc_run.payroll_factor Numeric(9, 6)
ZERO = Decimal(0)
HUNDRED = Decimal(100)

# Space functions that are production by default. `shared` is deliberately NOT
# here: a shared area must state an explicit production_pct, forcing a decision
# rather than letting the engine guess. `storage` likewise — whether a finished
# goods store is inventoriable is a judgment call, so it must be made explicitly.
PRODUCTION_SPACE_FUNCTIONS = frozenset({"cultivation", "processing", "curing", "packaging"})
PRODUCTION_EMPLOYEE_FUNCTIONS = frozenset({"cultivation", "processing", "packaging"})

TREATMENTS = frozenset({"direct", "allocated", "excluded"})
DRIVERS = frozenset({"payroll", "occupancy", "blended", "fixed"})


class AllocationInputError(ValueError):
    """A run cannot proceed on these inputs.

    Always surfaced to the user as a blocked run with a specific reason — never
    swallowed into a default, because every default here is a tax position.
    """


# ── Inputs ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SpaceRow:
    """One room/area from the occupancy registry."""
    name: str
    function: str
    square_feet: Decimal
    # 0–100 override; None = derive from `function`.
    production_pct: Decimal | None = None


@dataclass(frozen=True)
class PayrollRow:
    """One employee's period wages plus their classification.

    `wages` is whichever basis the firm elected — gross, or fully loaded with
    employer taxes and benefits. The engine doesn't care, but the choice must be
    consistent across the numerator and denominator, which it is by construction
    (both come from this same list).
    """
    employee: str
    function: str
    wages: Decimal
    production_pct: Decimal | None = None


@dataclass(frozen=True)
class PoolSpec:
    """A cost pool and its driver — configured per client."""
    name: str
    treatment: str                            # direct | allocated | excluded
    driver: str | None = None                 # payroll | occupancy | blended | fixed
    blend_payroll_wt: Decimal | None = None   # 0–100
    blend_occupancy_wt: Decimal | None = None # 0–100
    fixed_pct: Decimal | None = None          # 0–100


@dataclass(frozen=True)
class ExpenseRow:
    """One GL expense account's amount for the period."""
    qbo_account_id: str
    amount: Decimal
    account_number: str | None = None
    account_name: str | None = None


@dataclass(frozen=True)
class Factors:
    """The computed drivers, as fractions 0–1, plus their audit trail.

    `basis` is persisted verbatim onto alloc_run.driver_basis so the workpaper
    can show the numerator and denominator behind each factor years later.
    A factor is None when no pool required it.
    """
    payroll: Decimal | None
    occupancy: Decimal | None
    basis: dict[str, Any]


# ── Outputs ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AllocLine:
    qbo_account_id: str
    account_number: str | None
    account_name: str | None
    pool_name: str
    treatment: str
    driver: str | None
    driver_pct: Decimal        # fraction 0–1 actually applied
    gross: Decimal
    capitalized: Decimal
    disallowed: Decimal


@dataclass(frozen=True)
class AllocationResult:
    lines: tuple[AllocLine, ...]
    total_expenses: Decimal
    direct_total: Decimal
    allocated_total: Decimal
    capitalized_total: Decimal
    disallowed_total: Decimal


@dataclass(frozen=True)
class CogsResult:
    beginning_inventory: Decimal
    capitalized: Decimal
    purchases: Decimal
    ending_inventory: Decimal
    cogs: Decimal


@dataclass(frozen=True)
class Eligibility:
    """§448(c) small-business-taxpayer test + which §471(c) prong applies."""
    eligible: bool
    gross_receipts_3yr_avg: Decimal
    threshold: Decimal
    has_afs: bool
    method: str | None        # afs | books_records (None when ineligible)
    reason: str | None


# ── Drivers ───────────────────────────────────────────────────────────────────

def _resolve_production_pct(
    function: str, override: Decimal | None, production: frozenset[str], label: str,
) -> Decimal:
    if override is not None:
        if override < ZERO or override > HUNDRED:
            raise AllocationInputError(
                f"{label}: production_pct must be between 0 and 100, got {override}."
            )
        return override
    return HUNDRED if function in production else ZERO


def compute_occupancy_factor(spaces: Sequence[SpaceRow]) -> tuple[Decimal, dict[str, Any]]:
    """Production square footage ÷ total square footage, as a fraction 0–1."""
    total = ZERO
    production = ZERO
    for s in spaces:
        if s.square_feet < ZERO:
            raise AllocationInputError(f"Space '{s.name}': square_feet cannot be negative.")
        pct = _resolve_production_pct(
            s.function, s.production_pct, PRODUCTION_SPACE_FUNCTIONS, f"Space '{s.name}'"
        )
        total += s.square_feet
        production += s.square_feet * pct / HUNDRED

    if total <= ZERO:
        raise AllocationInputError(
            "Occupancy driver needs at least one space with square footage on file. "
            "Add the client's spaces under Setup before running an allocation."
        )
    value = (production / total).quantize(FACTOR_Q, rounding=ROUND_HALF_UP)
    return value, {
        "production_sqft": str(production),
        "total_sqft": str(total),
        "spaces": len(spaces),
    }


def compute_payroll_factor(rows: Sequence[PayrollRow]) -> tuple[Decimal, dict[str, Any]]:
    """Production wages ÷ total wages, as a fraction 0–1."""
    total = ZERO
    production = ZERO
    for r in rows:
        if r.wages < ZERO:
            raise AllocationInputError(f"Employee '{r.employee}': wages cannot be negative.")
        pct = _resolve_production_pct(
            r.function, r.production_pct, PRODUCTION_EMPLOYEE_FUNCTIONS, f"Employee '{r.employee}'"
        )
        total += r.wages
        production += r.wages * pct / HUNDRED

    if total <= ZERO:
        raise AllocationInputError(
            "Payroll driver needs wages for the period. Import the payroll register "
            "for this month before running an allocation."
        )
    value = (production / total).quantize(FACTOR_Q, rounding=ROUND_HALF_UP)
    return value, {
        "production_wages": str(production),
        "total_wages": str(total),
        "employees": len(rows),
    }


def required_base_drivers(pools: Sequence[PoolSpec]) -> frozenset[str]:
    """Which base factors these pools actually need.

    A client whose pools are all occupancy-driven shouldn't be blocked for want
    of a payroll register, so only the required factors get computed.
    """
    needed: set[str] = set()
    for p in pools:
        if p.treatment != "allocated":
            continue
        if p.driver in ("payroll", "blended"):
            needed.add("payroll")
        if p.driver in ("occupancy", "blended"):
            needed.add("occupancy")
    return frozenset(needed)


def build_factors(
    pools: Sequence[PoolSpec],
    *,
    spaces: Sequence[SpaceRow] = (),
    payroll: Sequence[PayrollRow] = (),
) -> Factors:
    """Compute exactly the drivers these pools require, with their audit trail."""
    needed = required_base_drivers(pools)
    basis: dict[str, Any] = {}
    payroll_factor: Decimal | None = None
    occupancy_factor: Decimal | None = None

    if "payroll" in needed:
        payroll_factor, basis["payroll"] = compute_payroll_factor(payroll)
    if "occupancy" in needed:
        occupancy_factor, basis["occupancy"] = compute_occupancy_factor(spaces)

    return Factors(payroll=payroll_factor, occupancy=occupancy_factor, basis=basis)


def resolve_driver_pct(pool: PoolSpec, factors: Factors) -> Decimal:
    """The fraction 0–1 this pool applies to its gross."""
    if pool.treatment == "direct":
        return Decimal(1)
    if pool.treatment == "excluded":
        return ZERO
    if pool.treatment != "allocated":
        raise AllocationInputError(f"Pool '{pool.name}': unknown treatment '{pool.treatment}'.")

    if pool.driver == "payroll":
        if factors.payroll is None:
            raise AllocationInputError(f"Pool '{pool.name}': payroll factor unavailable.")
        return factors.payroll

    if pool.driver == "occupancy":
        if factors.occupancy is None:
            raise AllocationInputError(f"Pool '{pool.name}': occupancy factor unavailable.")
        return factors.occupancy

    if pool.driver == "blended":
        if factors.payroll is None or factors.occupancy is None:
            raise AllocationInputError(f"Pool '{pool.name}': blended driver needs both factors.")
        wp, wo = pool.blend_payroll_wt, pool.blend_occupancy_wt
        if wp is None or wo is None:
            raise AllocationInputError(f"Pool '{pool.name}': blended driver needs both weights.")
        if wp + wo != HUNDRED:
            raise AllocationInputError(
                f"Pool '{pool.name}': blend weights must sum to 100, got {wp + wo}."
            )
        blended = (factors.payroll * wp + factors.occupancy * wo) / HUNDRED
        return blended.quantize(FACTOR_Q, rounding=ROUND_HALF_UP)

    if pool.driver == "fixed":
        if pool.fixed_pct is None:
            raise AllocationInputError(f"Pool '{pool.name}': fixed driver needs a rate.")
        if pool.fixed_pct < ZERO or pool.fixed_pct > HUNDRED:
            raise AllocationInputError(
                f"Pool '{pool.name}': fixed_pct must be between 0 and 100, got {pool.fixed_pct}."
            )
        return (pool.fixed_pct / HUNDRED).quantize(FACTOR_Q, rounding=ROUND_HALF_UP)

    raise AllocationInputError(f"Pool '{pool.name}': unknown driver '{pool.driver}'.")


# ── Allocation ────────────────────────────────────────────────────────────────

def _largest_remainder(
    amounts: Sequence[Decimal], pct: Decimal,
) -> list[Decimal]:
    """Apportion `pct` across `amounts` so the parts sum EXACTLY to the pool total.

    Each line gets floor(amount × pct) to the cent, then the residual cents go to
    the lines with the largest dropped fraction (ties broken by position, so the
    result is deterministic).

    ROUND_FLOOR — not ROUND_DOWN — is deliberate: it keeps every remainder in
    [0, 0.01) even for negative amounts (credits, reversals, contra accounts),
    so the same distribution logic is correct regardless of sign.
    """
    pool_gross = sum(amounts, ZERO)
    target = (pool_gross * pct).quantize(CENT, rounding=ROUND_HALF_UP)

    floors: list[Decimal] = []
    remainders: list[Decimal] = []
    for amt in amounts:
        exact = amt * pct
        fl = exact.quantize(CENT, rounding=ROUND_FLOOR)
        floors.append(fl)
        remainders.append(exact - fl)

    residual_cents = int(((target - sum(floors, ZERO)) / CENT).to_integral_value())
    # Every remainder is < 1 cent, so the residual can never exceed the line
    # count; clamp defensively rather than trusting the arithmetic blindly.
    residual_cents = max(0, min(residual_cents, len(amounts)))

    order = sorted(range(len(amounts)), key=lambda i: (-remainders[i], i))
    for i in order[:residual_cents]:
        floors[i] += CENT
    return floors


def allocate_period(
    expenses: Sequence[ExpenseRow],
    account_pool: Mapping[str, str],
    pools: Sequence[PoolSpec],
    factors: Factors,
) -> AllocationResult:
    """Split every expense line into capitalized vs §280E-disallowed."""
    pool_by_name = {p.name: p for p in pools}

    unmapped = sorted({e.qbo_account_id for e in expenses if e.qbo_account_id not in account_pool})
    if unmapped:
        raise AllocationInputError(
            f"{len(unmapped)} expense account(s) are not mapped to a cost pool "
            f"(e.g. {', '.join(unmapped[:5])}). Map them under Setup — an unmapped "
            "account cannot be silently defaulted."
        )

    missing_pools = sorted(
        {account_pool[e.qbo_account_id] for e in expenses} - set(pool_by_name)
    )
    if missing_pools:
        raise AllocationInputError(f"Unknown pool(s) referenced by the account map: {missing_pools}.")

    # Group line indexes by pool, preserving first-appearance order.
    groups: dict[str, list[int]] = {}
    for i, e in enumerate(expenses):
        groups.setdefault(account_pool[e.qbo_account_id], []).append(i)

    capitalized: list[Decimal] = [ZERO] * len(expenses)
    pct_applied: list[Decimal] = [ZERO] * len(expenses)

    for pool_name, idxs in groups.items():
        pool = pool_by_name[pool_name]
        if pool.treatment not in TREATMENTS:
            raise AllocationInputError(f"Pool '{pool.name}': unknown treatment '{pool.treatment}'.")

        pct = resolve_driver_pct(pool, factors)
        for i in idxs:
            pct_applied[i] = pct

        if pool.treatment == "direct":
            for i in idxs:
                capitalized[i] = expenses[i].amount
        elif pool.treatment == "excluded":
            pass  # stays ZERO
        else:
            parts = _largest_remainder([expenses[i].amount for i in idxs], pct)
            # strict= — _largest_remainder returns exactly one part per line;
            # a length mismatch would silently drop an allocation.
            for i, part in zip(idxs, parts, strict=True):
                capitalized[i] = part

    lines: list[AllocLine] = []
    direct_total = allocated_total = ZERO
    for i, e in enumerate(expenses):
        pool = pool_by_name[account_pool[e.qbo_account_id]]
        cap = capitalized[i]
        lines.append(AllocLine(
            qbo_account_id=e.qbo_account_id,
            account_number=e.account_number,
            account_name=e.account_name,
            pool_name=pool.name,
            treatment=pool.treatment,
            driver=pool.driver,
            driver_pct=pct_applied[i],
            gross=e.amount,
            capitalized=cap,
            disallowed=e.amount - cap,
        ))
        if pool.treatment == "direct":
            direct_total += cap
        elif pool.treatment == "allocated":
            allocated_total += cap

    total_expenses = sum((e.amount for e in expenses), ZERO)
    capitalized_total = sum((line.capitalized for line in lines), ZERO)

    return AllocationResult(
        lines=tuple(lines),
        total_expenses=total_expenses,
        direct_total=direct_total,
        allocated_total=allocated_total,
        capitalized_total=capitalized_total,
        disallowed_total=total_expenses - capitalized_total,
    )


# ── Inventory roll-forward ────────────────────────────────────────────────────

def roll_forward_cogs(
    beginning_inventory: Decimal,
    capitalized: Decimal,
    purchases: Decimal,
    ending_inventory: Decimal,
) -> CogsResult:
    """Beginning + capitalized + purchases − ending = COGS.

    The v1 inventory method: a period roll-forward rather than per-batch
    absorption. `purchases` covers directly-acquired inventoriable cost (bought
    product, packaging bought into stock) that isn't part of the allocated
    expense base, so it isn't double counted.
    """
    cogs = beginning_inventory + capitalized + purchases - ending_inventory
    return CogsResult(
        beginning_inventory=beginning_inventory,
        capitalized=capitalized,
        purchases=purchases,
        ending_inventory=ending_inventory,
        cogs=cogs,
    )


# ── Eligibility ───────────────────────────────────────────────────────────────

def evaluate_eligibility(
    prior_year_gross_receipts: Sequence[Decimal],
    threshold: Decimal,
    *,
    has_afs: bool,
) -> Eligibility:
    """§448(c) small-business-taxpayer test, and which §471(c) prong applies.

    §471(c) is open only to a small business taxpayer — three-year average gross
    receipts at or under the (annually indexed) threshold. Above it, the client
    can't use §471(c) at all and the tool must say so loudly rather than produce
    a workpaper they cannot rely on.

    Below it, the AFS status picks the prong: a client WITH an applicable
    financial statement must conform to that statement (§471(c)(1)(B)(i));
    without one, it's books and records (§471(c)(1)(B)(ii)) — the common
    cannabis case.
    """
    if not prior_year_gross_receipts:
        raise AllocationInputError(
            "The §448(c) test needs at least one prior year of gross receipts."
        )
    years = list(prior_year_gross_receipts)[-3:]
    avg = (sum(years, ZERO) / Decimal(len(years))).quantize(CENT, rounding=ROUND_HALF_UP)

    if avg > threshold:
        return Eligibility(
            eligible=False, gross_receipts_3yr_avg=avg, threshold=threshold,
            has_afs=has_afs, method=None,
            reason=(
                f"Three-year average gross receipts of {avg} exceed the §448(c) "
                f"threshold of {threshold}; the client is not a small business "
                "taxpayer and cannot use §471(c)."
            ),
        )

    return Eligibility(
        eligible=True, gross_receipts_3yr_avg=avg, threshold=threshold,
        has_afs=has_afs,
        method="afs" if has_afs else "books_records",
        reason=None,
    )
