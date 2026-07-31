"""§471(c) allocation engine invariants — pure, deterministic, no DB.

This suite gates the deploy (`pytest -m invariant`, tagged by filename in
conftest.py). The engine decides how much of a cannabis client's expense base
becomes inventoriable cost versus what stays disallowed under §280E, so a
regression here is a wrong tax position, not a cosmetic bug.

The invariants:
  1. Every line splits exactly: gross == capitalized + disallowed
  2. The gross total is preserved end to end
  3. Each pool's capitalized amounts sum PENNY-EXACT to pool × rate
  4. direct capitalizes everything; excluded capitalizes nothing
  5. Factors are fractions in [0, 1]
  6. COGS identity: beginning + capitalized + purchases − ending
  7. Unsound inputs raise AllocationInputError — never crash, never guess
  8. Same inputs → identical output, including with negative amounts

pytest isn't installed in every env, so this also runs standalone:
    python tests/test_allocation_engine.py
"""
from decimal import Decimal

from modules.cost_allocation.engine import (
    AllocationInputError,
    ExpenseRow,
    PayrollRow,
    PoolSpec,
    SpaceRow,
    allocate_period,
    build_factors,
    build_reclass_entry,
    compute_occupancy_factor,
    compute_payroll_factor,
    evaluate_eligibility,
    resolve_driver_pct,
    roll_forward_cogs,
)

D = Decimal


# ── A representative cannabis client ──────────────────────────────────────────

SPACES = [
    SpaceRow("Flower room",   "cultivation", D("6000")),
    SpaceRow("Processing",    "processing",  D("1500")),
    SpaceRow("Dry / cure",    "curing",      D("800")),
    SpaceRow("Retail floor",  "retail",      D("2200")),
    SpaceRow("Admin office",  "office",      D("900")),
    # Shared areas must state a split explicitly — the engine won't guess.
    SpaceRow("Shared hallway", "shared",     D("600"), production_pct=D("50")),
]
# production 6000 + 1500 + 800 + 300 = 8600 ; total 12000 → 0.716667

PAYROLL = [
    PayrollRow("Grower A",  "cultivation", D("6000")),
    PayrollRow("Grower B",  "cultivation", D("5200")),
    PayrollRow("Processor", "processing",  D("4100")),
    PayrollRow("Budtender", "retail",      D("3300")),
    PayrollRow("Bookkeeper", "admin",      D("5400")),
    PayrollRow("Owner",     "management",  D("8000"), production_pct=D("60")),
]
# production 15300 + 4800 = 20100 ; total 32000 → 0.628125

POOLS = [
    PoolSpec("Direct production", "direct"),
    PoolSpec("Facility overhead", "allocated", driver="occupancy"),
    PoolSpec("Indirect labor",    "allocated", driver="payroll"),
    PoolSpec("Shared admin",      "allocated", driver="blended",
             blend_payroll_wt=D("40"), blend_occupancy_wt=D("60")),
    PoolSpec("Selling and admin", "excluded"),
]

EXPENSES = [
    ExpenseRow("5010", D("42000.00"), "5010", "Nutrients and soil"),
    ExpenseRow("5020", D("18750.50"), "5020", "Cultivation supplies"),
    ExpenseRow("6010", D("31000.01"), "6010", "Rent"),
    ExpenseRow("6020", D("9333.33"),  "6020", "Utilities"),
    ExpenseRow("6030", D("4212.57"),  "6030", "Security"),
    ExpenseRow("6110", D("15400.00"), "6110", "Management salaries"),
    ExpenseRow("6120", D("3891.11"),  "6120", "Payroll taxes"),
    ExpenseRow("6210", D("7777.77"),  "6210", "IT and software"),
    ExpenseRow("7010", D("22500.00"), "7010", "Marketing"),
    ExpenseRow("7020", D("6100.25"),  "7020", "Dispensary wages"),
]

ACCOUNT_POOL = {
    "5010": "Direct production", "5020": "Direct production",
    "6010": "Facility overhead", "6020": "Facility overhead", "6030": "Facility overhead",
    "6110": "Indirect labor",    "6120": "Indirect labor",
    "6210": "Shared admin",
    "7010": "Selling and admin", "7020": "Selling and admin",
}

CENT = D("0.01")


def _run():
    factors = build_factors(POOLS, spaces=SPACES, payroll=PAYROLL)
    return factors, allocate_period(EXPENSES, ACCOUNT_POOL, POOLS, factors)


# ── 5. Factors are fractions in [0, 1] ────────────────────────────────────────

def test_factors_are_fractions_in_range():
    occ, occ_basis = compute_occupancy_factor(SPACES)
    pay, pay_basis = compute_payroll_factor(PAYROLL)

    assert occ == D("0.716667"), occ
    assert pay == D("0.628125"), pay
    for f in (occ, pay):
        assert D(0) <= f <= D(1), f

    # The basis is the workpaper's audit trail — numerator and denominator.
    assert occ_basis["production_sqft"] == "8600" and occ_basis["total_sqft"] == "12000"
    assert pay_basis["production_wages"] == "20100" and pay_basis["total_wages"] == "32000"

    # Blended sits between its two inputs and respects the weights.
    factors = build_factors(POOLS, spaces=SPACES, payroll=PAYROLL)
    blended = resolve_driver_pct(POOLS[3], factors)
    assert blended == D("0.681250"), blended
    assert min(occ, pay) <= blended <= max(occ, pay)


# ── 1 & 2. Line splits exactly; gross preserved ───────────────────────────────

def test_every_line_splits_to_gross_and_total_is_preserved():
    _, result = _run()

    for line in result.lines:
        assert line.gross == line.capitalized + line.disallowed, line

    assert result.total_expenses == sum(e.amount for e in EXPENSES)
    assert result.capitalized_total + result.disallowed_total == result.total_expenses
    assert result.capitalized_total == result.direct_total + result.allocated_total
    assert len(result.lines) == len(EXPENSES)


# ── 4. Treatments behave ──────────────────────────────────────────────────────

def test_direct_capitalizes_all_and_excluded_capitalizes_nothing():
    _, result = _run()

    direct = [ln for ln in result.lines if ln.treatment == "direct"]
    excluded = [ln for ln in result.lines if ln.treatment == "excluded"]
    assert direct and excluded

    for ln in direct:
        assert ln.capitalized == ln.gross and ln.disallowed == D(0), ln
    for ln in excluded:
        # §280E — none of this reduces taxable income.
        assert ln.capitalized == D(0) and ln.disallowed == ln.gross, ln

    assert result.direct_total == D("42000.00") + D("18750.50")


# ── 3. Penny-exact pool totals (largest remainder) ────────────────────────────

def test_pool_totals_are_penny_exact():
    _, result = _run()

    by_pool: dict[str, list] = {}
    for ln in result.lines:
        by_pool.setdefault(ln.pool_name, []).append(ln)

    for pool_name, lines in by_pool.items():
        if lines[0].treatment != "allocated":
            continue
        pool_gross = sum(ln.gross for ln in lines)
        pct = lines[0].driver_pct
        expected = (pool_gross * pct).quantize(CENT)
        actual = sum(ln.capitalized for ln in lines)
        assert actual == expected, f"{pool_name}: {actual} != {expected}"


def test_largest_remainder_beats_naive_rounding():
    """The case naive per-line rounding gets wrong.

    Three equal lines at a one-third rate: rounding each line independently
    yields 33.33 × 3 = 99.99 and loses a cent against the pool total of 100.00.
    Largest remainder gives that cent to one line, so the workpaper ties.
    """
    pools = [PoolSpec("Thirds", "allocated", driver="fixed", fixed_pct=D("33.3333"))]
    expenses = [ExpenseRow(str(i), D("100.00")) for i in (1, 2, 3)]
    mapping = {str(i): "Thirds" for i in (1, 2, 3)}
    factors = build_factors(pools)

    result = allocate_period(expenses, mapping, pools, factors)
    amounts = sorted(ln.capitalized for ln in result.lines)

    assert sum(amounts) == D("100.00"), amounts
    assert amounts == [D("33.33"), D("33.33"), D("33.34")], amounts
    # Naive rounding would have leaked a cent.
    assert sum(amounts) != D("33.33") * 3


# ── 6. COGS identity ──────────────────────────────────────────────────────────

def test_cogs_roll_forward_identity():
    _, result = _run()
    cogs = roll_forward_cogs(
        beginning_inventory=D("120000.00"),
        capitalized=result.capitalized_total,
        purchases=D("15000.00"),
        ending_inventory=D("138000.00"),
    )
    assert (
        cogs.beginning_inventory + cogs.capitalized + cogs.purchases
        - cogs.ending_inventory == cogs.cogs
    )
    # Ending inventory above the additions draws COGS down, and vice versa.
    higher_ending = roll_forward_cogs(D("120000.00"), result.capitalized_total, D("15000.00"), D("150000.00"))
    assert higher_ending.cogs < cogs.cogs


# ── 7. Unsound inputs block loudly ────────────────────────────────────────────

def test_unsound_inputs_raise_rather_than_guess():
    factors = build_factors(POOLS, spaces=SPACES, payroll=PAYROLL)

    # An unmapped expense account must never be silently defaulted.
    try:
        allocate_period(
            [*EXPENSES, ExpenseRow("9999", D("500.00"), "9999", "Mystery")],
            ACCOUNT_POOL, POOLS, factors,
        )
        raise AssertionError("unmapped account should have blocked the run")
    except AllocationInputError as exc:
        assert "9999" in str(exc)

    # Zero denominators are a blocked run, NOT a ZeroDivisionError.
    for bad in ([], [SpaceRow("Empty", "office", D("0"))]):
        try:
            compute_occupancy_factor(bad)
            raise AssertionError("empty occupancy should have blocked")
        except AllocationInputError:
            pass
    for bad_pay in ([], [PayrollRow("Unpaid", "admin", D("0"))]):
        try:
            compute_payroll_factor(bad_pay)
            raise AssertionError("empty payroll should have blocked")
        except AllocationInputError:
            pass

    # Blend weights that don't sum to 100 are rejected.
    bad_blend = PoolSpec("Bad", "allocated", driver="blended",
                         blend_payroll_wt=D("30"), blend_occupancy_wt=D("30"))
    try:
        resolve_driver_pct(bad_blend, factors)
        raise AssertionError("blend weights summing to 60 should have blocked")
    except AllocationInputError:
        pass

    # A client using only occupancy pools must NOT be blocked for want of payroll.
    occ_only = [PoolSpec("Facility", "allocated", driver="occupancy")]
    ok = build_factors(occ_only, spaces=SPACES)
    assert ok.occupancy is not None and ok.payroll is None


# ── 8. Determinism, including negative amounts ────────────────────────────────

def test_deterministic_and_negative_amount_safe():
    a_factors, a = _run()
    b_factors, b = _run()
    assert a == b and a_factors == b_factors

    # Credits / reversals / contra accounts still split exactly and tie to the
    # pool total — ROUND_FLOOR keeps remainders positive regardless of sign.
    pools = [PoolSpec("Facility", "allocated", driver="fixed", fixed_pct=D("33.3333"))]
    expenses = [
        ExpenseRow("1", D("100.01")),
        ExpenseRow("2", D("-33.33")),   # vendor credit
        ExpenseRow("3", D("0.00")),
    ]
    mapping = {"1": "Facility", "2": "Facility", "3": "Facility"}
    result = allocate_period(expenses, mapping, pools, build_factors(pools))

    pool_gross = sum(e.amount for e in expenses)
    pct = result.lines[0].driver_pct
    assert sum(ln.capitalized for ln in result.lines) == (pool_gross * pct).quantize(CENT)
    for ln in result.lines:
        assert ln.gross == ln.capitalized + ln.disallowed, ln


# ── Eligibility gate ──────────────────────────────────────────────────────────

def test_eligibility_gate_blocks_above_threshold_and_picks_the_prong():
    threshold = D("31000000")

    over = evaluate_eligibility([D("30000000"), D("34000000"), D("35000000")], threshold, has_afs=False)
    assert over.eligible is False and over.method is None
    assert "threshold" in (over.reason or "")

    under = evaluate_eligibility([D("8000000"), D("9500000"), D("11000000")], threshold, has_afs=False)
    assert under.eligible is True and under.method == "books_records"
    assert under.gross_receipts_3yr_avg == D("9500000.00"), under.gross_receipts_3yr_avg

    # An AFS pushes the client onto the conformity prong instead.
    with_afs = evaluate_eligibility([D("8000000")], threshold, has_afs=True)
    assert with_afs.eligible is True and with_afs.method == "afs"

    # Only the most recent three years count.
    long_history = evaluate_eligibility(
        [D("1"), D("1"), D("9000000"), D("9000000"), D("9000000")], threshold, has_afs=False,
    )
    assert long_history.gross_receipts_3yr_avg == D("9000000.00")


# ── The reclass journal entry must balance ────────────────────────────────────

def _sums(entry):
    dr = sum(D(ln["debit"]) for ln in entry["lines"])
    cr = sum(D(ln["credit"]) for ln in entry["lines"])
    return dr, cr


def test_reclass_entry_balances_including_negative_amounts():
    """An unbalanced entry is SILENTLY DROPPED by replace_open_proposals.

    That's the reason this is a gating test rather than a nicety: a malformed
    entry wouldn't raise, it would just never reach the Adjustments queue and
    the capitalization would quietly go unposted.
    """
    _, result = _run()
    entry = build_reclass_entry(
        result, inventory_account_id="1300",
        inventory_account_name="Inventory", period_end="2026-03-31",
    )
    assert entry is not None
    dr, cr = _sums(entry)
    assert dr == cr, (dr, cr)
    # The single debit is the whole capitalized amount.
    assert D(entry["lines"][0]["debit"]) == result.capitalized_total
    # Only accounts that actually capitalized appear.
    assert len(entry["lines"]) == 1 + len([ln for ln in result.lines if ln.capitalized != D(0)])

    # The sharp edge: an expense account with a net CREDIT for the period gets a
    # negative capitalized share. Written as a negative credit it would be
    # normalized to zero downstream and unbalance the entry, so it must appear
    # as a positive debit instead.
    pools = [PoolSpec("Facility", "allocated", driver="fixed", fixed_pct=D("50"))]
    expenses = [ExpenseRow("6010", D("1000.00"), "6010", "Rent"),
                ExpenseRow("6020", D("-200.00"), "6020", "Utility rebate")]
    mapping = {"6010": "Facility", "6020": "Facility"}
    mixed = allocate_period(expenses, mapping, pools, build_factors(pools))

    entry2 = build_reclass_entry(
        mixed, inventory_account_id="1300",
        inventory_account_name="Inventory", period_end="2026-03-31",
    )
    assert entry2 is not None
    dr2, cr2 = _sums(entry2)
    assert dr2 == cr2, (dr2, cr2)
    # No negative amount is ever written into a debit or credit field.
    for ln in entry2["lines"]:
        assert D(ln["debit"]) >= D(0) and D(ln["credit"]) >= D(0), ln
    # The rebate landed on the debit side.
    rebate = [ln for ln in entry2["lines"] if ln["account_qbo_id"] == "6020"][0]
    assert D(rebate["debit"]) == D("100.00") and D(rebate["credit"]) == D("0.00")

    # Nothing capitalized → nothing to post.
    excluded_only = [PoolSpec("Selling", "excluded")]
    nothing = allocate_period(
        [ExpenseRow("7010", D("5000.00"))], {"7010": "Selling"},
        excluded_only, build_factors(excluded_only),
    )
    assert build_reclass_entry(
        nothing, inventory_account_id="1300",
        inventory_account_name="Inventory", period_end="2026-03-31",
    ) is None


if __name__ == "__main__":
    test_factors_are_fractions_in_range()
    test_every_line_splits_to_gross_and_total_is_preserved()
    test_direct_capitalizes_all_and_excluded_capitalizes_nothing()
    test_pool_totals_are_penny_exact()
    test_largest_remainder_beats_naive_rounding()
    test_cogs_roll_forward_identity()
    test_unsound_inputs_raise_rather_than_guess()
    test_deterministic_and_negative_amount_safe()
    test_eligibility_gate_blocks_above_threshold_and_picks_the_prong()
    test_reclass_entry_balances_including_negative_amounts()
    print("ALLOCATION_ENGINE_OK")
