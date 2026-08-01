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

import calendar
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
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
class TxnOverride:
    """A single GL transaction the preparer has allocated by hand.

    A driver is an estimate applied to a whole account. When someone has
    actually LOOKED at the transactions — this repair was to the flower room,
    that one was to the retail counter — the specific answer is better evidence
    than the estimate, and §471(c) rewards specific evidence.
    """
    qbo_txn_id: str
    amount: Decimal
    production_pct: Decimal   # 0–100, entered by a human


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


def is_effective(effective_from: Any, effective_to: Any, period_end: Any) -> bool:
    """Is an effective-dated registry row in force at period_end?

    Small, but it decides which spaces, employees and account mappings the run
    can see — so it decides the drivers, and therefore the numbers.

    It's here (and gated) because getting it subtly wrong is silent: rows stamped
    with today's date fail this check for any month that has already closed, so
    a user could complete setup and have every single thing they entered be
    invisible to the period they were setting up. Nothing errored; setup just
    did nothing. See MAP_EPOCH in setup_service for the other half of the fix.
    """
    if effective_from > period_end:
        return False
    return effective_to is None or effective_to >= period_end


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


def capitalize_with_overrides(
    gross: Decimal, driver_pct: Decimal, overrides: Sequence[TxnOverride],
) -> Decimal:
    """An account's capitalized amount when some transactions were done by hand.

    Explicit beats estimate: each reviewed transaction capitalizes at the rate
    the preparer gave it, and only the UNREVIEWED remainder falls back to the
    pool's driver.

        capitalized = Σ(txn × its own %)  +  (gross − Σ txn) × driver

    The remainder is deliberately `gross − Σ overrides` rather than a separate
    figure: it keeps the account whole, so reviewing more transactions shifts
    amounts between the two terms without ever changing the total being split.
    """
    reviewed_amount = sum((o.amount for o in overrides), ZERO)
    reviewed_capitalized = sum(
        (o.amount * o.production_pct / HUNDRED for o in overrides), ZERO,
    )
    remainder = gross - reviewed_amount
    return (reviewed_capitalized + remainder * driver_pct).quantize(
        CENT, rounding=ROUND_HALF_UP,
    )


def allocate_period(
    expenses: Sequence[ExpenseRow],
    account_pool: Mapping[str, str],
    pools: Sequence[PoolSpec],
    factors: Factors,
    txn_overrides: Mapping[str, Sequence[TxnOverride]] | None = None,
) -> AllocationResult:
    """Split every expense line into capitalized vs §280E-disallowed.

    `txn_overrides` maps a QBO account id to the transactions in it that were
    allocated by hand. An account with any override is computed exactly and
    steps OUT of its pool's largest-remainder distribution — its amount is no
    longer an apportionment of the pool, so rounding it with the pool would be
    meaningless. The rest of the pool still sums penny-exact.
    """
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
            # Accounts with hand-reviewed transactions are computed exactly and
            # step OUT of the pool's rounding pass — their amount is evidence,
            # not an apportionment of the pool.
            overrides = txn_overrides or {}
            reviewed = {i for i in idxs if overrides.get(expenses[i].qbo_account_id)}
            for i in reviewed:
                capitalized[i] = capitalize_with_overrides(
                    expenses[i].amount, pct, overrides[expenses[i].qbo_account_id],
                )

            plain = [i for i in idxs if i not in reviewed]
            if plain:
                parts = _largest_remainder([expenses[i].amount for i in plain], pct)
                # strict= — _largest_remainder returns exactly one part per line;
                # a length mismatch would silently drop an allocation.
                for i, part in zip(plain, parts, strict=True):
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

# Every capitalized expense account is mirrored by a COGS account named with
# this prefix, so "Rent" pairs with "Other COGS - Rent". Keeping the source
# account's name in the COGS account is what makes the reclass self-documenting:
# an examiner reading the trial balance can see exactly which expense each COGS
# figure came from, without opening a workpaper.
COGS_PREFIX = "Other COGS - "


def cogs_account_name(source_account_name: str) -> str:
    return f"{COGS_PREFIX}{source_account_name}"


def required_cogs_accounts(result: AllocationResult) -> list[str]:
    """The COGS accounts this run's entry needs, in posting order.

    Surfaced so the accounts can be created in QuickBooks before the CSV is
    imported — QBO's journal-entry import matches on account NAME and rejects
    the file if one doesn't exist yet.
    """
    seen: dict[str, None] = {}
    for ln in result.lines:
        if ln.capitalized == ZERO:
            continue
        seen.setdefault(cogs_account_name(ln.account_name or ln.qbo_account_id), None)
    return list(seen)


def build_reclass_entry(result: AllocationResult, *, period_end: Any) -> dict | None:
    """The monthly journal entry: Dr "Other COGS - X" / Cr X, per account.

    Each capitalized expense account is reclassed into its own mirror COGS
    account rather than into a single inventory line. That keeps the origin of
    every COGS figure visible on the face of the trial balance — "Other COGS -
    Rent" is self-evidently the inventoriable share of rent — which is the
    §471(c) story an examiner asks for.

    NOTE ON METHOD: this moves cost within the income statement (expense → COGS)
    rather than onto the balance sheet as inventory. It expenses the capitalized
    amount in the period. That's the common cannabis approach and it lines up
    with how COGS is reported on Form 1125-A, but it is NOT the same as a full
    absorption roll-forward, where cost sits in inventory until the product
    sells. The run still computes the roll-forward figures when inventory
    balances are supplied; they just aren't what this entry posts.

    Pure, and here rather than in the service, because it has a sharp edge worth
    locking behind the deploy gate: `replace_open_proposals` SILENTLY DROPS an
    unbalanced entry. A malformed JE wouldn't error — it would just never appear
    in the Adjustments queue, and nobody would know the reclass went unposted.

    The edge is negative capitalized amounts. An expense account carrying a net
    credit for the period (a vendor rebate, a reversal) gets a negative
    capitalized share; the pair is simply reversed so no negative is ever
    written into a debit or credit field, where it would normalize to zero and
    silently unbalance the entry.

    Returns None when there's nothing to post.
    """
    postable = [ln for ln in result.lines if ln.capitalized != ZERO]
    if not postable or result.capitalized_total <= ZERO:
        return None

    lines: list[dict[str, str]] = []
    for ln in postable:
        source = ln.account_name or ln.qbo_account_id
        amount = ln.capitalized
        if amount > ZERO:
            lines.append({
                "account_name": cogs_account_name(source),
                "debit": str(amount), "credit": "0.00",
            })
            lines.append({
                "account_name": source, "account_qbo_id": ln.qbo_account_id,
                "debit": "0.00", "credit": str(amount),
            })
        else:
            # Reversal: the expense account is being put back, not taken out.
            lines.append({
                "account_name": cogs_account_name(source),
                "debit": "0.00", "credit": str(-amount),
            })
            lines.append({
                "account_name": source, "account_qbo_id": ln.qbo_account_id,
                "debit": str(-amount), "credit": "0.00",
            })

    # description/memo are ASCII on purpose: they land in the QuickBooks import
    # CSV and then in QBO's own memo field. "Section 471(c)" reads identically to
    # "§471(c)" and can't be mangled by a spreadsheet or an importer guessing at
    # the encoding. The rationale below is UI-only and never exported, so it
    # keeps the typographic form.
    return {
        "description": f"Section 471(c) cost reclass to COGS - {period_end}",
        "lines": lines,
        "memo": "Reclass production-related costs to COGS per the Section 471(c) allocation.",
        "rationale": (
            f"Direct production {result.direct_total} plus allocated overhead "
            f"{result.allocated_total} reclassed to COGS; "
            f"{result.disallowed_total} remains non-production and is disallowed "
            "under §280E. Each expense account is mirrored by an "
            "'Other COGS - …' account so the origin of every COGS figure stays "
            "visible. See the allocation workpaper for the drivers applied."
        ),
        "confidence": "high",
    }


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

# The §448(c) threshold is indexed annually. These are the figures we believe to
# be correct, but the value that matters is the one for the client's tax year and
# it MUST be confirmed each year against the current revenue procedure — an
# out-of-date threshold silently changes who qualifies. `alloc_settings`
# carries a per-client override for exactly that reason, and the UI states which
# figure was used rather than hiding it.
GROSS_RECEIPTS_THRESHOLDS: dict[int, Decimal] = {
    2022: Decimal("27000000"),
    2023: Decimal("29000000"),
    2024: Decimal("30000000"),
    2025: Decimal("31000000"),
}


def threshold_for_year(tax_year: int) -> tuple[Decimal, bool]:
    """(threshold, is_confirmed) for a tax year.

    An unknown year falls back to the latest figure we hold and returns
    is_confirmed=False, so the caller can say so plainly instead of presenting a
    guess as settled. Never silently invents an indexed amount.
    """
    if tax_year in GROSS_RECEIPTS_THRESHOLDS:
        return GROSS_RECEIPTS_THRESHOLDS[tax_year], True
    latest = max(GROSS_RECEIPTS_THRESHOLDS)
    return GROSS_RECEIPTS_THRESHOLDS[latest], False


def aggregate_gross_receipts(
    rows: Sequence[Mapping[str, Any]], tax_year: int,
) -> list[Decimal]:
    """Combine per-entity receipts into one figure per prior year.

    §448(c)(2) applies the aggregation rules of §52(a)/(b) and §414(m)/(o), so
    commonly controlled entities are tested TOGETHER. A cannabis group with a
    cultivation LLC, a retail LLC and a management company is three entities
    that each pass alone and can fail combined — testing the client in isolation
    is the error this exists to prevent.

    `rows` are {entity, year, amount}. Returns the three years preceding
    `tax_year`, oldest first, with missing years omitted rather than assumed to
    be zero: a zero would drag the average down and manufacture eligibility.
    """
    wanted = [tax_year - 3, tax_year - 2, tax_year - 1]
    by_year: dict[int, Decimal] = {}
    for r in rows:
        year = int(r["year"])
        if year not in wanted:
            continue
        by_year[year] = by_year.get(year, ZERO) + Decimal(str(r["amount"]))
    return [by_year[y] for y in wanted if y in by_year]


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


# ── Year end ──────────────────────────────────────────────────────────────────

def fiscal_year_bounds(tax_year: int, fiscal_year_end: str | None) -> tuple[date, date]:
    """First and last day of a client's tax year.

    `fiscal_year_end` is "MM-DD" as stored on alloc_settings; None or unparseable
    means the calendar year, which is what nearly every cannabis client uses.

    A June year end means tax year 2025 runs 2024-07-01 → 2025-06-30, so the
    START is in the PRIOR calendar year. Getting that backwards would roll up
    twelve real months belonging to the wrong return.
    """
    month, day = 12, 31
    if fiscal_year_end:
        try:
            m_str, d_str = fiscal_year_end.split("-")
            m, d = int(m_str), int(d_str)
            if 1 <= m <= 12 and 1 <= d <= calendar.monthrange(tax_year, m)[1]:
                month, day = m, d
        except (ValueError, TypeError):
            pass  # keep the calendar year rather than fail the roll-up
    end = date(tax_year, month, day)
    # Twelve months back, then one day forward: 2025-06-30 → 2024-07-01.
    start_month = month + 1
    start_year = tax_year - 1
    if start_month > 12:
        start_month, start_year = 1, tax_year
    return date(start_year, start_month, 1), end


def tax_year_for(period_end: date, fiscal_year_end: str | None) -> int:
    """Which tax year a month belongs to.

    Only interesting off the calendar year: with a June year end, September 2024
    is part of tax year 2025. Filing it under 2024 would put the month on a
    return that was already signed.
    """
    candidate = period_end.year
    if period_end > fiscal_year_bounds(candidate, fiscal_year_end)[1]:
        return candidate + 1
    return candidate


# How often a client's allocation is actually performed. Most cannabis clients
# run monthly alongside the close, but a smaller book is often done once, after
# year end, straight onto the return. Both are legitimate under §471(c) — what
# is NOT legitimate is a workpaper that claims twelve periods when one was done,
# or an annual figure that reports eleven months missing when none are.
FREQUENCIES = frozenset({"monthly", "annual"})


def normalize_frequency(frequency: str | None) -> str:
    """Unknown or absent reads as monthly — the majority case and the safer one:
    a monthly client shown as annual would hide eleven missing periods."""
    return frequency if frequency in FREQUENCIES else "monthly"


def period_bounds(
    period_end: date, *, frequency: str | None = "monthly",
    fiscal_year_end: str | None = None,
) -> tuple[date, date]:
    """The (start, end) an allocation for this period actually covers.

    A monthly client's March run covers March. An ANNUAL client's run covers the
    whole fiscal year, so deriving the start as "the first of period_end's month"
    would pull one month of expense and one month of wages into a figure
    presented as the year — understating COGS by roughly eleven twelfths while
    looking entirely normal.
    """
    if normalize_frequency(frequency) == "annual":
        return fiscal_year_bounds(tax_year_for(period_end, fiscal_year_end), fiscal_year_end)
    return period_end.replace(day=1), period_end


def expected_period_ends(
    tax_year: int, fiscal_year_end: str | None, frequency: str | None = "monthly",
) -> tuple[date, ...]:
    """The period-end dates a complete tax year should contain.

    Twelve for a monthly client; ONE — the year end — for an annual client. The
    roll-up compares the runs it found against this list, so a period nobody ran
    shows up as missing instead of silently reducing the annual total.
    """
    start, end = fiscal_year_bounds(tax_year, fiscal_year_end)
    if normalize_frequency(frequency) == "annual":
        return (end,)

    out: list[date] = []
    year, month = start.year, start.month
    for _ in range(12):
        last = calendar.monthrange(year, month)[1]
        out.append(min(date(year, month, last), end))
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return tuple(out)


@dataclass(frozen=True)
class MonthlyResult:
    """One month's concluded allocation, as it feeds the annual figure."""
    period_end: Any
    total_expenses: Decimal
    capitalized: Decimal
    disallowed: Decimal
    status: str            # draft | in_review | approved | superseded
    posted: bool           # confirmed present in the client's books
    by_pool: Mapping[str, Decimal] = field(default_factory=dict)
    # The roll-forward inputs, if the month captured them. None means "not
    # entered", which is different from zero and is reported as such.
    beginning_inventory: Decimal | None = None
    ending_inventory: Decimal | None = None
    purchases: Decimal | None = None


@dataclass(frozen=True)
class AnnualRollup:
    tax_year: int
    months_expected: int
    months_present: int
    missing_periods: tuple[Any, ...]
    unapproved_periods: tuple[Any, ...]
    unposted_periods: tuple[Any, ...]
    total_expenses: Decimal
    capitalized: Decimal
    disallowed: Decimal
    by_pool: dict[str, Decimal]
    complete: bool


def roll_up_year(
    months: Sequence[MonthlyResult], tax_year: int, expected_period_ends: Sequence[Any],
) -> AnnualRollup:
    """Combine the year's monthly allocations into the figure that reaches the return.

    The arithmetic is trivial; the CONTROL is the point. An annual total that
    silently omits a month, or quietly includes one nobody approved, produces a
    wrong number on a filed return and looks entirely reasonable doing it. So
    the roll-up reports what it is made of — which periods are missing, which
    were never approved, and which were never confirmed in the client's books —
    and only calls itself complete when all three lists are empty.

    Superseded runs are excluded outright: they are prior versions, and adding
    them would double count.
    """
    live = [m for m in months if m.status != "superseded"]
    present = {m.period_end for m in live}

    missing = tuple(p for p in expected_period_ends if p not in present)
    unapproved = tuple(m.period_end for m in live if m.status != "approved")
    unposted = tuple(m.period_end for m in live if not m.posted)

    by_pool: dict[str, Decimal] = {}
    for m in live:
        for pool, amount in m.by_pool.items():
            by_pool[pool] = by_pool.get(pool, ZERO) + amount

    return AnnualRollup(
        tax_year=tax_year,
        months_expected=len(expected_period_ends),
        months_present=len(live),
        missing_periods=missing,
        unapproved_periods=unapproved,
        unposted_periods=unposted,
        total_expenses=sum((m.total_expenses for m in live), ZERO),
        capitalized=sum((m.capitalized for m in live), ZERO),
        disallowed=sum((m.disallowed for m in live), ZERO),
        by_pool=by_pool,
        complete=not (missing or unapproved or unposted),
    )


@dataclass(frozen=True)
class InventoryBreak:
    """A month whose opening inventory doesn't pick up where the last one left off."""
    period_end: Any
    prior_period_end: Any
    prior_ending: Decimal
    beginning: Decimal

    @property
    def difference(self) -> Decimal:
        return self.beginning - self.prior_ending


def check_inventory_continuity(months: Sequence[MonthlyResult]) -> tuple[InventoryBreak, ...]:
    """Each month must open where the previous one closed.

    The annual COGS figure is beginning + capitalized + purchases − ending, taking
    beginning from the FIRST month and ending from the LAST. That arithmetic is
    only true if the months form an unbroken chain. If March closed at 410,000 and
    April opened at 380,000, the missing 30,000 never appears in any total — the
    annual number is simply wrong, and nothing else in the workpaper says so.

    Only ADJACENT months are compared, and only when both sides were captured.
    A month that never recorded inventory breaks the chain rather than being read
    as zero — not entered is not the same as nil, and reaching past it to an
    earlier month would report a break whose real cause is the gap. The gap
    itself is reported separately.
    """
    ordered = sorted(
        (m for m in months if m.status != "superseded"), key=lambda m: m.period_end,
    )
    breaks: list[InventoryBreak] = []
    prior = None
    for m in ordered:
        if (
            prior is not None
            and prior.ending_inventory is not None
            and m.beginning_inventory is not None
            and m.beginning_inventory != prior.ending_inventory
        ):
            breaks.append(InventoryBreak(
                period_end=m.period_end,
                prior_period_end=prior.period_end,
                prior_ending=prior.ending_inventory,
                beginning=m.beginning_inventory,
            ))
        prior = m
    return tuple(breaks)


@dataclass(frozen=True)
class Form1125A:
    """Form 1125-A, Cost of Goods Sold.

    Line 4 (additional §263A costs) is deliberately absent: §280E denies §263A
    to a cannabis business, which is the reason §471(c) is being used at all.
    Presenting a line for it would invite an entry that contradicts the method.
    """
    line_1_beginning_inventory: Decimal
    line_2_purchases: Decimal
    line_3_cost_of_labor: Decimal
    line_5_other_costs: Decimal
    line_6_total: Decimal
    line_7_ending_inventory: Decimal
    line_8_cogs: Decimal


def build_form_1125a(
    *,
    beginning_inventory: Decimal,
    purchases: Decimal,
    labor_capitalized: Decimal,
    other_capitalized: Decimal,
    ending_inventory: Decimal,
) -> Form1125A:
    """Lay the year's capitalized cost onto Form 1125-A.

    The split between line 3 (cost of labor) and line 5 (other costs) can't be
    derived from the account map — a direct-production pool holds nutrients as
    well as wages — so the caller supplies it from an explicit pool-to-line
    assignment. Anything not assigned to labor lands in other costs, which is
    the neutral answer rather than a guess.

    Line 6 is the sum of 1, 2, 3 and 5; line 8 is 6 less 7. Both are computed
    here rather than passed in, so the form can't be internally inconsistent.
    """
    total = beginning_inventory + purchases + labor_capitalized + other_capitalized
    return Form1125A(
        line_1_beginning_inventory=beginning_inventory,
        line_2_purchases=purchases,
        line_3_cost_of_labor=labor_capitalized,
        line_5_other_costs=other_capitalized,
        line_6_total=total,
        line_7_ending_inventory=ending_inventory,
        line_8_cogs=total - ending_inventory,
    )
