"""Parsing QuickBooks' ProfitAndLoss into the Insights figures.

This is the file that decides what "Revenue" means on the Insights page for a
custom window. It got that wrong in two ways at once, and the two together
produce exactly the screen that was reported: revenue understated by a factor of
eight, and an 89% net margin.

  * The walk RECURSED and ASSIGNED. QBO nests sub-accounts as Sections that can
    repeat their parent's `group`, so the last nested subtotal met overwrote the
    section total — 772,000 of income reported as the 93,400 in one sub-group.

  * A section whose Summary amount cell is blank collapsed to zero. An Expenses
    section lost that way turns a 57% net margin into 89%, because the expenses
    simply stop existing.

Only top-level sections are read now, and a blank summary falls back to summing
the leaves. The reconciliation check is the backstop: if the parts don't tie to
QuickBooks' own net income, the page says so instead of stating a margin.
"""
from decimal import Decimal

import pytest

from modules.insights.service import _parse_pl_summary, pl_reconciliation_warning

D = Decimal


# ── Fixtures shaped like real QBO payloads ──────────────────────────────────

def data_row(name: str, acct_id: str, amount: str) -> dict:
    return {"ColData": [{"value": name, "id": acct_id}, {"value": amount}], "type": "Data"}


def section(header: str, leaves: list[dict], total: str | None,
            *, group: str | None = None, nested: dict | None = None) -> dict:
    rows = list(leaves) + ([nested] if nested else [])
    row: dict = {
        "Header": {"ColData": [{"value": header}, {"value": ""}]},
        "Rows": {"Row": rows},
        "Summary": {"ColData": [{"value": f"Total {header}"},
                                {"value": "" if total is None else total}]},
        "type": "Section",
    }
    if group:
        row["group"] = group
    return row


def report(*sections: dict) -> dict:
    return {"Rows": {"Row": list(sections)}}


def summary_only(group: str, label: str, amount: str) -> dict:
    return {"Summary": {"ColData": [{"value": label}, {"value": amount}]},
            "type": "Section", "group": group}


# ── The standard shape still parses ─────────────────────────────────────────

def _standard() -> dict:
    return report(
        section("Income", [data_row("Design income", "82", "300000.00"),
                           data_row("Product sales", "79", "193400.00")],
                "493400.00", group="Income"),
        section("Cost of Goods Sold", [data_row("Cost of sales", "80", "55000.00")],
                "55000.00", group="COGS"),
        section("Expenses", [data_row("Rent", "50", "30000.00"),
                             data_row("Payroll", "51", "125000.00")],
                "155000.00", group="Expenses"),
        section("Other Income", [data_row("Interest earned", "90", "1200.00")],
                "1200.00", group="OtherIncome"),
        section("Other Expenses", [data_row("Interest expense", "91", "4600.00")],
                "4600.00", group="OtherExpenses"),
        summary_only("NetIncome", "Net Income", "280000.00"),
    )


def test_a_standard_report_parses_every_section():
    out = _parse_pl_summary(_standard())
    assert out["revenue"]       == D("493400.00")
    assert out["cogs"]          == D("55000.00")
    assert out["opex"]          == D("155000.00")
    assert out["other_income"]  == D("1200.00")
    assert out["other_expense"] == D("4600.00")
    assert out["net_income"]    == D("280000.00")
    assert out["parse_warning"] is None


def test_expense_leaves_are_collected_without_double_counting():
    out = _parse_pl_summary(_standard())
    assert out["expense_by_account"] == {"Rent": D("30000.00"), "Payroll": D("125000.00")}
    assert sum(out["expense_by_account"].values()) == out["opex"]


def test_nested_sub_accounts_are_collected_but_not_double_counted():
    """A parent expense account with sub-accounts is a Section whose Summary
    repeats its children. Counting both would double the category."""
    auto = section("Auto", [data_row("Fuel", "55", "3000.00"),
                            data_row("Repairs", "56", "2000.00")], "5000.00")
    rep = report(
        section("Income", [data_row("Sales", "82", "100000.00")], "100000.00", group="Income"),
        section("Expenses", [data_row("Rent", "50", "10000.00")], "15000.00",
                group="Expenses", nested=auto),
    )
    out = _parse_pl_summary(rep)
    assert out["opex"] == D("15000.00")
    assert sum(out["expense_by_account"].values()) == D("15000.00")
    assert set(out["expense_by_account"]) == {"Rent", "Fuel", "Repairs"}


# ── The two reported bugs ───────────────────────────────────────────────────

def test_a_nested_section_never_overwrites_its_parents_total():
    """THE REPORTED BUG. 772,000 of income with a "Services" sub-group that
    repeats group "Income" reported the sub-group's 93,400 as revenue."""
    services = section("Services", [data_row("Consulting", "83", "93400.00")],
                       "93400.00", group="Income")
    rep = report(
        section("Income", [data_row("Design income", "82", "678600.00")],
                "772000.00", group="Income", nested=services),
    )
    assert _parse_pl_summary(rep)["revenue"] == D("772000.00")


def test_a_section_with_a_blank_summary_falls_back_to_its_leaves():
    """THE 89% MARGIN. A blank Total Expenses cell deleted the whole section,
    so revenue minus COGS became the net income."""
    rep = report(
        section("Income", [data_row("Sales", "82", "493400.00")], "493400.00", group="Income"),
        section("Cost of Goods Sold", [data_row("Cost of sales", "80", "55000.00")],
                "55000.00", group="COGS"),
        section("Expenses", [data_row("Rent", "50", "30000.00"),
                             data_row("Payroll", "51", "125000.00")],
                None, group="Expenses"),          # blank amount
    )
    out = _parse_pl_summary(rep)
    assert out["opex"] == D("155000.00")
    margin = (out["revenue"] - out["cogs"] - out["opex"]) / out["revenue"] * 100
    assert 57 < margin < 58, "expenses were lost and the margin inflated"


def test_a_section_identified_only_by_header_text_is_still_found():
    """Some company files omit `group` on the section rows."""
    rep = report(
        section("Income", [data_row("Sales", "82", "772000.00")], "772000.00"),
        section("Expenses", [data_row("Rent", "50", "40000.00")], "40000.00"),
    )
    out = _parse_pl_summary(rep)
    assert out["revenue"] == D("772000.00")
    assert out["opex"] == D("40000.00")


def test_a_genuinely_zero_section_stays_zero():
    """An explicit 0.00 is a fact and must not trigger the leaf fallback."""
    rep = report(
        section("Income", [data_row("Sales", "82", "1000.00")], "1000.00", group="Income"),
        section("Expenses", [], "0.00", group="Expenses"),
    )
    assert _parse_pl_summary(rep)["opex"] == D("0.00")


def test_an_empty_report_yields_zeros_and_no_false_warning():
    out = _parse_pl_summary({})
    assert all(out[k] == D(0) for k in
               ("revenue", "cogs", "opex", "other_income", "other_expense", "net_income"))
    assert out["parse_warning"] is None


# ── The reconciliation backstop ─────────────────────────────────────────────

def _totals(**kw) -> dict:
    base = dict.fromkeys(
        ("revenue", "cogs", "opex", "other_income", "other_expense", "net_income"), D(0))
    base.update({k: D(v) for k, v in kw.items()})
    return base


def test_sections_that_tie_out_produce_no_warning():
    assert pl_reconciliation_warning(_totals(
        revenue="493400", cogs="55000", opex="155000",
        other_income="1200", other_expense="4600", net_income="280000",
    ), net_income_found=True) is None


def test_a_lost_expense_section_is_caught():
    """The exact shape of the reported screen: opex vanished, so the derived
    figure overshoots QuickBooks' own net income by the whole section."""
    warn = pl_reconciliation_warning(_totals(
        revenue="493400", cogs="55000", opex="0", net_income="283400",
    ), net_income_found=True)
    assert warn and "didn't add up" in warn


def test_rounding_across_sections_is_tolerated():
    assert pl_reconciliation_warning(_totals(
        revenue="100000", cogs="0", opex="0", net_income="100000.75",
    ), net_income_found=True) is None


def test_a_drift_beyond_rounding_is_reported():
    assert pl_reconciliation_warning(_totals(
        revenue="100000", cogs="0", opex="0", net_income="99000",
    ), net_income_found=True) is not None


def test_a_missing_net_income_line_is_reported_not_ignored():
    """THE HOLE THIS CLOSES. The check skipped whenever net income was zero,
    which conflated "the month broke even" with "the net income line was never
    found". So the one case it exists for — a parse that lost sections — turned
    the guard off: lose Net Income along with COGS and the page renders a
    confident 100% margin and says nothing."""
    warn = pl_reconciliation_warning(
        _totals(revenue="100000", opex="40000"), net_income_found=False)
    assert warn and "could not be cross-checked" in warn


def test_a_genuine_break_even_month_is_still_checked():
    """Net income of exactly zero is a fact, and it has to tie like any other:
    revenue 100k against costs of 100k reconciles, 40k does not."""
    assert pl_reconciliation_warning(
        _totals(revenue="100000", opex="100000", net_income="0"),
        net_income_found=True) is None
    assert pl_reconciliation_warning(
        _totals(revenue="100000", opex="40000", net_income="0"),
        net_income_found=True) is not None


def test_an_empty_parse_does_not_cry_wolf():
    """Nothing parsed at all is an empty report, not a partial one. The page
    renders zeros, which reads as "no data" on its own."""
    assert pl_reconciliation_warning(_totals(), net_income_found=False) is None


@pytest.mark.parametrize("field", ["revenue", "cogs", "opex", "other_income", "other_expense"])
def test_dropping_any_single_section_is_caught(field):
    """Whichever section goes missing, the tie-out must notice."""
    full = _totals(revenue="493400", cogs="55000", opex="155000",
                   other_income="1200", other_expense="4600", net_income="280000")
    broken = dict(full)
    broken[field] = D(0)
    assert pl_reconciliation_warning(broken, net_income_found=True) is not None


# ── Two cases the mutation run showed were unguarded ────────────────────────

def test_a_section_row_carrying_its_own_coldata_is_not_counted_as_a_leaf():
    """Section rows normally carry Header, not ColData, so the `type == "Data"`
    guard looks redundant — until a payload has both, at which point the
    section's own subtotal would be added on top of the children it summarises.
    """
    auto = {
        "Header": {"ColData": [{"value": "Auto"}, {"value": ""}]},
        # A subtotal-shaped ColData on the Section row itself.
        "ColData": [{"value": "Auto"}, {"value": "5000.00"}],
        "type": "Section",
        "Rows": {"Row": [data_row("Fuel", "55", "3000.00"),
                         data_row("Repairs", "56", "2000.00")]},
        "Summary": {"ColData": [{"value": "Total Auto"}, {"value": "5000.00"}]},
    }
    rep = report(
        section("Income", [data_row("Sales", "82", "100000.00")], "100000.00", group="Income"),
        section("Expenses", [data_row("Rent", "50", "10000.00")], None,
                group="Expenses", nested=auto),
    )
    out = _parse_pl_summary(rep)
    # Rent 10,000 + Fuel 3,000 + Repairs 2,000. The Auto subtotal must not add
    # a second 5,000 on top of the children it stands for.
    assert out["opex"] == D("15000.00")
    assert "Auto" not in out["expense_by_account"]


def test_an_explicit_summary_wins_over_the_leaves_it_disagrees_with():
    """The leaf sum is a FALLBACK for a blank cell, not a correction. When
    QuickBooks states a total, that is the figure — and if it disagrees with the
    detail, the reconciliation check is what surfaces it, not a silent reroute
    to a number QuickBooks never reported."""
    rep = report(
        section("Income", [data_row("Sales", "82", "100000.00")], "100000.00", group="Income"),
        section("Expenses", [data_row("Rent", "50", "5000.00")], "0.00", group="Expenses"),
    )
    assert _parse_pl_summary(rep)["opex"] == D("0.00")
