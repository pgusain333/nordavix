"""An adjusting entry has to be able to account for itself.

Where it came from, what it is made of, who decided what and why, and what
changed because of it. Three rules carry most of that weight, and all three
used to be wrong in the same quiet way — the mechanism worked while the record
of it was missing or misfiled:

  net_effect          said what an entry does to the statements, and would
                      happily say it while silently dropping a line it couldn't
                      classify.
  entry_subject       decided which close object an entry links to, by guessing
                      from two branches where there are five producers.
  blocks_self_approval  enforced segregation of duties from a column that the
                      act of approving overwrote.

Pure functions, tested here without a database, so each can be argued with.
"""
import uuid
from decimal import Decimal

import pytest

from core.graph.schema import validate_edge
from modules.adjustments.service import (
    blocks_self_approval,
    combine_effects,
    entry_subject,
    net_effect,
)

# QBO account ids used throughout, with the types the period's chart would give.
CASH, AR, AP, EQUITY, RENT, SALES = "1", "2", "3", "4", "5", "6"
TYPES = {
    CASH: "Bank",
    AR: "Accounts Receivable",
    AP: "Accounts Payable",
    EQUITY: "Equity",
    RENT: "Expense",
    SALES: "Income",
}


def line(account, debit="0.00", credit="0.00"):
    return {"account_qbo_id": account, "account_name": f"acct-{account}",
            "debit": debit, "credit": credit}


def effect(*lines):
    return net_effect(list(lines), type_by_account=TYPES)


def D(s):  # noqa: N802 — reads as the decimal it is
    return Decimal(s)


# ── What an entry does to the statements ──────────────────────────────────

def test_an_accrual_reduces_net_income_and_raises_liabilities():
    """Dr Rent 1,000 / Cr Accrued liabilities 1,000 — the everyday close entry."""
    e = effect(line(RENT, debit="1000.00"), line(AP, credit="1000.00"))
    assert D(e["net_income"]) == D("-1000.00")
    assert D(e["liabilities_equity"]) == D("1000.00")
    assert D(e["assets"]) == D("0.00")


def test_revenue_and_expense_move_net_income_the_same_way():
    """One rule, not two: a credit raises net income whether it lands on Income
    (more revenue) or on an expense account (less expense)."""
    more_revenue = effect(line(AR, debit="500.00"), line(SALES, credit="500.00"))
    less_expense = effect(line(RENT, credit="500.00"), line(AP, debit="500.00"))
    assert D(more_revenue["net_income"]) == D("500.00")
    assert D(less_expense["net_income"]) == D("500.00")


def test_the_entry_still_balances_after_classification():
    """THE INVARIANT. A balanced JE has Σdebits = Σcredits, so once the lines
    are split three ways the halves must still meet: what assets gained equals
    what was funded by liabilities/equity plus what ran through the P&L. If a
    line were dropped or filed in the wrong bucket, this is what breaks."""
    e = effect(
        line(RENT, debit="1200.00"),
        line(CASH, credit="900.00"),
        line(AP, credit="300.00"),
    )
    assert D(e["assets"]) == D(e["liabilities_equity"]) + D(e["net_income"])


def test_cash_is_reported_inside_assets_not_beside_it():
    e = effect(line(CASH, debit="750.00"), line(SALES, credit="750.00"))
    assert D(e["cash"]) == D("750.00")
    assert D(e["assets"]) == D("750.00")


def test_equity_sits_with_liabilities():
    """An owner draw funded from cash: assets down, equity down."""
    e = effect(line(EQUITY, debit="2000.00"), line(CASH, credit="2000.00"))
    assert D(e["assets"]) == D("-2000.00")
    assert D(e["liabilities_equity"]) == D("-2000.00")
    assert D(e["net_income"]) == D("0.00")


# ── What it refuses to guess ──────────────────────────────────────────────

def test_a_line_with_no_account_is_counted_not_dropped():
    """A placeholder the preparer hasn't filled in. Omitting it would produce a
    tidy total that doesn't describe the entry — the failure mode this whole
    module exists to avoid."""
    e = net_effect(
        [line(RENT, debit="100.00"), {"account_name": "?", "debit": "0.00", "credit": "100.00"}],
        type_by_account=TYPES,
    )
    assert e["unclassified_lines"] == 1
    assert e["complete"] is False


def test_an_account_missing_from_the_period_chart_is_unclassified():
    """The account exists on the entry but not in the period's snapshot, so its
    type is unknown and it cannot be filed."""
    e = net_effect([line("999", debit="50.00")], type_by_account=TYPES)
    assert e["unclassified_lines"] == 1
    assert e["complete"] is False


def test_an_account_type_outside_the_taxonomy_is_unclassified():
    """A QBO type we have never seen must not fall into a bucket by default."""
    e = net_effect([line(CASH, debit="10.00")], type_by_account={CASH: "Some New Type"})
    assert e["unclassified_lines"] == 1
    assert e["complete"] is False


def test_a_fully_mapped_entry_reports_itself_complete():
    assert effect(line(RENT, debit="5.00"), line(CASH, credit="5.00"))["complete"] is True


def test_zero_lines_are_skipped_without_being_called_unclassified():
    """Blank rows in a draft aren't a data-quality problem."""
    e = net_effect(
        [line(RENT, debit="10.00"), line(CASH, credit="10.00"),
         {"account_name": "", "debit": "0.00", "credit": "0.00"}],
        type_by_account=TYPES,
    )
    assert e["unclassified_lines"] == 0


# ── Rolling a batch up ────────────────────────────────────────────────────

def test_a_batch_adds_up():
    a = effect(line(RENT, debit="100.00"), line(AP, credit="100.00"))
    b = effect(line(RENT, debit="250.00"), line(AP, credit="250.00"))
    total = combine_effects([a, b])
    assert D(total["net_income"]) == D("-350.00")
    assert D(total["liabilities_equity"]) == D("350.00")


def test_one_incomplete_entry_makes_the_whole_batch_incomplete():
    """The reviewer is reading a single total. If any part of it was guessed,
    the total does not get to look certain."""
    good = effect(line(RENT, debit="100.00"), line(AP, credit="100.00"))
    bad = net_effect([line("999", debit="1.00")], type_by_account=TYPES)
    assert combine_effects([good, bad])["complete"] is False


def test_an_empty_batch_is_zero_and_complete():
    total = combine_effects([])
    assert D(total["net_income"]) == D("0")
    assert total["complete"] is True


# ── Which close object an entry belongs to ────────────────────────────────

class FakeEntry:
    def __init__(self, source, source_ref):
        self.source, self.source_ref = source, source_ref
        self.period_end = __import__("datetime").date(2026, 6, 30)


@pytest.mark.parametrize(("source", "expected"), [
    ("flux",        "flux_variance"),
    ("gl_accuracy", "finding"),
    ("bank",        "reconciliation"),
    ("recon",       "reconciliation"),
])
def test_each_producer_points_at_the_object_it_actually_named(source, expected):
    """source_ref means something different per producer and the graph target
    has to follow it. This used to be a two-branch guess — flux, else a
    reconciliation — which sent gl_accuracy's FINDING id to a reconciliation
    node that does not exist."""
    assert entry_subject(FakeEntry(source, "abc")).type == expected


def test_a_reconciliation_is_keyed_by_account_and_period():
    node = entry_subject(FakeEntry("recon", "77"))
    assert node.id == "77:2026-06-30"


def test_an_assistant_entry_has_no_close_object_to_point_at():
    """Its source_ref is a conversation thread. The entry is real and
    reviewable; inventing a subject for it would assert a link that resolves to
    nothing."""
    assert entry_subject(FakeEntry("assistant", "thread-1")) is None


def test_a_producer_with_no_reference_links_to_nothing():
    assert entry_subject(FakeEntry("recon", "")) is None


@pytest.mark.parametrize("source", ["flux", "gl_accuracy", "bank", "recon"])
@pytest.mark.parametrize("relation", ["explains", "considered_for"])
def test_every_subject_is_a_legal_edge(source, relation):
    """Ties the function to the graph's own vocabulary. If a producer is ever
    pointed at a node type the registry doesn't allow from a journal entry,
    link() would raise at runtime, inside a best-effort try — the edge would
    just silently never appear. This fails at test time instead."""
    node = entry_subject(FakeEntry(source, "abc"))
    validate_edge("journal_entry", relation, node.type)


# ── Segregation of duties ─────────────────────────────────────────────────

ALICE, BOB = uuid.uuid4(), uuid.uuid4()


def test_you_cannot_approve_what_you_prepared():
    assert blocks_self_approval(prepared_by=ALICE, user_id=ALICE, role="reviewer") is True


def test_someone_else_may_approve_it():
    assert blocks_self_approval(prepared_by=ALICE, user_id=BOB, role="reviewer") is False


def test_an_untouched_ai_draft_is_approvable_by_anyone():
    """The control separates two HUMANS. Applying it to the machine's own work
    would leave a one-person firm unable to close anything."""
    assert blocks_self_approval(prepared_by=None, user_id=ALICE, role="reviewer") is False


def test_an_admin_bypasses_it():
    """Master access for solo firms, mirroring the recon subledger control."""
    assert blocks_self_approval(prepared_by=ALICE, user_id=ALICE, role="admin") is False


def test_the_control_reads_the_preparer_not_the_last_toucher():
    """THE BUG THIS SPLIT FIXES. prepared_by and approved_by were one column,
    stamped by every transition. So a reviewer who reopened an entry became its
    'last toucher' and was then blocked from re-approving work they never
    prepared — while the id of whoever actually prepared it was gone from the
    row. The predicate takes prepared_by alone; nothing else can reach it."""
    assert blocks_self_approval(prepared_by=BOB, user_id=ALICE, role="reviewer") is False
