"""The close brief — and the rule that stops it becoming a lie.

Client Memory learns a client's conventions and applies them everywhere, and
every application is reactive and mid-task, so the knowledge is invisible at
the one moment it would land: opening the month. The brief is that moment.

The count is the easy half and, alone, a vanity metric. A memory that only
accumulates eventually misleads — an expectation for rent that stopped in May,
a vendor rule for a supplier nobody uses — and those quietly suppress the flags
a firm now wants. The staleness rule is what keeps the pile honest, so it is
what these mostly test.

Its bias is deliberate and one-directional: a false "this looks stale" on a
correct rule teaches people to dismiss the card without reading it, which
destroys the feature. A late question on a wrong rule merely delays it. So the
rule is conservative, and the tests below check that it stays that way.
"""
import uuid
from datetime import UTC, date, datetime

import pytest

from modules.memory.brief import (
    MIN_HISTORY_TO_JUDGE,
    STALE_AFTER_PERIODS,
    FactUse,
    is_stale,
    stale_reason,
)

# A year of monthly closes, oldest first.
CLOSES = [date(2026, m, 28) for m in range(1, 13)]


def use(fired=(), *, confirmed=None, kind="variance_expectation"):
    return FactUse(
        fact_id=uuid.uuid4(), kind=kind, title="Rent $12,400 monthly",
        confirmed_at=confirmed, periods_fired=frozenset(fired),
    )


# ── Silence only counts when there was a chance to speak ───────────────────

def test_a_fact_that_fired_last_close_is_never_stale():
    """However long it slept before that. The run must be recent AND unbroken."""
    assert is_stale(use([CLOSES[0], CLOSES[-1]]), closed_periods=CLOSES) is False


def test_a_fact_silent_through_the_whole_window_is_questioned():
    fired = [CLOSES[-(STALE_AFTER_PERIODS + 1)]]     # last fired just before the window
    assert is_stale(use(fired), closed_periods=CLOSES) is True


def test_one_firing_inside_the_window_is_enough_to_clear_it():
    """A quarterly rule fires once in three months and is entirely correct."""
    assert is_stale(use([CLOSES[-2]]), closed_periods=CLOSES) is False


def test_age_alone_is_never_enough():
    """THE FALSE POSITIVE THAT WOULD KILL THE FEATURE. An annual insurance
    renewal sits idle eleven months and is perfectly correct. Only a missed
    OPPORTUNITY counts against a fact, never the calendar."""
    short_history = CLOSES[:2]
    ancient = use([], confirmed=datetime(2020, 1, 1, tzinfo=UTC))
    assert is_stale(ancient, closed_periods=short_history) is False


def test_a_new_fact_is_not_judged_on_its_first_close():
    """The close a fact was learned in is frequently the only one it has seen.
    Asking about it immediately makes the card noise from day one."""
    new = use([], confirmed=datetime(2026, 12, 1, tzinfo=UTC))
    assert is_stale(new, closed_periods=CLOSES) is False


def test_a_fact_is_not_blamed_for_months_that_predate_it():
    """Confirmed in October, so January through September were never its
    chances to fire — counting them would age every new fact instantly."""
    october = use([], confirmed=datetime(2026, 10, 1, tzinfo=UTC))
    assert is_stale(october, closed_periods=CLOSES[:10]) is False


def test_a_workspace_with_no_closes_yet_questions_nothing():
    """Nothing has had an opportunity, so nothing can have missed one."""
    assert is_stale(use([]), closed_periods=[]) is False


@pytest.mark.parametrize("n_closes", range(0, STALE_AFTER_PERIODS + MIN_HISTORY_TO_JUDGE))
def test_too_few_closes_to_read_anything_into_silence(n_closes):
    """Below the threshold the answer is always 'no', whatever the firing
    history — the product has not watched for long enough to have an opinion."""
    assert is_stale(use([]), closed_periods=CLOSES[:n_closes]) is False


def test_the_window_is_the_most_recent_closes_not_the_first():
    """A fact busy in January and silent since is stale; the reverse is not."""
    early_only = use([CLOSES[0]], confirmed=datetime(2025, 12, 1, tzinfo=UTC))
    late_only = use([CLOSES[-1]], confirmed=datetime(2025, 12, 1, tzinfo=UTC))
    assert is_stale(early_only, closed_periods=CLOSES) is True
    assert is_stale(late_only, closed_periods=CLOSES) is False


# ── What it says when it asks ──────────────────────────────────────────────

@pytest.mark.parametrize("kind", [
    "gl_accuracy_exception", "variance_expectation", "vendor_schedule",
    "offset_account", "recon_recurring_item",
])
def test_every_kind_asks_a_question_in_its_own_terms(kind):
    """A generic "this looks stale" tells a reviewer nothing about what to
    check. And it is a QUESTION: the product knows the fact stopped being
    needed, not that it is wrong, and those have innocent explanations."""
    r = stale_reason(use(kind=kind))
    assert str(STALE_AFTER_PERIODS) in r
    assert r.rstrip().endswith("?"), r


def test_an_unknown_kind_still_gets_a_sensible_question():
    """A future fact kind must not render a KeyError into the close brief."""
    r = stale_reason(use(kind="something_new_zz"))
    assert r and r.rstrip().endswith("?")


# ── The thresholds are defensible ──────────────────────────────────────────

def test_the_window_is_a_quarter_not_a_hair_trigger():
    """Long enough that a quiet month or a late close doesn't fire it, short
    enough that a rule which stopped being true is caught inside a reporting
    cycle."""
    assert 2 <= STALE_AFTER_PERIODS <= 6
