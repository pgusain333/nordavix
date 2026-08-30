"""Workspace search — the ranking, and the ways a query can go wrong.

The command palette was a route launcher: every entry ended in navigate() and
there was no search endpoint at all, so in a workspace holding thousands of
accounts and findings, typing "AWS" returned page names. These pin the rule
that decides what comes back first, and the two input classes that would
quietly break it.
"""
import pytest

from modules.search.service import MIN_QUERY, _invert_iso, _like, rank

# ── Ranking ────────────────────────────────────────────────────────────────

def test_a_prefix_of_the_label_wins():
    """Typing an account number is the commonest search in this product, and
    the account it prefixes has to be first."""
    assert rank("1010 Operating Cash", "Bank", "1010") == 4


def test_a_word_inside_the_label_beats_a_bare_substring():
    """"cash" should find "1010 Operating Cash" — the number prefix means a
    plain startswith would never match how people actually type."""
    assert rank("1010 Operating Cash", "Bank", "cash") == 3
    assert rank("1010 Operating Cash", "Bank", "cash") > rank("1010 Operating Cash", "Bank", "perat")


def test_the_sublabel_matches_last():
    """Matching the category is a real hit and a weak one: everything in the
    workspace has a category, so it must never outrank a name."""
    assert rank("1010 Operating Cash", "Bank", "bank") == 1
    assert rank("Bank charges", "Expense", "bank") > rank("1010 Operating Cash", "Bank", "bank")


def test_no_match_scores_zero():
    assert rank("1010 Operating Cash", "Bank", "zzz") == 0


def test_matching_ignores_case():
    assert rank("AWS Hosting", "Expense", "aws") == 4
    assert rank("aws hosting", "Expense", "AWS") == 4


def test_a_hyphenated_label_matches_on_either_word():
    """Account names arrive hyphenated from QuickBooks — "Payroll-Wages"
    should be found by "wages"."""
    assert rank("Payroll-Wages", "Expense", "wages") == 3


def test_an_empty_query_matches_nothing():
    """The palette shows commands when nothing is typed; scoring everything as
    a hit would dump the whole workspace under them."""
    assert rank("1010 Operating Cash", "Bank", "") == 0
    assert rank("1010 Operating Cash", "Bank", "   ") == 0


# ── LIKE injection ─────────────────────────────────────────────────────────
#
# The query goes into an ILIKE pattern. LIKE has its OWN wildcards, and they
# are characters people genuinely type into an accounting system.

def test_a_percent_in_the_query_is_not_a_wildcard():
    """Searching for "100%" must not match the entire ledger."""
    assert "\\%" in _like("100%")


def test_an_underscore_in_the_query_is_not_a_wildcard():
    """`_` matches any single character in LIKE, so "cost_pool" would match
    "cost-pool", "costXpool" and anything else of that shape."""
    assert "\\_" in _like("cost_pool")


def test_a_backslash_is_escaped_before_the_wildcards():
    """Order matters: escaping % first and then \\ would double-escape the
    backslash that was just added."""
    assert _like("a\\b") == "%a\\\\b%"


def test_an_ordinary_query_is_left_alone():
    assert _like("AWS") == "%AWS%"


# ── Recency ────────────────────────────────────────────────────────────────

def test_newer_periods_sort_first():
    """Two equally good matches: "rent" this month beats "rent" last year."""
    assert _invert_iso("2026-08-31") < _invert_iso("2025-01-01")


def test_the_inversion_is_stable_within_a_year():
    assert _invert_iso("2026-12-31") < _invert_iso("2026-01-31")


# ── The floor ──────────────────────────────────────────────────────────────

def test_one_character_is_not_a_query():
    """A single letter matches most of a workspace. The endpoint returns
    nothing and the palette says to keep typing, rather than rendering noise."""
    assert MIN_QUERY >= 2


@pytest.mark.parametrize("q", ["", " ", "a"])
async def test_short_queries_never_reach_the_database(q):
    """Below the floor the service must not issue a single SELECT — otherwise
    every keystroke of a two-letter word is seven queries.

    COUNTS the calls rather than raising from the stub. `search()` fences each
    source in `except Exception`, and an AssertionError is an Exception: a stub
    that raised would be swallowed by the fence and this test would pass while
    the floor was gone. It did, until this was written the other way.
    """
    from modules.search import service

    class _Counting:
        def __init__(self):
            self.calls = 0

        async def execute(self, *a, **kw):
            self.calls += 1
            raise RuntimeError("no rows")   # fenced by search(), which is fine

    db = _Counting()
    assert await service.search(db, None, q) == []
    assert db.calls == 0, f"issued {db.calls} queries for {q!r}"
