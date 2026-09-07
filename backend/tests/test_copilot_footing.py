"""What the Copilot is standing on when it quotes a number.

It would state net income for a month that was never reconciled, never tied and
last synced three weeks ago — in the same voice it uses for a closed period.
This codebase keeps meeting that failure in different clothes: a figure that
looks authoritative while its basis is silently different. Here it was every
figure the chat produced.

The grade is computed rather than described because the interesting cases are
the ones where two of three signals look fine. A period that reconciles and
ties but was synced a month ago is not closed, and the missing signal is always
the one that bites.
"""
from modules.assistant.footing import STALE_DAYS, describe, grade

# ── Grading ───────────────────────────────────────────────────────────────────

def test_unsynced_is_unsynced_whatever_else_is_true():
    assert grade(synced=False, total=0, reconciled=0, ties=None, sync_age_days=0) == "unsynced"


def test_everything_done_and_fresh_is_closed():
    assert grade(synced=True, total=12, reconciled=12, ties=True, sync_age_days=1) == "closed"


def test_reconciled_and_tying_but_stale_is_not_closed():
    """Every account approved against books that are three weeks old describes
    a period nobody has looked at since, not a finished one."""
    assert grade(
        synced=True, total=12, reconciled=12, ties=True, sync_age_days=STALE_DAYS + 1,
    ) == "in_progress"


def test_all_reconciled_but_not_tying_is_not_closed():
    assert grade(synced=True, total=12, reconciled=12, ties=False, sync_age_days=1) == "in_progress"


def test_partly_reconciled_is_in_progress():
    assert grade(synced=True, total=12, reconciled=5, ties=None, sync_age_days=2) == "in_progress"


def test_synced_but_untouched_is_raw():
    """Nothing approved and no tie-out result: these are QuickBooks balances,
    not closed ones, and the answer has to say so."""
    assert grade(synced=True, total=12, reconciled=0, ties=None, sync_age_days=1) == "raw"


def test_a_client_with_no_balance_sheet_accounts_is_not_marked_closed_by_a_vacuous_zero():
    """0 of 0 reconciliations satisfies "reconciled >= total" arithmetically.
    Treating that as closed would give the most confident wording to the least
    evidence."""
    assert grade(synced=True, total=0, reconciled=0, ties=None, sync_age_days=1) == "raw"


# ── Wording ───────────────────────────────────────────────────────────────────

def test_an_unsynced_period_tells_the_model_it_has_no_figures():
    text = describe({"period_end": "2026-06-30", "synced": False, "grade": "unsynced"})
    assert "NEVER been synced" in text
    assert "adjacent month" in text  # and not to answer from one


def test_raw_books_get_an_explicit_caveat_instruction():
    text = describe({
        "period_end": "2026-06-30", "synced": True, "sync_age_days": 1,
        "accounts_total": 12, "accounts_reconciled": 0, "ties": None, "grade": "raw",
    })
    assert "none of the 12 reconciliations are approved" in text
    assert "caveat" in text


def test_closed_books_are_allowed_to_be_quoted_as_final():
    text = describe({
        "period_end": "2026-06-30", "synced": True, "sync_age_days": 1,
        "accounts_total": 12, "accounts_reconciled": 12, "ties": True, "grade": "closed",
    })
    assert "final" in text
    assert "every reconciliation is approved" in text


def test_a_stale_sync_says_what_the_staleness_actually_costs():
    """"Synced 30 days ago" is a fact. "Anything posted since is invisible to
    you" is the reason it matters."""
    text = describe({
        "period_end": "2026-06-30", "synced": True, "sync_age_days": 30,
        "accounts_total": 12, "accounts_reconciled": 12, "ties": True, "grade": "in_progress",
    })
    assert "30 days ago" in text
    assert "invisible" in text


def test_a_broken_tie_out_is_named_with_its_amount():
    text = describe({
        "period_end": "2026-06-30", "synced": True, "sync_age_days": 2,
        "accounts_total": 12, "accounts_reconciled": 4, "ties": False,
        "tie_difference": "6,421.00", "grade": "in_progress",
    })
    assert "does NOT tie" in text
    assert "6,421.00" in text
