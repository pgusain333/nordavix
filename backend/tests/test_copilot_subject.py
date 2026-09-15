"""What the Copilot knows before you type.

Asking about the account on your screen meant leaving it, retyping which
account and which month, and waiting while the model spent three or four tool
calls rediscovering what had just been rendered. A subject removes that: the
screen's own state goes into the prompt.

Two pure pieces carry the feature, and both are tested here rather than left to
the model. `describe` is what makes the answer cheap — if the account, the
period and the variance are not in it, the tool calls come back. `suggestions`
is what makes the feature get USED — a contextual assistant that opens on an
empty input is the one people learn to ignore, so the chips have to be right
about what is worth asking, and free enough to render on every drawer open.
"""
import pytest

from modules.assistant.subject import describe, headline_for, suggestions_for


def _state(**over) -> dict:
    base = {
        "kind": "account", "id": "42", "label": "1200 Accounts Receivable",
        "period_end": "2026-06-30", "account_type": "Accounts Receivable",
        "gl_balance": "734499.00", "subledger_balance": "720132.00",
        "subledger_source": "A/R aging", "variance": "14368.00",
        "review_status": "pending", "open_findings": 0, "evidence_count": 0,
        "open_entries": 0,
    }
    base.update(over)
    return base


# ── Suggestions ───────────────────────────────────────────────────────────────

def test_an_unexplained_variance_is_the_first_thing_offered():
    """It is the reason the drawer is open. Anything else leading would be
    the assistant talking about something other than the problem."""
    out = suggestions_for(_state())
    assert out[0] == "Why is this 14,368 out?"


def test_the_variance_amount_is_in_the_chip_not_a_generic_prompt():
    """"Ask a question about this account" is the blank page with extra steps.
    The number is what makes someone tap it."""
    assert "14,368" in suggestions_for(_state())[0]


def test_a_tying_account_is_not_asked_why_it_is_out():
    out = suggestions_for(_state(variance="0.00"))
    assert not any("out?" in s for s in out)


def test_a_rounding_difference_does_not_become_a_question():
    """Sub-dollar noise is not a finding, and putting it in someone's face as
    a suggested prompt teaches them the chips are generated rather than
    considered."""
    out = suggestions_for(_state(variance="0.40"))
    assert not any("out?" in s for s in out)


def test_an_approved_account_is_not_offered_a_draft_entry():
    """Signed off. Offering to draft an adjustment against it invites work
    that would reopen a completed reconciliation."""
    out = suggestions_for(_state(review_status="approved"))
    assert "Draft the adjusting entry" not in out


def test_an_approved_account_gets_questions_that_suit_a_finished_one():
    out = suggestions_for(_state(review_status="approved", variance="0.00"))
    assert any("Summarise" in s or "approved" in s for s in out)


def test_a_prior_note_surfaces_as_a_dated_question():
    """"What did we do last time" is the second thing people ask, and naming
    the month is what proves the Copilot has actually got the history."""
    out = suggestions_for(_state(prior_note="Timing on the aging pull.",
                                 prior_note_period="March 2026"))
    assert "What did we do in March 2026?" in out


def test_an_open_flag_is_offered_for_challenge_not_acceptance():
    out = suggestions_for(_state(open_findings=2))
    assert "Is this flag real?" in out


def test_a_schedule_backed_account_can_be_asked_for_its_roll_forward():
    out = suggestions_for(_state(variance="0.00", schedule_type="prepaid"))
    assert "Show me the roll-forward" in out


def test_there_is_always_at_least_one_question():
    """A quiet, tying, approved account with no history still opens with
    something to tap. An empty chip row is the blank page."""
    out = suggestions_for(_state(variance="0.00", review_status="approved",
                                 open_findings=0))
    assert len(out) >= 1


def test_the_chips_fit_on_one_line():
    """Three. A wall of suggestions is its own kind of blank page — the reader
    has to choose before they have read them all."""
    out = suggestions_for(_state(open_findings=3, schedule_type="prepaid",
                                 prior_note="x", prior_note_period="March 2026"))
    assert len(out) <= 3


def test_suggestions_never_repeat():
    out = suggestions_for(_state(review_status="approved", schedule_type="prepaid",
                                 variance="0.00"))
    assert len(out) == len(set(out))


# ── Headline ──────────────────────────────────────────────────────────────────

def test_the_headline_states_where_the_account_stands_before_any_question():
    h = headline_for(_state())
    assert "Not reconciled yet" in h
    assert "14,368" in h


def test_a_clean_account_says_it_ties_rather_than_saying_nothing():
    h = headline_for(_state(variance="0.00", review_status="approved"))
    assert "Approved" in h
    assert "ties" in h


def test_open_flags_are_counted_in_the_headline():
    assert "1 open flag" in headline_for(_state(open_findings=1))
    assert "3 open flags" in headline_for(_state(open_findings=3))


# ── The preamble ──────────────────────────────────────────────────────────────

def test_the_preamble_forbids_asking_which_account_or_month():
    """The whole point. Both are on the user's screen; asking for either is the
    round trip this feature exists to delete."""
    d = describe(_state())
    assert "Do not ask which account or which month" in d


def test_the_preamble_carries_the_figures_so_the_answer_costs_no_tool_calls():
    d = describe(_state())
    for fact in ("1200 Accounts Receivable", "2026-06-30", "734499.00", "720132.00", "14368.00"):
        assert fact in d, fact


def test_an_unexplained_variance_is_named_as_unexplained():
    assert "not yet explained" in describe(_state())


def test_a_tying_account_is_not_described_as_having_a_variance():
    d = describe(_state(variance="0.00"))
    assert "VARIANCE" not in d
    assert "it ties" in d


def test_the_prior_note_is_quoted_so_history_needs_no_lookup():
    d = describe(_state(prior_note="Aging was pulled before day-end.",
                        prior_note_period="March 2026"))
    assert "Aging was pulled before day-end." in d
    assert "March 2026" in d


def test_the_preamble_still_permits_tools_for_what_it_does_not_hold():
    """It must not over-claim. Transactions, history and other accounts are
    not in the preamble, and the model has to be told to go and get them."""
    d = describe(_state())
    assert "Only call a tool" in d


@pytest.mark.parametrize("missing", ["gl_balance", "subledger_balance", "account_type"])
def test_a_partly_resolved_subject_still_produces_a_usable_preamble(missing):
    """Resolution is fenced read by read, so a failed lookup leaves a hole
    rather than losing the subject. The preamble has to survive that."""
    st = _state()
    st.pop(missing)
    d = describe(st)
    assert "1200 Accounts Receivable" in d
    assert "Do not ask which account" in d
