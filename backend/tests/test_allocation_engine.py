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
    from modules.cost_allocation.engine import cogs_account_name, required_cogs_accounts

    _, result = _run()
    entry = build_reclass_entry(result, period_end="2026-03-31")
    assert entry is not None
    dr, cr = _sums(entry)
    assert dr == cr, (dr, cr)
    # Total debits equal the capitalized total: every account is reclassed into
    # its own mirror COGS account rather than into one inventory line.
    assert dr == result.capitalized_total, (dr, result.capitalized_total)

    # One Dr/Cr PAIR per capitalized account.
    capitalized_lines = [ln for ln in result.lines if ln.capitalized != D(0)]
    assert len(entry["lines"]) == 2 * len(capitalized_lines)

    # The debit side names the mirror account; the credit side keeps the source
    # account AND its QBO id, so the credit posts to the real account.
    rent = next(ln for ln in capitalized_lines if ln.account_name == "Rent")
    debit_line = next(
        ln for ln in entry["lines"] if ln["account_name"] == cogs_account_name("Rent")
    )
    credit_line = next(
        ln for ln in entry["lines"]
        if ln["account_name"] == "Rent" and D(ln["credit"]) > 0
    )
    assert D(debit_line["debit"]) == rent.capitalized
    assert D(credit_line["credit"]) == rent.capitalized
    assert credit_line["account_qbo_id"] == rent.qbo_account_id
    # The mirror account carries no QBO id — it may not exist there yet.
    assert not debit_line.get("account_qbo_id")

    # The accounts that must exist in QuickBooks before the CSV will import.
    needed = required_cogs_accounts(result)
    assert cogs_account_name("Rent") in needed
    assert len(needed) == len({cogs_account_name(ln.account_name) for ln in capitalized_lines})
    # Nothing disallowed leaks into COGS.
    assert cogs_account_name("Marketing") not in needed

    # The sharp edge: an expense account with a net CREDIT for the period gets a
    # negative capitalized share. Written as a negative credit it would be
    # normalized to zero downstream and unbalance the entry, so it must appear
    # as a positive debit instead.
    pools = [PoolSpec("Facility", "allocated", driver="fixed", fixed_pct=D("50"))]
    expenses = [ExpenseRow("6010", D("1000.00"), "6010", "Rent"),
                ExpenseRow("6020", D("-200.00"), "6020", "Utility rebate")]
    mapping = {"6010": "Facility", "6020": "Facility"}
    mixed = allocate_period(expenses, mapping, pools, build_factors(pools))

    entry2 = build_reclass_entry(mixed, period_end="2026-03-31")
    assert entry2 is not None
    dr2, cr2 = _sums(entry2)
    assert dr2 == cr2, (dr2, cr2)
    # No negative amount is ever written into a debit or credit field.
    for ln in entry2["lines"]:
        assert D(ln["debit"]) >= D(0) and D(ln["credit"]) >= D(0), ln
    # The rebate reverses the pair: the source account is DEBITED back, and its
    # mirror COGS account is credited — never a negative in either field.
    rebate_src = [ln for ln in entry2["lines"] if ln.get("account_qbo_id") == "6020"][0]
    assert D(rebate_src["debit"]) == D("100.00") and D(rebate_src["credit"]) == D("0.00")

    # Nothing capitalized → nothing to post.
    excluded_only = [PoolSpec("Selling", "excluded")]
    nothing = allocate_period(
        [ExpenseRow("7010", D("5000.00"))], {"7010": "Selling"},
        excluded_only, build_factors(excluded_only),
    )
    assert build_reclass_entry(nothing, period_end="2026-03-31") is None


# ── The COA template must never guess in the aggressive direction ─────────────

def test_template_defaults_to_disallowed_when_unsure():
    """The risk here is asymmetric, so the default has to lean one way.

    Over-capitalizing moves cost into inventory that §280E says should have
    stayed disallowed — the aggressive direction, and the one an examiner
    challenges. Under-capitalizing only costs deductions the preparer will
    notice. So an unmatched account must land in the excluded pool, and no
    keyword alone may produce a high-confidence capitalized mapping.
    """
    from modules.cost_allocation.templates import (
        DIRECT,
        EXCLUDED,
        FACILITY,
        suggest_pool,
    )

    # Unrecognized → excluded, and flagged for review.
    unknown = suggest_pool("Miscellaneous expense", "6999")
    assert unknown.pool_name == EXCLUDED and unknown.confidence == "low"

    # Recognizable production and facility costs still route correctly.
    assert suggest_pool("Nutrients and soil", "5010").pool_name == DIRECT
    assert suggest_pool("Building rent", "6010").pool_name == FACILITY

    # Retail-qualified costs must NOT be captured by the facility rules —
    # "dispensary rent" is selling expense, not production overhead.
    for name in ("Dispensary rent", "Retail utilities", "Storefront security"):
        assert suggest_pool(name).pool_name == EXCLUDED, name

    # No keyword alone may high-confidence something into inventory.
    for name in ("Nutrients", "Packaging", "Lab testing", "Extraction solvent"):
        s = suggest_pool(name)
        assert s.pool_name == DIRECT and s.confidence != "high", (name, s)

    # A COGS account type is a strong hint but still only a suggestion.
    typed = suggest_pool("Unlabelled production cost", "5999", "Cost of Goods Sold")
    assert typed.pool_name == DIRECT and typed.confidence == "medium"


# ── Effective dating: setup must apply to the period being set up ─────────────

def test_new_registry_rows_apply_to_a_closed_period():
    """The bug this pins: setup that silently did nothing.

    Registries are read as-of the period being worked, which is normally a month
    that has already closed. Rows were being stamped with today's date, so every
    space, employee and account mapping a user entered failed this check for the
    very period they were setting up. Readiness still said "no square footage"
    right after they'd entered it, and nothing errored.

    The fix is MAP_EPOCH (setup_service): a FIRST row is "has always been true"
    and applies to every period; only a CHANGE to something existing is dated.
    """
    from datetime import date

    from modules.cost_allocation.engine import is_effective

    period_end = date(2026, 6, 30)   # a month that has closed
    today      = date(2026, 7, 31)   # when the user is doing the setup
    epoch      = date(2000, 1, 1)    # MAP_EPOCH

    # The bug: stamped with today, invisible to the period being set up.
    assert is_effective(today, None, period_end) is False
    # The fix: a first-time row applies to that period, and to earlier ones.
    assert is_effective(epoch, None, period_end) is True
    assert is_effective(epoch, None, date(2019, 1, 31)) is True

    # A dated CHANGE applies from its own period forward, not before.
    changed_from = date(2026, 6, 1)
    assert is_effective(changed_from, None, period_end) is True
    assert is_effective(changed_from, None, date(2026, 5, 31)) is False

    # A closed row stops applying after its end date, and still applies on it.
    assert is_effective(epoch, date(2026, 5, 31), period_end) is False
    assert is_effective(epoch, date(2026, 6, 30), period_end) is True


# ── Payroll register column detection ─────────────────────────────────────────

def test_payroll_columns_detected_across_providers():
    """Every provider names the same three things differently.

    Gated because a mis-detected column is silent: read the wrong column as
    gross pay and the payroll factor shifts, changing how much cost capitalizes.
    """
    from modules.cost_allocation.payroll_parser import detect_payroll_columns, to_decimal

    adp = detect_payroll_columns(
        ["Associate ID", "Employee Name", "Gross Pay", "Employer Taxes", "Employer Benefits"],
    )
    assert adp["external_id"] == "Associate ID"
    assert adp["name"] == "Employee Name"
    assert adp["gross_wages"] == "Gross Pay"
    assert adp["employer_taxes"] == "Employer Taxes"

    gusto = detect_payroll_columns(["Employee", "Employee ID", "Gross Earnings", "Company Taxes"])
    assert gusto["name"] == "Employee"
    assert gusto["external_id"] == "Employee ID"
    assert gusto["gross_wages"] == "Gross Earnings"
    assert gusto["employer_taxes"] == "Company Taxes"

    # "Gross Pay" must win over a bare "Pay Period", and a column is claimed once.
    tricky = detect_payroll_columns(["Pay Period", "Worker", "Gross Pay", "Payroll Taxes"])
    assert tricky["gross_wages"] == "Gross Pay"
    assert tricky["name"] == "Worker"
    claimed = [v for v in tricky.values() if v]
    assert len(claimed) == len(set(claimed)), tricky

    # Missing columns resolve to None rather than grabbing something wrong.
    sparse = detect_payroll_columns(["Employee", "Gross Pay"])
    assert sparse["employer_taxes"] is None and sparse["benefits"] is None

    # Money cells as they actually arrive in exports.
    assert to_decimal("$1,234.56") == D("1234.56")
    assert to_decimal("(500.00)") == D("-500.00")
    assert to_decimal("") == D("0.00")
    assert to_decimal("—") == D("0.00")
    assert to_decimal(None) == D("0.00")
    assert to_decimal("garbage") == D("0.00")


# ── Repeated register rows must aggregate, not collide ────────────────────────

def test_repeated_employees_aggregate_into_one_row():
    """The bug behind the import's unexplained "Network Error".

    alloc_payroll_entry is UNIQUE on (tenant, employee, period). A register
    listing somebody twice — semi-monthly payroll is two runs, and some exports
    emit a row per earnings code — produced two inserts for the same key, an
    IntegrityError, and a 500 that never passed through the CORS middleware, so
    the browser showed only "Network Error".

    Aggregating is also the correct accounting: the month's wage for a person is
    the sum of that month's pay runs.
    """
    from modules.cost_allocation.payroll_parser import aggregate_rows

    rows = [
        {"name": "Jane Doe", "external_id": "E1", "department": "Cultivation", "job_title": None,
         "gross_wages": "1000.00", "employer_taxes": "100.00", "benefits": "50.00"},
        {"name": "Jane Doe", "external_id": "E1", "department": "", "job_title": None,
         "gross_wages": "1200.50", "employer_taxes": "120.00", "benefits": "50.00"},
        {"name": "Bob Ray", "external_id": "E2", "department": "Retail", "job_title": None,
         "gross_wages": "900.00", "employer_taxes": "90.00", "benefits": "0.00"},
    ]
    out = aggregate_rows(rows)
    assert len(out) == 2, out

    jane = next(r for r in out if r["external_id"] == "E1")
    assert jane["gross_wages"] == "2200.50"
    assert jane["employer_taxes"] == "220.00"
    assert jane["benefits"] == "100.00"
    assert jane["pay_runs"] == 2
    # A blank department on the second run must not erase the first.
    assert jane["department"] == "Cultivation"
    assert jane["suggested_function"] == "cultivation"

    bob = next(r for r in out if r["external_id"] == "E2")
    assert bob["pay_runs"] == 1 and bob["suggested_function"] == "retail"

    # Falls back to name when the register carries no employee id.
    no_ids = aggregate_rows([
        {"name": "Sam Lee", "external_id": None, "department": None, "job_title": None,
         "gross_wages": "500.00", "employer_taxes": "0", "benefits": "0"},
        {"name": "sam lee", "external_id": None, "department": None, "job_title": None,
         "gross_wages": "250.00", "employer_taxes": "0", "benefits": "0"},
    ])
    assert len(no_ids) == 1 and no_ids[0]["gross_wages"] == "750.00"


def test_department_drives_the_suggested_function_conservatively():
    """The register's own department is the client's books-and-records answer to
    "is this person production?" — better evidence than a preparer's judgement.

    Still conservative: ambiguous or unknown lands on shared/0%, so an
    unreviewed roster understates capitalization rather than overstating it.
    """
    from modules.cost_allocation.payroll_parser import suggest_employee_function

    assert suggest_employee_function("Cultivation", None)[:2] == ("cultivation", 100)
    assert suggest_employee_function("Post Harvest", None)[:2] == ("cultivation", 100)
    assert suggest_employee_function("Extraction Lab", None)[:2] == ("processing", 100)
    assert suggest_employee_function("Packaging", None)[:2] == ("packaging", 100)
    assert suggest_employee_function("Dispensary", None)[:2] == ("retail", 0)
    assert suggest_employee_function("Accounting", None)[:2] == ("admin", 0)

    # Department outranks title: a "Retail — Inventory Specialist" is retail.
    assert suggest_employee_function("Retail", "Production Assistant")[0] == "retail"
    # Title is used when there's no department.
    assert suggest_employee_function(None, "Head Grower")[0] == "cultivation"
    # Nothing recognizable → unclassified, never production.
    unknown = suggest_employee_function("Zone 4", "Specialist II")
    assert unknown[0] == "shared" and unknown[1] == 0
    assert suggest_employee_function(None, None)[:2] == ("shared", 0)


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
    test_template_defaults_to_disallowed_when_unsure()
    test_new_registry_rows_apply_to_a_closed_period()
    test_payroll_columns_detected_across_providers()
    test_repeated_employees_aggregate_into_one_row()
    test_department_drives_the_suggested_function_conservatively()
    print("ALLOCATION_ENGINE_OK")
