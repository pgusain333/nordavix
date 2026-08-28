"""Flux comparison periods and the income-statement period-activity override.

Two rules live here, and both were live bugs.

1. A TrialBalance reports P&L accounts as fiscal-YTD. A monthly flux must show
   the MONTH, which means the ProfitAndLoss override has to apply to BOTH
   columns or NEITHER. Applying it to one is the worst outcome: September's
   real activity against January-to-August's, or against a confident 0.00.

2. An automated flux and a hand-made one for the same month must mean the same
   thing. Autopilot compared the same month a year earlier while the form
   defaulted to month-over-month, so "Sep 2026" was two different analyses.
"""
from datetime import date
from decimal import Decimal

import pytest

from modules.flux.service import (
    monthly_comparison_periods,
    parse_qbo_trial_balance_report,
)

# ── monthly_comparison_periods ──────────────────────────────────────────────

@pytest.mark.parametrize("pe,expected", [
    # (period_start_current, period_prior_end, period_start_prior)
    (date(2026, 9, 30),  (date(2026, 9, 1),  date(2026, 8, 31), date(2026, 8, 1))),
    (date(2026, 3, 31),  (date(2026, 3, 1),  date(2026, 2, 28), date(2026, 2, 1))),
    (date(2028, 3, 31),  (date(2028, 3, 1),  date(2028, 2, 29), date(2028, 2, 1))),  # leap
    (date(2026, 1, 31),  (date(2026, 1, 1),  date(2025, 12, 31), date(2025, 12, 1))),  # year cross
    (date(2026, 5, 31),  (date(2026, 5, 1),  date(2026, 4, 30), date(2026, 4, 1))),
])
def test_monthly_comparison_periods(pe, expected):
    assert monthly_comparison_periods(pe) == expected


def test_prior_is_the_prior_month_not_the_prior_year():
    """The autopilot bug. A year-back prior turns a monthly close into a YoY
    analysis wearing a month's name."""
    _start, prior_end, _prior_start = monthly_comparison_periods(date(2026, 9, 30))
    assert prior_end == date(2026, 8, 31)
    assert prior_end.year == 2026


def test_current_start_is_the_first_of_the_period_month():
    """Passing this to fetch_trial_balance is what stops it defaulting to Jan 1
    and reporting nine months of expense as 'September'."""
    for pe in (date(2026, 9, 30), date(2026, 9, 1), date(2026, 2, 28)):
        start, _pe, _ps = monthly_comparison_periods(pe)
        assert start.day == 1
        assert (start.year, start.month) == (pe.year, pe.month)


def test_periods_are_contiguous_and_non_overlapping():
    """The prior window must end the day before the current one starts —
    otherwise a day of activity is double-counted or dropped."""
    for month in range(1, 13):
        pe = monthly_comparison_periods(date(2026, month, 28))[0]
        pe = (pe.replace(day=28))
        start_current, prior_end, start_prior = monthly_comparison_periods(pe)
        assert prior_end < start_current
        assert (start_current - prior_end).days == 1
        assert start_prior <= prior_end


# ── The P&L override: both columns or neither ───────────────────────────────

def _tb_report(rows: list[tuple[str, str, str, str]]) -> dict:
    """Minimal QBO TrialBalance shape: (acct_id, label, debit, credit)."""
    return {"Rows": {"Row": [
        {"ColData": [{"value": label, "id": acct_id}, {"value": debit}, {"value": credit}]}
        for acct_id, label, debit, credit in rows
    ]}}


_LOOKUP = {
    "10": {"Id": "10", "Name": "Rent expense", "AcctNum": "7100", "AccountType": "Expense"},
    "20": {"Id": "20", "Name": "Consulting income", "AcctNum": "5100", "AccountType": "Income"},
    "30": {"Id": "30", "Name": "Cash", "AcctNum": "1010", "AccountType": "Bank"},
}


def _accounts(pl_current=None, pl_prior=None) -> dict[str, dict]:
    """Parse a fixed two-period TB, keyed by account number for assertions."""
    # TB figures are fiscal-YTD for P&L: 9 months of rent, 9 months of income.
    current = _tb_report([
        ("10", "7100 Rent expense",      "90000", ""),
        ("20", "5100 Consulting income", "",      "270000"),
        ("30", "1010 Cash",              "50000", ""),
    ])
    prior = _tb_report([
        ("10", "7100 Rent expense",      "80000", ""),
        ("20", "5100 Consulting income", "",      "240000"),
        ("30", "1010 Cash",              "45000", ""),
    ])
    out = parse_qbo_trial_balance_report(
        current, prior, {}, qbo_acct_lookup=_LOOKUP,
        pl_current=pl_current, pl_prior=pl_prior,
    )
    return {a["account_number"]: a for a in out}


def test_without_pl_data_both_columns_stay_trial_balance_ytd():
    """The fallback has to be symmetric: coarse but consistent beats precise
    on one side and year-to-date on the other."""
    a = _accounts()
    assert a["7100"]["current_balance"] == Decimal("90000")
    assert a["7100"]["prior_balance"]   == Decimal("80000")


def test_with_both_pl_periods_income_statement_shows_period_activity():
    a = _accounts(
        pl_current={"10": Decimal("10000"), "20": Decimal("30000")},
        pl_prior={"10": Decimal("9500"), "20": Decimal("28000")},
    )
    # Expense stays debit-positive; income flips to credit-natural negative.
    assert a["7100"]["current_balance"] == Decimal("10000")
    assert a["7100"]["prior_balance"]   == Decimal("9500")
    assert a["5100"]["current_balance"] == Decimal("-30000")
    assert a["5100"]["prior_balance"]   == Decimal("-28000")


def test_balance_sheet_accounts_are_never_overridden():
    """Cash is a point-in-time balance. The P&L report has no business
    touching it, even when it happens to carry that id."""
    a = _accounts(
        pl_current={"10": Decimal("10000"), "30": Decimal("999")},
        pl_prior={"10": Decimal("9500"), "30": Decimal("888")},
    )
    assert a["1010"]["current_balance"] == Decimal("50000")
    assert a["1010"]["prior_balance"]   == Decimal("45000")


def test_current_only_pl_never_zeroes_the_prior_column():
    """THE BUG. Gating on pl_current alone read the prior from `pl_prior or {}`,
    so a caller supplying one side turned every P&L account's prior into a
    confident 0.00 and a 100% variance. One side is not enough to override."""
    a = _accounts(pl_current={"10": Decimal("10000"), "20": Decimal("30000")})
    assert a["7100"]["prior_balance"] == Decimal("80000"), "prior was silently zeroed"
    assert a["7100"]["current_balance"] == Decimal("90000"), "columns must move together"


def test_prior_only_pl_is_equally_inert():
    a = _accounts(pl_prior={"10": Decimal("9500")})
    assert a["7100"]["current_balance"] == Decimal("90000")
    assert a["7100"]["prior_balance"]   == Decimal("80000")


def test_an_account_absent_from_both_pl_reports_drops_out():
    """YTD activity but none in either period means the row is not part of
    this month's story — it must not appear with a fabricated balance."""
    a = _accounts(pl_current={"20": Decimal("30000")}, pl_prior={"20": Decimal("28000")})
    assert "7100" not in a, "rent had no period activity and should not be listed"


def test_empty_pl_pair_is_honoured_as_genuine_zero_activity():
    """Distinct from the missing-data case, which fetch_pl_period_amounts
    screens out before the parser ever sees it: two empty dicts that reach here
    mean both periods really had no P&L activity."""
    a = _accounts(pl_current={}, pl_prior={})
    assert "7100" not in a and "5100" not in a
    assert a["1010"]["current_balance"] == Decimal("50000")


# ── fetch_pl_period_amounts: the pair, or nothing ───────────────────────────

async def _call_fetch(monkeypatch, reports: dict[str, dict] | Exception):
    """Drive fetch_pl_period_amounts with canned ProfitAndLoss responses,
    keyed by the period_start passed in."""
    import core.qbo_tb
    from modules.flux.service import fetch_pl_period_amounts

    async def fake(conn, period_end, *, period_start=None, **kw):
        if isinstance(reports, Exception):
            raise reports
        return reports[period_start.isoformat()]

    monkeypatch.setattr(core.qbo_tb, "fetch_profit_and_loss", fake, raising=False)
    return await fetch_pl_period_amounts(
        object(),
        period_current=date(2026, 9, 30), period_prior=date(2026, 8, 31),
        period_start_current=date(2026, 9, 1), period_start_prior=date(2026, 8, 1),
    )


def _pl_report(rows: dict[str, str]) -> dict:
    return {"Rows": {"Row": [
        {"ColData": [{"value": f"Account {i}", "id": i}, {"value": v}]}
        for i, v in rows.items()
    ]}}


async def test_both_periods_return_amounts(monkeypatch):
    cur, pri = await _call_fetch(monkeypatch, {
        "2026-09-01": _pl_report({"10": "10000"}),
        "2026-08-01": _pl_report({"10": "9500"}),
    })
    assert cur == {"10": Decimal("10000")}
    assert pri == {"10": Decimal("9500")}


async def test_missing_period_start_returns_neither(monkeypatch):
    from modules.flux.service import fetch_pl_period_amounts
    assert await fetch_pl_period_amounts(
        object(), period_current=date(2026, 9, 30), period_prior=date(2026, 8, 31),
        period_start_current=None, period_start_prior=date(2026, 8, 1),
    ) == (None, None)


async def test_a_qbo_failure_falls_back_for_both_not_one(monkeypatch):
    assert await _call_fetch(monkeypatch, RuntimeError("QBO 500")) == (None, None)


async def test_empty_prior_report_is_treated_as_missing_not_as_zero(monkeypatch):
    """QBO returns an empty ProfitAndLoss for a range that predates the books.
    Honouring it would zero every prior column and show a 100% variance on
    every income and expense account, with nothing saying the data was absent."""
    cur, pri = await _call_fetch(monkeypatch, {
        "2026-09-01": _pl_report({"10": "10000", "20": "30000"}),
        "2026-08-01": _pl_report({}),
    })
    assert (cur, pri) == (None, None)


async def test_both_empty_is_genuine_no_activity_and_is_honoured(monkeypatch):
    """Only the ASYMMETRIC case is suspicious. Two empty reports mean a company
    with no income-statement activity in either month — that is real."""
    cur, pri = await _call_fetch(monkeypatch, {
        "2026-09-01": _pl_report({}),
        "2026-08-01": _pl_report({}),
    })
    assert cur == {} and pri == {}
