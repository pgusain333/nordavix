"""Insights must not be quietly wrong.

This gates the deploy (`pytest -m invariant`, tagged by filename in
conftest.py). Insights drives the KPIs a partner reads, the Advisory trend, and
what the Assistant answers from — a figure that is confidently wrong here is
worse than no figure at all.

Four defects are pinned, all of the same shape: a number that looked right and
wasn't, with nothing on screen or in the logs to say so.

  1. TRIAL-BALANCE RESOLUTION. A bare sub-account name is not unique.
     "Chase:Checking" and "Wells Fargo:Checking" both reduce to "Checking", and
     last-writer-wins returned one bank's balance for BOTH — overstating cash
     by the difference. An ambiguous alias must MISS, not guess.

  2. SILENT ZEROS. An unresolved balance-sheet account was stored as 0.00 with
     no warning, which reads downstream as "this account is flat". A P&L
     account absent from the TB really is zero; a bank account is not.

  3. AR / AP SOURCE. Insights preferred the A/R Aging Summary total over the
     ledger, so it disagreed with QuickBooks' Balance Sheet AND with Nordavix's
     own Financial Statements. The two figures differ for ordinary reasons
     (journal entries to A/R with no customer, unapplied credits); the ledger
     is the balance and the aging is a subledger comparison beside it.

  4. STALENESS. The whole payload is cached and nothing invalidated it, so a
     re-synced period kept serving the figures from whenever it was first
     opened. Every payload now records the sync it was computed against.

Import-light on purpose: importing `main` pulls the Clerk JWKS chain, which
needs a real publishable key — fine locally, fatal in CI.

pytest isn't installed in every env, so this also runs standalone:
    python tests/test_insights_accuracy.py
"""
from decimal import Decimal

from core.qbo_tb import lookup_balance, parse_trial_balance
from modules.insights.service import control_account_figures


def _row(name, debit="", credit="", acct_id=None):
    c0 = {"value": name}
    if acct_id:
        c0["id"] = acct_id
    return {"ColData": [c0, {"value": debit}, {"value": credit}]}


def _tb(rows):
    return parse_trial_balance({"Rows": {"Row": rows}})


# ── 1. Ambiguous names must miss, never guess ────────────────────────────────

def test_same_leaf_name_under_two_parents_does_not_resolve():
    """The cash-overstatement bug. Two banks with a child account of the same
    name: the leaf alias belongs to neither, so it must resolve to nothing."""
    tb = _tb([
        _row("Chase:Checking", "10000.00"),
        _row("Wells Fargo:Checking", "25000.00"),
    ])
    assert lookup_balance(tb, name="Checking") is None
    # The unambiguous full paths still resolve.
    assert lookup_balance(tb, name="Chase:Checking") == Decimal("10000.00")
    assert lookup_balance(tb, name="Wells Fargo:Checking") == Decimal("25000.00")


def test_a_unique_leaf_name_still_resolves():
    """Dropping ambiguous aliases must not break the ordinary case — one
    sub-account with a distinctive leaf name is still findable by it."""
    tb = _tb([_row("Chase:Payroll", "4200.00"), _row("Petty Cash", "150.00")])
    assert lookup_balance(tb, name="Payroll") == Decimal("4200.00")


def test_fully_qualified_name_is_tried_before_the_leaf():
    """QBO's Account.Name is the leaf; the TB renders the full path. Matching
    the leaf first is what let two accounts resolve to each other."""
    tb = _tb([
        _row("Chase:Checking", "10000.00"),
        _row("Wells Fargo:Checking", "25000.00"),
    ])
    got = lookup_balance(tb, name="Checking", full_name="Wells Fargo:Checking")
    assert got == Decimal("25000.00")


def test_dropping_an_ambiguous_alias_never_orphans_a_real_account():
    """Found by mutating the collision guard.

    A chart holding both "Petty Cash" and "Chase:Petty Cash" makes the leaf
    "Petty Cash" ambiguous — but that string is ALSO the standalone account's
    own rendered name. Dropping it blindly made a real account unresolvable,
    so its balance would have been stored as zero. An account's own name is
    its identity, never an alias.
    """
    # Both declaration orders, and a three-way clash — the guard must not
    # depend on which row QuickBooks happens to render first.
    for rows in (
        [_row("Petty Cash", "150.00"), _row("Chase:Petty Cash", "900.00")],
        [_row("Chase:Petty Cash", "900.00"), _row("Petty Cash", "150.00")],
        [_row("Petty Cash", "150.00"), _row("Chase:Petty Cash", "900.00"),
         _row("Amex:Petty Cash", "40.00")],
        # The hard ordering: two sub-accounts make the leaf ambiguous BEFORE
        # the standalone account of that name is seen. Its own key must
        # survive being marked ambiguous by rows that came earlier.
        [_row("Chase:Petty Cash", "900.00"), _row("Amex:Petty Cash", "40.00"),
         _row("Petty Cash", "150.00")],
    ):
        tb = _tb(rows)
        assert lookup_balance(tb, name="Petty Cash") == Decimal("150.00")
        assert lookup_balance(tb, name="Chase:Petty Cash") == Decimal("900.00")


def test_the_leaf_is_tried_last_so_a_sub_account_cannot_hijack_a_top_level_one():
    """Resolution order matters independently of the collision guard: when a
    top-level account and a sub-account share a name, the fully-qualified form
    has to win for the account that owns it."""
    tb = _tb([_row("Petty Cash", "150.00"), _row("Chase:Petty Cash", "900.00")])
    got = lookup_balance(tb, name="Petty Cash", full_name="Chase:Petty Cash")
    assert got == Decimal("900.00"), "the fully-qualified name must be tried first"


def test_account_id_wins_over_every_name():
    """When QBO supplies ids there is no ambiguity to resolve at all."""
    tb = _tb([
        _row("Chase:Checking", "10000.00", acct_id="35"),
        _row("Wells Fargo:Checking", "25000.00", acct_id="36"),
    ])
    assert lookup_balance(tb, qbo_id="35", name="Checking") == Decimal("10000.00")
    assert lookup_balance(tb, qbo_id="36", name="Checking") == Decimal("25000.00")


def test_a_missing_account_is_a_miss_not_a_zero():
    """`None` is the contract. The caller decides what a miss means — the
    resolver must never invent a balance, and must never fall back to QBO's
    CurrentBalance, which is today's value rather than the period end's."""
    tb = _tb([_row("Chase:Checking", "10000.00")])
    assert lookup_balance(tb, qbo_id="99", acct_num="1050", name="Petty Cash") is None


def test_totals_are_still_excluded_and_the_tb_still_balances():
    """Guard the parser's other job while we are in here: summary rows are not
    accounts, and a real trial balance ties."""
    tb = _tb([
        _row("Chase:Checking", "10000.00"),
        _row("Accounts Payable", "", "10000.00"),
        _row("Total", "10000.00", "10000.00"),
    ])
    assert tb["rows"] == 2, "summary rows must not be counted as accounts"
    assert tb["debit_total"] == tb["credit_total"]


# ── 2. A balance-sheet miss is recorded; a P&L miss is not ───────────────────

def test_balance_sheet_types_are_the_ones_that_must_resolve():
    """A P&L account absent from the trial balance genuinely had no activity,
    so zero is right. A bank or receivable account absent from it might be
    flat — or might be a name that failed to match — and storing zero for the
    second case is exactly how cash goes quietly wrong."""
    from core.gl_snapshot import _BALANCE_SHEET_TYPES

    for t in ("Bank", "Accounts Receivable", "Accounts Payable", "Credit Card",
              "Other Current Asset", "Fixed Asset", "Long Term Liability", "Equity"):
        assert t in _BALANCE_SHEET_TYPES, f"{t} must be treated as must-resolve"
    for t in ("Income", "Expense", "Cost of Goods Sold", "Other Income", "Other Expense"):
        assert t not in _BALANCE_SHEET_TYPES, f"{t} legitimately reads zero"


# ── 3. The ledger is the balance; the aging sits beside it ───────────────────

def test_ar_and_ap_are_summed_from_the_ledger_with_the_right_sign():
    """A/R is debit-natural and A/P credit-natural. Insights must present both
    positive, and must agree with the Balance Sheet — which means summing the
    control accounts, not reading the aging report."""
    from modules.insights.service import (
        AP_TYPES,
        AR_TYPES,
        _sum_by_types,
        _sum_by_types_presented,
    )

    class _S:
        def __init__(self, t, b):
            self.account_type, self.balance = t, Decimal(b)

    rows = [
        _S("Accounts Receivable", "5000.00"),
        _S("Accounts Payable", "-3000.00"),   # credit balance, stored signed
        _S("Bank", "12000.00"),
    ]
    assert _sum_by_types(rows, AR_TYPES) == Decimal("5000.00")
    assert _sum_by_types_presented(rows, AP_TYPES) == Decimal("3000.00")


def test_the_ledger_is_the_balance_not_the_aging_total():
    """The reported bug, as behaviour rather than a source grep.

    When the control account and its subledger disagree — which is normal —
    the balance reported is the LEDGER's. Returning the aging figure here is
    what made Insights disagree with QuickBooks' Balance Sheet.
    """
    from modules.insights.service import control_account_figures

    balance, aging, variance = control_account_figures(
        Decimal("5000.00"), Decimal("4750.00"),
    )
    assert balance == 5000.00, "the ledger balance is what Insights reports"
    assert aging == 4750.00, "the aging total is still surfaced beside it"
    assert variance == 250.00, "and the gap between them is named, not hidden"


def test_the_gap_is_reported_in_both_directions():
    balance, _, variance = control_account_figures(
        Decimal("4750.00"), Decimal("5000.00"),
    )
    assert balance == 4750.00
    assert variance == -250.00


def test_no_aging_means_no_variance_not_a_zero_variance():
    """A period that was never synced has no aging total. Reporting a variance
    of zero there would claim the subledger agrees when it was never read."""
    from modules.insights.service import control_account_figures

    balance, aging, variance = control_account_figures(Decimal("5000.00"), None)
    assert balance == 5000.00
    assert aging is None
    assert variance is None


def test_agreement_reports_a_zero_variance():
    _, _, variance = control_account_figures(Decimal("5000.00"), Decimal("5000.00"))
    assert variance == 0.0


# ── 4. A cached payload knows what it was computed from ──────────────────────

def test_a_cache_built_before_a_resync_is_not_fresh():
    """The reported bug. Open March, cache it, re-sync March from QuickBooks —
    the cached payload must no longer be served."""
    from modules.insights.service import cache_is_fresh

    cached = {"source_synced_at": "2026-04-02T09:15:00+00:00"}
    assert cache_is_fresh(cached, "2026-04-02T09:15:00+00:00") is True
    assert cache_is_fresh(cached, "2026-05-11T18:40:00+00:00") is False


def test_a_payload_with_no_stamp_is_stale():
    """Payloads cached before this fix carry no stamp. They must recompute
    once rather than be trusted forever."""
    from modules.insights.service import cache_is_fresh

    assert cache_is_fresh({"liquidity": {}}, "2026-04-02T09:15:00+00:00") is False
    assert cache_is_fresh(None, None) is False


def test_an_unsynced_period_still_caches_normally():
    """A period QuickBooks was never synced for has no sync stamp on either
    side. That is a legitimate match, not a permanent recompute loop."""
    from modules.insights.service import cache_is_fresh

    assert cache_is_fresh({"source_synced_at": None}, None) is True


def test_compute_stamps_the_payload():
    """The read-side check is worthless if the write side never stamps."""
    import inspect

    from modules.insights import service

    assert '"source_synced_at"' in inspect.getsource(service.compute_overview), (
        "compute_overview must record the sync its figures came from"
    )


if __name__ == "__main__":
    test_same_leaf_name_under_two_parents_does_not_resolve()
    test_a_unique_leaf_name_still_resolves()
    test_dropping_an_ambiguous_alias_never_orphans_a_real_account()
    test_the_leaf_is_tried_last_so_a_sub_account_cannot_hijack_a_top_level_one()
    test_fully_qualified_name_is_tried_before_the_leaf()
    test_account_id_wins_over_every_name()
    test_a_missing_account_is_a_miss_not_a_zero()
    test_totals_are_still_excluded_and_the_tb_still_balances()
    test_balance_sheet_types_are_the_ones_that_must_resolve()
    test_ar_and_ap_are_summed_from_the_ledger_with_the_right_sign()
    test_the_ledger_is_the_balance_not_the_aging_total()
    test_the_gap_is_reported_in_both_directions()
    test_no_aging_means_no_variance_not_a_zero_variance()
    test_agreement_reports_a_zero_variance()
    test_a_cache_built_before_a_resync_is_not_fresh()
    test_a_payload_with_no_stamp_is_stale()
    test_an_unsynced_period_still_caches_normally()
    test_compute_stamps_the_payload()
    print("INSIGHTS_ACCURACY_OK")
