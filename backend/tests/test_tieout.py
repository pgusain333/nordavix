"""Does Nordavix's picture match QuickBooks' own?

`statement_validation` checks that Nordavix's arithmetic is internally
consistent. It cannot catch a snapshot that missed an account or a
classification the two systems disagree about, because in both cases the
figures are internally perfect and externally wrong.

`compare` is the other question. Its failure mode is the dangerous one: a
comparison that reports agreement it did not actually make would be the single
most trust-destroying output in the product, because "ties to QuickBooks" is
the one line a CPA would take at face value.
"""
from decimal import Decimal

import pytest

from modules.financials.tieout import TIE_TOLERANCE, compare

# A real client's figures. Note that `balance_sheet_total` equals `assets` —
# that is what balancing MEANS, and it is what QuickBooks reports on both
# lines. `liabilities_equity` is the same figure minus current-year earnings,
# which is a different question and belongs to the adjustments rail.
FULL = {
    "assets": Decimal("763301"), "balance_sheet_total": Decimal("763301"),
    "revenue": Decimal("772710"), "cogs": Decimal("0"),
    "opex": Decimal("83996"), "net_income": Decimal("688713"),
}


def test_the_two_sides_of_the_balance_sheet_are_compared_like_for_like():
    """THE BUG THIS SHIPPED WITH, pinned so it cannot come back.

    QuickBooks' "Total Liabilities and Equity" INCLUDES current-year net
    income — which is why it reports the same number on both balance-sheet
    lines. Nordavix's `liabilities_equity` deliberately EXCLUDES it, because
    the adjustments rail is built on the invariant that assets move by
    liabilities-and-equity plus net income.

    Comparing those two reported the client's entire year of profit as a
    discrepancy in their books, on the one screen built to catch exactly that
    kind of mismatch. The tie-out compares `balance_sheet_total` instead.
    """
    ours = {
        "assets": Decimal("763301"),
        "liabilities_equity": Decimal("74588"),        # excludes earnings
        "balance_sheet_total": Decimal("763301"),      # includes them
        "net_income": Decimal("688713"),
    }
    theirs = {"assets": Decimal("763301"), "balance_sheet_total": Decimal("763301")}
    r = compare(ours, theirs)
    bs_lines = [x for x in r["lines"] if x["source"] == "bs"]
    assert all(x["status"] == "ties" for x in bs_lines), bs_lines
    # And the line that must never be the one compared.
    assert "liabilities_equity" not in {x["key"] for x in r["lines"]}


def test_a_balance_sheet_that_does_not_balance_still_reports():
    """Narrowing what is compared must not make the check toothless — a real
    imbalance is still a real finding."""
    ours = {"assets": Decimal("763301"), "balance_sheet_total": Decimal("750000")}
    theirs = {"assets": Decimal("763301"), "balance_sheet_total": Decimal("763301")}
    assert compare(ours, theirs)["ties"] is False


def test_identical_totals_tie():
    r = compare(FULL, dict(FULL))
    assert r["ties"] is True
    assert r["differing"] == 0
    assert r["comparable"] == len(FULL)


def test_a_difference_is_named_with_its_line_and_size():
    """A verdict alone is useless — "they don't tie" sends someone hunting
    through six statements. The line, both figures and the gap make it a thing
    to investigate."""
    theirs = {**FULL, "revenue": Decimal("770000")}
    r = compare(FULL, theirs)
    assert r["ties"] is False
    assert r["differing"] == 1
    row = next(x for x in r["lines"] if x["key"] == "revenue")
    assert row["status"] == "differs"
    assert Decimal(row["difference"]) == Decimal("2710")
    assert row["nordavix"] == "772710" and row["quickbooks"] == "770000"


def test_rounding_pennies_still_ties():
    """Two systems rounding independently across hundreds of accounts differ by
    cents. A comparison that called that a failure would cry wolf every month
    and be switched off."""
    theirs = {**FULL, "assets": FULL["assets"] + Decimal("0.40")}
    assert compare(FULL, theirs)["ties"] is True


def test_a_difference_just_past_the_tolerance_is_reported():
    theirs = {**FULL, "assets": FULL["assets"] + TIE_TOLERANCE + Decimal("0.01")}
    assert compare(FULL, theirs)["ties"] is False


def test_nothing_to_compare_is_not_agreement():
    """THE ONE THAT WOULD LIE. QuickBooks unreachable, or a report that parsed
    to nothing — zero comparisons made. Reporting that as "everything ties" is
    the most confident wrong answer available, so the verdict is None and the
    UI has to say it couldn't check."""
    r = compare(FULL, {})
    assert r["ties"] is None
    assert r["comparable"] == 0
    assert all(x["status"] == "unavailable" for x in r["lines"])


def test_a_missing_line_is_unavailable_not_zero():
    """A figure QuickBooks didn't return and a figure of nought are different
    claims. Treating them alike would let an empty report agree with a real
    one on every line it happened to omit."""
    theirs = {k: v for k, v in FULL.items() if k != "cogs"}
    r = compare(FULL, theirs)
    row = next(x for x in r["lines"] if x["key"] == "cogs")
    assert row["status"] == "unavailable"
    assert row["difference"] is None and row["ties"] is None
    # The rest still compared, and the verdict reflects only those.
    assert r["comparable"] == len(FULL) - 1
    assert r["ties"] is True


def test_the_largest_difference_is_the_worst_one_not_the_last():
    theirs = {**FULL, "revenue": FULL["revenue"] - Decimal("50"),
              "opex": FULL["opex"] + Decimal("9000")}
    assert Decimal(compare(FULL, theirs)["largest_difference"]) == Decimal("9000")


def test_every_line_carries_which_statement_it_came_from():
    """A balance-sheet difference and a P&L difference send you to different
    places."""
    r = compare(FULL, dict(FULL))
    by_key = {x["key"]: x["source"] for x in r["lines"]}
    assert by_key["assets"] == "bs" and by_key["balance_sheet_total"] == "bs"
    assert by_key["revenue"] == "pl" and by_key["net_income"] == "pl"


@pytest.mark.parametrize("key", sorted(FULL))
def test_every_compared_line_is_reported_even_when_it_ties(key):
    """Silence about the lines that agree would leave a reader unsure whether
    they were checked or skipped."""
    rows = {x["key"]: x for x in compare(FULL, dict(FULL))["lines"]}
    assert rows[key]["status"] == "ties"


def test_the_tolerance_is_small_enough_to_mean_something():
    assert Decimal("0.01") <= TIE_TOLERANCE <= Decimal("5.00")
