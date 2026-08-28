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
