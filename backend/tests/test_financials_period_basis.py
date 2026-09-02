"""The income statement must never print year-to-date under a range heading.

QuickBooks stores P&L accounts year-to-date, so a mid-year range built from
Nordavix's own snapshots is `YTD(end) − YTD(start − 1 day)`. With no beginning
snapshot there is nothing to subtract, and the old code passed the end balance
straight through: a January-to-March figure sitting under a "1–31 March"
heading, with the explanation as a note at the foot of the statement.

Reported as exactly that — $450K on Financials against $170K on Insights for
the same March, because Insights pulls a live ProfitAndLoss for the range and
never needed the snapshot.

A wrong figure with a footnote is still a wrong figure. The snapshot path now
returns nothing when it cannot derive the range, and the caller falls through
to the live pull — the same thing cash flow has always done without a beginning
balance.
"""
from datetime import date
from decimal import Decimal

import pytest

from modules.financials.internal import _period_pl_rows, can_derive_period

# The account types the differencing applies to, mirrored from internal._PL_TYPES.
INCOME = "Income"
BANK = "Bank"


class _Snap:
    """Stands in for a GlBalanceSnapshot row."""

    def __init__(self, qbo_id, account_type, balance):
        self.qbo_account_id = qbo_id
        self.account_number = "4000"
        self.account_name = "Sales"
        self.account_type = account_type
        self.balance = Decimal(balance)


def by_id(rows):
    return {r.qbo_account_id: r.balance for r in rows}


# ── The differencing itself ────────────────────────────────────────────────

def test_a_mid_year_range_is_end_minus_beginning():
    """March = YTD through March (450k) − YTD through February (280k)."""
    end = [_Snap("1", INCOME, "450000")]
    beg = [_Snap("1", INCOME, "280000")]
    out = _period_pl_rows(end, beg, within_one_fiscal_year=True)
    assert by_id(out)["1"] == Decimal("170000"), "the reported figure"


def test_a_january_start_uses_the_end_balance_as_is():
    """The beginning snapshot is in the PRIOR fiscal year, so year-to-date
    through March already IS January-to-March."""
    end = [_Snap("1", INCOME, "450000")]
    beg = [_Snap("1", INCOME, "1200000")]      # last year's full-year total
    out = _period_pl_rows(end, beg, within_one_fiscal_year=False)
    assert by_id(out)["1"] == Decimal("450000")


def test_balance_sheet_accounts_are_never_differenced():
    """Cash is point-in-time. Subtracting February's cash from March's would
    turn a balance into a movement."""
    end = [_Snap("2", BANK, "90000")]
    beg = [_Snap("2", BANK, "60000")]
    out = _period_pl_rows(end, beg, within_one_fiscal_year=True)
    assert by_id(out)["2"] == Decimal("90000")


def test_an_account_absent_from_the_beginning_snapshot_subtracts_nothing():
    """An income account opened in March has no February balance; its whole
    year-to-date IS its March activity."""
    out = _period_pl_rows([_Snap("3", INCOME, "12000")], [], within_one_fiscal_year=True)
    assert by_id(out)["3"] == Decimal("12000")


def test_an_empty_beginning_snapshot_with_same_year_still_differences():
    """Guard on the None-vs-empty distinction: `beg_rows=None` and `beg_rows=[]`
    must behave identically, since load_snapshot_on_or_before returns []."""
    a = _period_pl_rows([_Snap("1", INCOME, "450000")], None, within_one_fiscal_year=True)
    b = _period_pl_rows([_Snap("1", INCOME, "450000")], [], within_one_fiscal_year=True)
    assert by_id(a) == by_id(b)


# ── The refusal, which is the actual fix ───────────────────────────────────

# The REAL rule, imported — not restated. A test that reimplements the logic
# it is checking passes happily while the code it guards is broken; the
# mutation run proved exactly that before this import replaced a local copy.
can_derive_range = can_derive_period


def test_a_mid_year_range_with_no_beginning_snapshot_cannot_be_derived():
    """THE BUG. This case used to print year-to-date under a March heading."""
    assert can_derive_range(
        period_start=date(2026, 3, 1), beg_date=None, period_end=date(2026, 3, 31),
    ) is False


def test_a_mid_year_range_with_a_same_year_beginning_can_be_derived():
    assert can_derive_range(
        period_start=date(2026, 3, 1), beg_date=date(2026, 2, 28),
        period_end=date(2026, 3, 31),
    ) is True


def test_a_january_start_needs_no_beginning_snapshot():
    """Books starting 1 January are the case that already worked — year-to-date
    IS the period, so there is nothing to subtract and nothing to refuse."""
    assert can_derive_range(
        period_start=date(2026, 1, 1), beg_date=None, period_end=date(2026, 3, 31),
    ) is True


def test_a_beginning_snapshot_from_the_prior_year_does_not_count():
    """December's snapshot carries LAST year's year-to-date. Subtracting it
    from this year's would be arithmetic across a P&L reset."""
    assert can_derive_range(
        period_start=date(2026, 3, 1), beg_date=date(2025, 12, 31),
        period_end=date(2026, 3, 31),
    ) is False


@pytest.mark.parametrize("start_month", range(2, 13))
def test_every_mid_year_start_refuses_without_a_beginning(start_month):
    """Not just March. Any month but January needs something to subtract."""
    assert can_derive_range(
        period_start=date(2026, start_month, 1), beg_date=None,
        period_end=date(2026, start_month, 28),
    ) is False


def test_the_first_month_after_a_mid_year_books_start_is_the_real_world_case():
    """Books open 1 April; the seed writes review rows at 31 March but no GL
    snapshot. April is the month that cannot be derived — and with the close
    gate in place, it is very nearly the only one that ever can't."""
    assert can_derive_range(
        period_start=date(2026, 4, 1), beg_date=None, period_end=date(2026, 4, 30),
    ) is False
