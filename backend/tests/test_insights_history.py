"""Insights history charts: a month's activity, or an honest gap.

Snapshots store income-statement accounts YEAR-TO-DATE, so one month is
`YTD(this) − YTD(previous)`. Three things break that subtraction, and each one
used to reach the chart as a confident number:

  * the oldest plotted month had nothing before it to subtract, so it returned
    its raw year-to-date — nine months of revenue drawn as "Sep", which then
    rescaled the axis and flattened every real month beside it;
  * a month with no snapshot summed to 0 and, once the prior was subtracted,
    plotted NEGATIVE;
  * the month AFTER an unsynced one absorbed the whole year before it.

None is the answer in all three cases. The caller renders a gap.
"""
from datetime import date
from decimal import Decimal
from itertools import pairwise

import pytest

from modules.insights.service import month_activity

D = Decimal


# ── The normal case ─────────────────────────────────────────────────────────

def test_a_month_is_its_ytd_minus_the_previous_months():
    assert month_activity(
        pe=date(2026, 3, 31), ytd_current=D("300000"),
        prior_pe=date(2026, 2, 28), ytd_prior=D("200000"),
    ) == D("100000")


def test_january_needs_no_prior_because_its_ytd_is_the_month():
    assert month_activity(
        pe=date(2026, 1, 31), ytd_current=D("100000"),
        prior_pe=None, ytd_prior=None,
    ) == D("100000")


def test_january_ignores_a_prior_even_when_one_is_supplied():
    """December belongs to the previous fiscal year; subtracting it would wipe
    out January entirely."""
    assert month_activity(
        pe=date(2026, 1, 31), ytd_current=D("100000"),
        prior_pe=date(2025, 12, 31), ytd_prior=D("1200000"),
    ) == D("100000")


def test_a_genuine_zero_month_is_reported_as_zero_not_as_a_gap():
    """No revenue in March is a fact and must plot at zero."""
    assert month_activity(
        pe=date(2026, 3, 31), ytd_current=D("200000"),
        prior_pe=date(2026, 2, 28), ytd_prior=D("200000"),
    ) == D("0")


def test_a_negative_month_is_preserved():
    """Refunds or a reversing entry can genuinely make a month negative —
    that is data, not the missing-prior artefact."""
    assert month_activity(
        pe=date(2026, 3, 31), ytd_current=D("180000"),
        prior_pe=date(2026, 2, 28), ytd_prior=D("200000"),
    ) == D("-20000")


# ── The three unknowable cases ──────────────────────────────────────────────

def test_no_prior_month_is_a_gap_not_a_year_to_date():
    """THE CHART BUG. The oldest plotted point returned its raw YTD, so a
    company billing 100k a month showed 900k for September."""
    assert month_activity(
        pe=date(2026, 9, 30), ytd_current=D("900000"),
        prior_pe=None, ytd_prior=None,
    ) is None


def test_an_unsynced_month_is_a_gap_not_a_negative_spike():
    """Its own YTD is absent. Subtracting a real prior from zero would draw a
    trough as deep as the year is long."""
    assert month_activity(
        pe=date(2026, 3, 31), ytd_current=None,
        prior_pe=date(2026, 2, 28), ytd_prior=D("200000"),
    ) is None


def test_a_month_after_an_unsynced_one_is_a_gap_not_the_whole_year():
    """February never saved, so March's YTD has nothing to be reduced by and
    would plot January+February+March as March."""
    assert month_activity(
        pe=date(2026, 3, 31), ytd_current=D("300000"),
        prior_pe=date(2026, 2, 28), ytd_prior=None,
    ) is None


def test_january_is_still_knowable_when_its_own_snapshot_is_missing_it_is_not():
    assert month_activity(
        pe=date(2026, 1, 31), ytd_current=None, prior_pe=None, ytd_prior=None,
    ) is None


# ── A full window, the way compute_overview walks it ────────────────────────

def _walk(months: list[tuple[date, Decimal | None]]) -> list[Decimal | None]:
    """Apply month_activity across an ascending window, each month's prior
    being the one before it — mirroring the basis-month scaffolding."""
    out: list[Decimal | None] = []
    for i, (pe, ytd) in enumerate(months):
        prior_pe, prior_ytd = (None, None) if i == 0 else months[i - 1]
        out.append(month_activity(
            pe=pe, ytd_current=ytd,
            prior_pe=prior_pe if prior_pe and prior_pe.year == pe.year else None,
            ytd_prior=prior_ytd if prior_pe and prior_pe.year == pe.year else None,
        ))
    return out


def test_a_steady_100k_a_month_reads_as_100k_every_month():
    """With the basis month loaded, EVERY displayed point is derivable. The
    first entry here is that basis and is not charted."""
    window = [
        (date(2026, 1, 31), D("100000")),   # basis
        (date(2026, 2, 28), D("200000")),
        (date(2026, 3, 31), D("300000")),
        (date(2026, 4, 30), D("400000")),
        (date(2026, 5, 31), D("500000")),
    ]
    assert _walk(window)[1:] == [D("100000")] * 4


def test_one_missing_month_gaps_itself_and_its_successor_only():
    """March never synced. March is a gap, April is a gap (nothing to subtract),
    and May recovers — the damage does not run to the end of the chart."""
    window = [
        (date(2026, 1, 31), D("100000")),   # basis
        (date(2026, 2, 28), D("200000")),
        (date(2026, 3, 31), None),          # unsynced
        (date(2026, 4, 30), D("400000")),
        (date(2026, 5, 31), D("500000")),
    ]
    assert _walk(window)[1:] == [D("100000"), None, None, D("100000")]


@pytest.mark.parametrize("pe", [
    date(2026, 2, 28), date(2026, 6, 30), date(2026, 9, 30), date(2026, 12, 31),
])
def test_no_non_january_month_ever_returns_a_year_to_date_without_a_prior(pe):
    """The regression guard, across the calendar. Only January may return its
    year-to-date unaided."""
    assert month_activity(
        pe=pe, ytd_current=D("999999"), prior_pe=None, ytd_prior=None,
    ) is None


# ── Cache versioning ────────────────────────────────────────────────────────
# Without this the fix above never reaches anyone: cache_is_fresh compared only
# the sync stamp, so a payload cached before the deploy stayed "fresh" and kept
# serving charts built by the superseded arithmetic.

from modules.insights.service import (  # noqa: E402
    INSIGHTS_PAYLOAD_VERSION,
    cache_is_fresh,
)


def _payload(**kw):
    return {"payload_version": INSIGHTS_PAYLOAD_VERSION,
            "source_synced_at": "2026-03-01T00:00:00+00:00", **kw}


def test_a_current_payload_on_the_same_sync_is_fresh():
    assert cache_is_fresh(_payload(), "2026-03-01T00:00:00+00:00") is True


def test_a_payload_from_an_older_version_is_stale_however_recent_the_sync():
    stale = _payload(payload_version=INSIGHTS_PAYLOAD_VERSION - 1)
    assert cache_is_fresh(stale, "2026-03-01T00:00:00+00:00") is False


def test_a_payload_with_no_version_is_stale():
    """Everything cached before versioning existed."""
    blob = {"source_synced_at": "2026-03-01T00:00:00+00:00"}
    assert cache_is_fresh(blob, "2026-03-01T00:00:00+00:00") is False


def test_the_sync_stamp_still_matters_at_the_current_version():
    assert cache_is_fresh(_payload(), "2026-03-09T00:00:00+00:00") is False


def test_compute_stamps_the_running_version_into_the_payload():
    """Guards the pairing: a version constant nothing writes would make every
    cache permanently stale and every view a full recompute."""
    import inspect

    from modules.insights import service
    src = inspect.getsource(service.compute_overview)
    assert '"payload_version": INSIGHTS_PAYLOAD_VERSION' in src


# ── The charted window starts at the books-start date ───────────────────────
# A rolling six-month lookback both truncated a company's own history and, for
# a client onboarded three months ago, invented months that never had data.

from modules.insights.service import history_window  # noqa: E402


def test_the_window_starts_at_the_books_start_month():
    w = history_window(date(2026, 5, 31), books_start=date(2024, 7, 15), max_months=36)
    assert w[0] == date(2024, 7, 31), "first point is the books-start month end"
    assert w[-1] == date(2026, 5, 31)
    assert len(w) == 23


def test_a_mid_month_books_start_resolves_to_that_months_end():
    """books_start_date is a day; the charts plot month ends."""
    w = history_window(date(2026, 3, 31), books_start=date(2026, 1, 17), max_months=36)
    assert w == [date(2026, 1, 31), date(2026, 2, 28), date(2026, 3, 31)]


def test_a_young_company_gets_only_the_months_it_has():
    """Onboarded in March, viewing May: three points, not six with three
    empty ones invented ahead of the books."""
    w = history_window(date(2026, 5, 31), books_start=date(2026, 3, 1), max_months=36)
    assert w == [date(2026, 3, 31), date(2026, 4, 30), date(2026, 5, 31)]


def test_the_first_month_alone_is_a_valid_window():
    w = history_window(date(2026, 5, 31), books_start=date(2026, 5, 1), max_months=36)
    assert w == [date(2026, 5, 31)]


def test_books_starting_after_the_period_still_yields_that_period():
    """Nonsense input must not produce an empty chart or a runaway loop."""
    w = history_window(date(2026, 5, 31), books_start=date(2027, 1, 1), max_months=36)
    assert w == [date(2026, 5, 31)]


def test_the_ceiling_bounds_a_long_history_to_the_most_recent_months():
    """Five years of books would be sixty points three pixels apart, and sixty
    months of snapshots to load."""
    w = history_window(date(2026, 5, 31), books_start=date(2021, 1, 1), max_months=36)
    assert len(w) == 36
    assert w[-1] == date(2026, 5, 31)
    assert w[0] == date(2023, 6, 30)


def test_no_books_start_falls_back_to_the_ceiling():
    """Onboarding incomplete — there is nothing better to anchor to."""
    w = history_window(date(2026, 5, 31), books_start=None, max_months=6)
    assert len(w) == 6
    assert w[-1] == date(2026, 5, 31)


def test_the_window_is_ascending_contiguous_and_never_overshoots():
    w = history_window(date(2026, 5, 31), books_start=date(2025, 2, 3), max_months=36)
    assert w == sorted(w)
    assert w[-1] == date(2026, 5, 31)
    for a, b in pairwise(w):
        assert b == _next_month_end(a), f"{a} -> {b} is not the next month"


def _next_month_end(d: date) -> date:
    import calendar
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return date(y, m, calendar.monthrange(y, m)[1])


@pytest.mark.parametrize("cap", [0, -5])
def test_a_nonsense_ceiling_still_returns_one_month(cap):
    assert history_window(date(2026, 5, 31), books_start=None, max_months=cap) == [date(2026, 5, 31)]


# ── The books-start month needs no prior ────────────────────────────────────

def test_the_books_start_month_uses_its_ytd_because_nothing_precedes_it():
    """Every other module begins at books_start too, so no earlier month exists
    or is coming — this is a boundary like January, not missing data."""
    assert month_activity(
        pe=date(2026, 7, 31), ytd_current=D("140000"),
        prior_pe=None, ytd_prior=None, is_first_period=True,
    ) == D("140000")


def test_without_that_flag_the_same_month_is_still_a_gap():
    """The flag must be the ONLY thing that opens this door — otherwise the
    year-to-date-as-a-month bug walks straight back in."""
    assert month_activity(
        pe=date(2026, 7, 31), ytd_current=D("140000"),
        prior_pe=None, ytd_prior=None,
    ) is None


def test_the_books_start_month_is_still_a_gap_when_it_never_synced():
    assert month_activity(
        pe=date(2026, 7, 31), ytd_current=None,
        prior_pe=None, ytd_prior=None, is_first_period=True,
    ) is None


def test_months_after_the_books_start_are_still_derived_normally():
    """The flag applies to one month only; August must still subtract July."""
    assert month_activity(
        pe=date(2026, 8, 31), ytd_current=D("300000"),
        prior_pe=date(2026, 7, 31), ytd_prior=D("140000"),
    ) == D("160000")


def test_a_mid_month_period_end_still_plots_whole_months():
    """The MTD preset and any custom range end on an arbitrary day. The charts
    plot MONTHS, so the window must resolve to month ends — otherwise the last
    point is labelled for a month it only partly covers, and the month-diff
    arithmetic subtracts against a date no snapshot exists for."""
    w = history_window(date(2026, 5, 15), books_start=date(2026, 2, 1), max_months=36)
    assert w == [date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30), date(2026, 5, 31)]
    assert all(d == _next_month_end(_prior(d)) for d in w[1:])


def _prior(d: date) -> date:
    y, m = (d.year - 1, 12) if d.month == 1 else (d.year, d.month - 1)
    import calendar
    return date(y, m, calendar.monthrange(y, m)[1])
