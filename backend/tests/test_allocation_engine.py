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


# ── Transaction-level overrides beat the driver estimate ──────────────────────

def test_hand_reviewed_transactions_override_the_driver():
    """A driver is an estimate for a whole account; a reviewed transaction is
    evidence about a specific one. Explicit must win, and only the UNREVIEWED
    remainder should fall back to the driver.

    Gated because the failure is silent in the worst way: get the remainder
    wrong and the account still looks plausible, but the capitalized figure —
    and therefore the tax position — is off.
    """
    from modules.cost_allocation.engine import TxnOverride, capitalize_with_overrides

    # $10,000 account, driver says 60%. Two transactions reviewed by hand.
    overrides = [
        TxnOverride("t1", D("3000.00"), D("100")),   # all production
        TxnOverride("t2", D("1000.00"), D("0")),     # all retail
    ]
    # 3000 + 0 + (10000 − 4000) × 0.60 = 3000 + 3600 = 6600
    assert capitalize_with_overrides(D("10000.00"), D("0.60"), overrides) == D("6600.00")

    # No overrides → pure driver, unchanged behaviour.
    assert capitalize_with_overrides(D("10000.00"), D("0.60"), []) == D("6000.00")

    # Every transaction reviewed → the driver is irrelevant.
    full = [TxnOverride("t1", D("6000.00"), D("100")), TxnOverride("t2", D("4000.00"), D("25"))]
    assert capitalize_with_overrides(D("10000.00"), D("0.99"), full) == D("7000.00")

    # A partial split on one transaction.
    assert capitalize_with_overrides(
        D("1000.00"), D("0"), [TxnOverride("t1", D("1000.00"), D("42.5"))],
    ) == D("425.00")

    # End to end: the reviewed account leaves the pool's rounding pass, and the
    # rest of the pool still sums penny-exact to pool × rate.
    pools = [PoolSpec("Facility", "allocated", driver="fixed", fixed_pct=D("60"))]
    expenses = [
        ExpenseRow("6010", D("10000.00"), "6010", "Rent"),
        ExpenseRow("6020", D("3333.33"),  "6020", "Utilities"),
        ExpenseRow("6030", D("3333.33"),  "6030", "Security"),
    ]
    mapping = dict.fromkeys(("6010", "6020", "6030"), "Facility")
    result = allocate_period(
        expenses, mapping, pools, build_factors(pools), {"6010": overrides},
    )

    by_id = {ln.qbo_account_id: ln for ln in result.lines}
    assert by_id["6010"].capitalized == D("6600.00")

    plain_gross = D("3333.33") + D("3333.33")
    plain_cap = by_id["6020"].capitalized + by_id["6030"].capitalized
    assert plain_cap == (plain_gross * D("0.60")).quantize(CENT), plain_cap

    # And the whole-run identity still holds.
    for ln in result.lines:
        assert ln.gross == ln.capitalized + ln.disallowed, ln
    assert result.capitalized_total + result.disallowed_total == result.total_expenses


# ── §448(c) aggregation across commonly controlled entities ───────────────────

def test_gross_receipts_aggregate_across_entities():
    """The mistake this prevents: testing one entity of a group.

    §448(c)(2) applies §52(a)/(b) and §414(m)/(o), so commonly controlled
    entities are tested together. Cannabis groups are routinely a cultivation
    LLC plus a retail LLC plus a management company — each comfortably under the
    threshold, the group over it. Get this wrong and the client is running a
    method they don't qualify for, which invalidates every allocation built on
    it.
    """
    from modules.cost_allocation.engine import (
        aggregate_gross_receipts,
        threshold_for_year,
    )

    rows = [
        {"entity": "Cultivation LLC", "year": 2023, "amount": D("16000000")},
        {"entity": "Cultivation LLC", "year": 2024, "amount": D("17000000")},
        {"entity": "Cultivation LLC", "year": 2025, "amount": D("18000000")},
        {"entity": "Retail LLC",      "year": 2023, "amount": D("15000000")},
        {"entity": "Retail LLC",      "year": 2024, "amount": D("16000000")},
        {"entity": "Retail LLC",      "year": 2025, "amount": D("17000000")},
    ]
    years = aggregate_gross_receipts(rows, tax_year=2026)
    assert years == [D("31000000"), D("33000000"), D("35000000")], years

    threshold, confirmed = threshold_for_year(2025)
    assert threshold == D("31000000") and confirmed is True

    # Either entity alone passes comfortably — a 16M average against a 31M
    # threshold isn't remotely close…
    alone = evaluate_eligibility(
        [r["amount"] for r in rows if r["entity"] == "Retail LLC"], threshold, has_afs=False,
    )
    assert alone.eligible is True
    assert alone.gross_receipts_3yr_avg == D("16000000.00")

    # …and the group does not, at a 33M average. That's the whole point: the
    # answer flips purely on whether the entities were combined.
    combined = evaluate_eligibility(years, threshold, has_afs=False)
    assert combined.eligible is False
    assert combined.gross_receipts_3yr_avg == D("33000000.00")
    assert "threshold" in (combined.reason or "")

    # An unknown year falls back to the latest figure and says so, rather than
    # presenting an invented indexed amount as settled.
    future, confirmed_future = threshold_for_year(2031)
    assert future == D("31000000") and confirmed_future is False

    # A year with no data is OMITTED, never treated as zero — a zero would drag
    # the average down and manufacture eligibility.
    sparse = aggregate_gross_receipts(
        [{"entity": "A", "year": 2025, "amount": D("40000000")}], tax_year=2026,
    )
    assert sparse == [D("40000000")]
    assert evaluate_eligibility(sparse, threshold, has_afs=False).eligible is False


# ── Year end: the annual figure, and what it's made of ────────────────────────

def test_annual_rollup_reports_what_it_is_made_of():
    """The arithmetic is trivial; the CONTROL is the point.

    An annual total that silently omits a month, or quietly includes one nobody
    approved or posted, produces a wrong number on a filed return and looks
    entirely reasonable doing it. So the roll-up has to report its own
    composition, and only claim completeness when nothing is outstanding.
    """
    from datetime import date

    from modules.cost_allocation.engine import MonthlyResult, roll_up_year

    expected = [date(2026, m, 1) for m in range(1, 13)]

    def month(m: int, cap: str, status="approved", posted=True):
        return MonthlyResult(
            period_end=date(2026, m, 1),
            total_expenses=D("100000.00"), capitalized=D(cap),
            disallowed=D("100000.00") - D(cap),
            status=status, posted=posted,
            by_pool={"Facility overhead": D(cap)},
        )

    # A clean year.
    full = [month(m, "60000.00") for m in range(1, 13)]
    clean = roll_up_year(full, 2026, expected)
    assert clean.complete is True
    assert clean.months_present == 12 and clean.missing_periods == ()
    assert clean.capitalized == D("720000.00")
    assert clean.total_expenses == D("1200000.00")
    assert clean.capitalized + clean.disallowed == clean.total_expenses
    assert clean.by_pool["Facility overhead"] == D("720000.00")

    # A gap, an unapproved month and an unposted one — each surfaced, and any
    # one of them is enough to withhold "complete".
    messy = [month(m, "60000.00") for m in range(1, 11)]
    messy.append(month(11, "60000.00", status="draft"))
    messy.append(month(12, "60000.00", posted=False))
    del messy[4]   # May never ran

    r = roll_up_year(messy, 2026, expected)
    assert r.complete is False
    assert r.missing_periods == (date(2026, 5, 1),)
    assert r.unapproved_periods == (date(2026, 11, 1),)
    assert r.unposted_periods == (date(2026, 12, 1),)
    # The total still foots to the months that ARE there — it just isn't final.
    assert r.months_present == 11 and r.capitalized == D("660000.00")

    # Superseded runs are prior versions; including them would double count.
    with_old = [*full, month(3, "999999.00", status="superseded")]
    assert roll_up_year(with_old, 2026, expected).capitalized == D("720000.00")


def test_form_1125a_is_internally_consistent():
    """Lines 6 and 8 are computed, never passed in, so the form cannot foot to
    something other than its own components.

    Line 4 (additional §263A costs) is deliberately absent — §280E denies §263A
    to a cannabis business, which is the reason §471(c) is in play at all.
    """
    from modules.cost_allocation.engine import build_form_1125a

    f = build_form_1125a(
        beginning_inventory=D("120000.00"),
        purchases=D("15000.00"),
        labor_capitalized=D("300000.00"),
        other_capitalized=D("420000.00"),
        ending_inventory=D("138000.00"),
    )
    assert f.line_6_total == D("855000.00")
    assert (
        f.line_6_total
        == f.line_1_beginning_inventory + f.line_2_purchases
        + f.line_3_cost_of_labor + f.line_5_other_costs
    )
    assert f.line_8_cogs == f.line_6_total - f.line_7_ending_inventory
    assert f.line_8_cogs == D("717000.00")

    # Line 8 must equal the roll-forward COGS on the same inputs — the form and
    # the engine are two views of one calculation, not two calculations.
    rolled = roll_forward_cogs(
        beginning_inventory=D("120000.00"),
        capitalized=D("300000.00") + D("420000.00"),
        purchases=D("15000.00"),
        ending_inventory=D("138000.00"),
    )
    assert rolled.cogs == f.line_8_cogs

    # An unassigned split puts everything in other costs rather than guessing
    # at labor — and the total is unaffected either way.
    neutral = build_form_1125a(
        beginning_inventory=D("120000.00"), purchases=D("15000.00"),
        labor_capitalized=D("0.00"), other_capitalized=D("720000.00"),
        ending_inventory=D("138000.00"),
    )
    assert neutral.line_8_cogs == f.line_8_cogs


def test_fiscal_year_maps_months_to_the_right_return():
    """A June year end puts September 2024 on the 2025 return, not the 2024 one.

    Filing a month under the wrong tax year attaches it to a return that may
    already be signed, and leaves a hole in the one still open. Both errors are
    invisible in the monthly workpaper.
    """
    from datetime import date

    from modules.cost_allocation.engine import (
        expected_period_ends,
        fiscal_year_bounds,
        tax_year_for,
    )

    # Calendar year — the ordinary case.
    start, end = fiscal_year_bounds(2026, "12-31")
    assert (start, end) == (date(2026, 1, 1), date(2026, 12, 31))
    assert fiscal_year_bounds(2026, None) == (start, end)
    assert fiscal_year_bounds(2026, "garbage") == (start, end)
    periods = expected_period_ends(2026, "12-31")
    assert len(periods) == 12
    assert periods[0] == date(2026, 1, 31) and periods[-1] == date(2026, 12, 31)
    assert periods[1] == date(2026, 2, 28)          # not a leap year
    assert expected_period_ends(2024, "12-31")[1] == date(2024, 2, 29)   # leap

    # June year end — the start is in the PRIOR calendar year.
    start, end = fiscal_year_bounds(2025, "06-30")
    assert (start, end) == (date(2024, 7, 1), date(2025, 6, 30))
    periods = expected_period_ends(2025, "06-30")
    assert len(periods) == 12
    assert periods[0] == date(2024, 7, 31) and periods[-1] == date(2025, 6, 30)
    assert all(start <= p <= end for p in periods), periods
    assert len(set(periods)) == 12                  # no month counted twice

    # Every month lands in exactly the year that expects it.
    for fye in ("12-31", "06-30", "09-30"):
        for tax_year in (2024, 2025):
            for p in expected_period_ends(tax_year, fye):
                assert tax_year_for(p, fye) == tax_year, (fye, tax_year, p)

    assert tax_year_for(date(2024, 9, 30), "06-30") == 2025
    assert tax_year_for(date(2024, 3, 31), "06-30") == 2024
    assert tax_year_for(date(2024, 9, 30), "12-31") == 2024


def test_annual_frequency_covers_the_year_not_the_month():
    """Some clients allocate once, after year end, rather than every month.

    The distinction is arithmetic, not labelling. An annual client's run covers
    the whole fiscal year, so deriving its window as "the month of period_end"
    would pull one month of expense and one month of wages into a figure
    presented as the year — understating COGS by roughly eleven twelfths while
    looking entirely ordinary on screen.
    """
    from datetime import date

    from modules.cost_allocation.engine import (
        expected_period_ends,
        normalize_frequency,
        period_bounds,
    )

    # Monthly is the default, and anything unrecognised reads as monthly — the
    # safer direction, since a monthly client mislabelled annual would hide
    # eleven genuinely missing periods.
    for junk in (None, "", "yearly", "quarterly"):
        assert normalize_frequency(junk) == "monthly", junk
    assert normalize_frequency("annual") == "annual"

    # Monthly: the window is the month.
    assert period_bounds(date(2026, 3, 31), frequency="monthly", fiscal_year_end="12-31") == (
        date(2026, 3, 1), date(2026, 3, 31),
    )
    # Annual, calendar year: the window is the whole year, whatever month the
    # period_end happens to name.
    assert period_bounds(date(2026, 12, 31), frequency="annual", fiscal_year_end="12-31") == (
        date(2026, 1, 1), date(2026, 12, 31),
    )
    assert period_bounds(date(2026, 3, 31), frequency="annual", fiscal_year_end="12-31") == (
        date(2026, 1, 1), date(2026, 12, 31),
    )
    # Annual, June year end: the window STARTS in the prior calendar year.
    assert period_bounds(date(2025, 6, 30), frequency="annual", fiscal_year_end="06-30") == (
        date(2024, 7, 1), date(2025, 6, 30),
    )
    assert period_bounds(date(2024, 9, 30), frequency="annual", fiscal_year_end="06-30") == (
        date(2024, 7, 1), date(2025, 6, 30),
    )

    # A complete year is twelve periods monthly and ONE annually.
    assert len(expected_period_ends(2026, "12-31", "monthly")) == 12
    assert expected_period_ends(2026, "12-31", "annual") == (date(2026, 12, 31),)
    assert expected_period_ends(2025, "06-30", "annual") == (date(2025, 6, 30),)
    # Omitted argument keeps the monthly behaviour every existing caller expects.
    assert expected_period_ends(2026, "12-31") == expected_period_ends(2026, "12-31", "monthly")

    # The roll-up must call an annual client's single approved run COMPLETE.
    from modules.cost_allocation.engine import MonthlyResult, roll_up_year

    one = [MonthlyResult(
        period_end=date(2026, 12, 31), total_expenses=D("1200000.00"),
        capitalized=D("720000.00"), disallowed=D("480000.00"),
        status="approved", posted=True, by_pool={"Facility overhead": D("720000.00")},
    )]
    rollup = roll_up_year(one, 2026, expected_period_ends(2026, "12-31", "annual"))
    assert rollup.complete is True
    assert rollup.months_expected == 1 and rollup.missing_periods == ()
    assert rollup.capitalized == D("720000.00")

    # The same run judged on a monthly calendar is eleven periods short — which
    # is exactly the wrong answer this setting exists to prevent.
    wrong = roll_up_year(one, 2026, expected_period_ends(2026, "12-31", "monthly"))
    assert wrong.complete is False and len(wrong.missing_periods) == 11


def test_inventory_chain_must_not_break_across_months():
    """Each month opens where the last one closed, or the annual COGS is wrong.

    Annual COGS takes beginning from the first month and ending from the last.
    If April opens 30,000 below where March closed, that 30,000 appears in no
    total at all — and nothing else in the workpaper mentions it.
    """
    from datetime import date

    from modules.cost_allocation.engine import MonthlyResult, check_inventory_continuity

    def month(m: int, beg, end, status="approved"):
        return MonthlyResult(
            period_end=date(2026, m, 28),
            total_expenses=D("100000.00"), capitalized=D("60000.00"),
            disallowed=D("40000.00"), status=status, posted=True,
            beginning_inventory=None if beg is None else D(beg),
            ending_inventory=None if end is None else D(end),
        )

    unbroken = [
        month(1, "100000.00", "160000.00"),
        month(2, "160000.00", "205000.00"),
        month(3, "205000.00", "240000.00"),
    ]
    assert check_inventory_continuity(unbroken) == ()

    # Out of order in, in order out — the chain is period order, not input order.
    assert check_inventory_continuity(list(reversed(unbroken))) == ()

    broken = [
        month(1, "100000.00", "160000.00"),
        month(2, "130000.00", "205000.00"),   # opens 30,000 light
        month(3, "205000.00", "240000.00"),
    ]
    breaks = check_inventory_continuity(broken)
    assert len(breaks) == 1, breaks
    assert breaks[0].period_end == date(2026, 2, 28)
    assert breaks[0].prior_period_end == date(2026, 1, 28)
    assert breaks[0].prior_ending == D("160000.00")
    assert breaks[0].beginning == D("130000.00")
    assert breaks[0].difference == D("-30000.00")

    # A month that captured nothing breaks the chain rather than reading as zero:
    # comparing March against January would report a break whose real cause is
    # February's gap.
    gapped = [
        month(1, "100000.00", "160000.00"),
        month(2, None, None),
        month(3, "205000.00", "240000.00"),
    ]
    assert check_inventory_continuity(gapped) == ()

    # A superseded rerun is a prior version, not a link in the chain.
    with_superseded = [
        month(1, "100000.00", "160000.00"),
        month(2, "999999.99", "888888.88", status="superseded"),
        month(2, "160000.00", "205000.00"),
    ]
    assert check_inventory_continuity(with_superseded) == ()


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
    test_hand_reviewed_transactions_override_the_driver()
    test_gross_receipts_aggregate_across_entities()
    test_annual_rollup_reports_what_it_is_made_of()
    test_form_1125a_is_internally_consistent()
    test_fiscal_year_maps_months_to_the_right_return()
    test_annual_frequency_covers_the_year_not_the_month()
    test_inventory_chain_must_not_break_across_months()
    print("ALLOCATION_ENGINE_OK")
