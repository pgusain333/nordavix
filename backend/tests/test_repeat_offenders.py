"""The same thing going wrong every month is a different problem.

Risk Radar reports instances. Every scan starts from the transactions in front
of it, so a vendor miscoded four months running is reported four times as
though it were new — and each time someone re-codes it and the cause survives.

These pin the two judgements that make the difference: what counts as "the same
problem", and what counts as "again".
"""
from datetime import date
from decimal import Decimal

from modules.gl_accuracy.repeats import (
    REPEAT_AFTER_PERIODS,
    Occurrence,
    find_repeats,
    pattern_key,
    summarise,
)


def occ(month, *, vendor="Adobe", posted="Office Supplies",
        suggested="Software Subscriptions", status="open", amount=3240, year=2026):
    return Occurrence(date(year, month, 28), vendor, posted, suggested,
                      Decimal(amount), status)


# ── What makes two months the same problem ────────────────────────────────

def test_the_pattern_is_the_vendor_and_where_it_keeps_landing():
    assert pattern_key(occ(4)) == pattern_key(occ(7))


def test_the_suggested_account_is_not_part_of_the_key():
    """Where it SHOULD go can change as a chart of accounts is tidied. If that
    re-keyed the pattern, the count would restart on the day someone improved
    the fix and never reach the threshold."""
    a = occ(4, suggested="Software Subscriptions")
    b = occ(5, suggested="Software & SaaS")
    assert pattern_key(a) == pattern_key(b)
    assert len(find_repeats([a, b, occ(6, suggested="Cloud Tools")])) == 1


def test_the_same_vendor_in_a_different_account_is_a_different_problem():
    """Adobe landing in Office Supplies and Adobe landing in Dues are two
    separate causes; merging them would report one pattern that no single fix
    addresses."""
    rows = [occ(4), occ(5), occ(6),
            occ(4, posted="Dues"), occ(5, posted="Dues"), occ(6, posted="Dues")]
    assert len(find_repeats(rows)) == 2


def test_vendor_matching_ignores_casing_and_padding():
    rows = [occ(4, vendor="Adobe"), occ(5, vendor="ADOBE "), occ(6, vendor=" adobe")]
    assert len(find_repeats(rows)) == 1


def test_a_finding_with_no_vendor_is_skipped():
    """Nothing to group on — reporting it as a pattern named "" would be a row
    nobody can act on."""
    assert find_repeats([occ(4, vendor=""), occ(5, vendor="  "), occ(6, vendor="")]) == []


# ── What counts as "again" ────────────────────────────────────────────────

def test_it_takes_the_threshold_in_distinct_months():
    assert len(find_repeats([occ(4), occ(5)])) == 0
    assert len(find_repeats([occ(4), occ(5), occ(6)])) == 1


def test_many_hits_in_ONE_month_are_not_a_pattern():
    """THE COUNT THAT WOULD BE WRONG. Twelve Adobe charges in June is one
    month's problem — possibly a single bad import. Counting occurrences
    instead of periods would rank a busy month above a habit nobody fixed,
    which is the opposite of what this exists for."""
    assert find_repeats([occ(6) for _ in range(12)]) == []


def test_periods_are_counted_distinctly_even_when_repeated_within_a_month():
    rows = [occ(4), occ(4), occ(4), occ(5), occ(5), occ(6)]
    r = find_repeats(rows)
    assert r[0]["period_count"] == 3
    assert r[0]["occurrence_count"] == 6


def test_a_pattern_everyone_already_fixed_is_not_reported():
    """It recurred and someone dealt with it each time. What makes a pattern
    worth surfacing is that it is outstanding AGAIN — otherwise the watchlist
    fills with solved history and gets ignored."""
    rows = [occ(m, status="dismissed") for m in (4, 5, 6)]
    assert find_repeats(rows) == []


def test_resolved_history_still_counts_toward_the_pattern():
    """Two months fixed and the third outstanding is a three-month pattern —
    the history is exactly what proves the cause was never addressed. Counting
    only unresolved rows would keep resetting it to one."""
    rows = [occ(4, status="dismissed"), occ(5, status="dismissed"), occ(6, status="open")]
    r = find_repeats(rows)
    assert len(r) == 1
    assert r[0]["period_count"] == 3
    assert r[0]["unresolved_count"] == 1


# ── Ordering and reporting ────────────────────────────────────────────────

def test_the_most_persistent_pattern_comes_first():
    """Recurrence is the finding, so a four-month pattern outranks a
    three-month one whatever the money involved."""
    rows = ([occ(m, vendor="Adobe", amount=100) for m in (3, 4, 5, 6)]
            + [occ(m, vendor="Slack", posted="Dues", amount=99_000) for m in (4, 5, 6)])
    r = find_repeats(rows)
    assert r[0]["vendor"] == "Adobe"
    assert r[0]["period_count"] == 4


def test_it_reports_the_span_and_the_money():
    rows = [occ(m) for m in (3, 4, 5)]
    r = find_repeats(rows)[0]
    assert r["first_seen"] == "2026-03-28" and r["last_seen"] == "2026-05-28"
    assert Decimal(r["total_amount"]) == Decimal("9720")


def test_display_values_come_from_the_most_recent_occurrence():
    """A vendor's name casing or the suggested fix may have changed; the newest
    is what the reviewer will recognise."""
    rows = [occ(4, vendor="adobe inc"), occ(5, vendor="ADOBE INC"),
            occ(6, vendor="Adobe Inc")]
    assert find_repeats(rows)[0]["vendor"] == "Adobe Inc"


def test_a_renamed_vendor_splits_the_pattern_and_that_is_the_safe_direction():
    """A KNOWN LIMIT, pinned rather than left to be discovered. Matching is on
    case and whitespace only, so "Adobe Inc" becoming "Adobe Inc." starts a new
    pattern and the count restarts.

    Deliberate. Stripping punctuation to merge them would also merge "Smith &
    Co" with "Smith Co", and inventing a repeat offender that isn't one costs
    more trust than missing one — a watchlist is only read while everything on
    it is real."""
    rows = [occ(4, vendor="Adobe Inc"), occ(5, vendor="Adobe Inc"),
            occ(6, vendor="Adobe Inc.")]
    assert find_repeats(rows) == []


def test_the_summary_says_how_long_not_just_how_many():
    """"3 recurring issues" is a number. "Adobe has landed in Office Supplies
    five months running" is a reason to go and look."""
    rows = [occ(m) for m in (2, 3, 4, 5, 6)]
    s = summarise(find_repeats(rows))
    assert "5 months running" in s and "Adobe" in s


def test_nothing_to_report_says_nothing():
    assert summarise([]) is None


def test_the_threshold_is_a_habit_not_a_coincidence():
    """Two is something a reviewer holds in their head; three is the point at
    which fixing the cause beats fixing the instance."""
    assert 2 <= REPEAT_AFTER_PERIODS <= 4
