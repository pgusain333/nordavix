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
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from core.graph.schema import validate_edge
from modules.adjustments.service import (
    baseline_disposition,
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


# ── Is it already inside the baseline we're adding it to? ─────────────────

SNAP = datetime(2026, 9, 1, 6, 4, tzinfo=UTC)


def test_an_entry_never_seen_in_quickbooks_is_applied():
    assert baseline_disposition(posted_confirmed_at=None, captured_at=SNAP) == "apply"


def test_an_entry_posted_before_the_snapshot_is_already_in_it():
    """THE DOUBLE-COUNT. The snapshot is a read of QuickBooks; an entry booked
    there before that read is part of it, and adding it again would overstate
    the movement while looking entirely authoritative."""
    earlier = datetime(2026, 8, 20, 9, 0, tzinfo=UTC)
    assert baseline_disposition(posted_confirmed_at=earlier, captured_at=SNAP) == "already_in"


def test_an_entry_confirmed_after_the_snapshot_is_reported_not_guessed():
    """It is in QuickBooks but possibly not in THIS read, and nothing here can
    tell. Applying it may double-count; skipping it may understate. The honest
    answer is neither number — it is 'your baseline is stale, re-sync'."""
    later = datetime(2026, 9, 2, 11, 0, tzinfo=UTC)
    assert baseline_disposition(posted_confirmed_at=later, captured_at=SNAP) == "stale"


def test_an_undated_snapshot_cannot_clear_a_posted_entry():
    """No capture time means the baseline can't be dated, which is the same
    uncertainty — so it reports rather than assuming the entry is in or out."""
    assert baseline_disposition(
        posted_confirmed_at=SNAP, captured_at=None) == "stale"


def test_an_undated_snapshot_still_applies_unposted_entries():
    """Only the posted ones are ambiguous. A draft nobody has booked is not in
    any read of QuickBooks, dated or otherwise."""
    assert baseline_disposition(posted_confirmed_at=None, captured_at=None) == "apply"


def test_a_snapshot_taken_at_the_same_instant_counts_as_containing_it():
    assert baseline_disposition(posted_confirmed_at=SNAP, captured_at=SNAP) == "already_in"


# ── The statement lines the rail adds onto a real balance ─────────────────

def test_each_statement_line_moves_on_its_own():
    """The rail adds these straight onto figures from financials/internal, so
    they have to be presented-positive in the same way: revenue up on a credit,
    cost up on a debit."""
    e = effect(line(SALES, credit="1000.00"), line(AR, debit="1000.00"))
    assert D(e["revenue"]) == D("1000.00")
    assert D(e["assets"]) == D("1000.00")

    c = net_effect([line("9", debit="600.00"), line(AP, credit="600.00")],
                   type_by_account={**TYPES, "9": "Cost of Goods Sold"})
    assert D(c["cogs"]) == D("600.00")
    assert D(c["gross_profit"]) == D("-600.00")


def test_net_income_is_derived_from_the_lines_above_it():
    """Not accumulated separately. A statement whose total disagrees with the
    lines it foots is the failure this rail exists to prevent."""
    e = net_effect(
        [line(SALES, credit="900.00"), line("9", debit="400.00"), line(RENT, debit="100.00"),
         line(AR, debit="500.00"), line(AP, credit="100.00")],
        type_by_account={**TYPES, "9": "Cost of Goods Sold"},
    )
    assert D(e["net_income"]) == D(e["revenue"]) - D(e["cogs"]) - D(e["opex"])
    assert D(e["net_income"]) == D("400.00")


def test_the_balance_sheet_still_ties_with_the_finer_lines():
    e = net_effect(
        [line(SALES, credit="900.00"), line("9", debit="400.00"), line(RENT, debit="100.00"),
         line(AR, debit="500.00"), line(AP, credit="100.00")],
        type_by_account={**TYPES, "9": "Cost of Goods Sold"},
    )
    assert D(e["assets"]) == D(e["liabilities_equity"]) + D(e["net_income"])


def test_the_pl_foots_in_the_order_it_is_read():
    """Revenue − COGS = gross profit; − opex = operating income; + other income
    − other expense = net income. Every subtotal is DERIVED from the lines above
    it, so a statement cannot foot to something its own totals disagree with."""
    types = {**TYPES, "9": "Cost of Goods Sold", "10": "Other Income", "11": "Other Expense"}
    e = net_effect(
        [line(SALES, credit="1000.00"), line("9", debit="300.00"),
         line(RENT, debit="200.00"), line("10", credit="50.00"),
         line("11", debit="25.00"), line(AR, debit="475.00")],
        type_by_account=types,
    )
    assert D(e["gross_profit"]) == D(e["revenue"]) - D(e["cogs"])
    assert D(e["operating_income"]) == D(e["gross_profit"]) - D(e["opex"])
    assert D(e["net_income"]) == (
        D(e["operating_income"]) + D(e["other_income"]) - D(e["other_expense"])
    )
    assert D(e["net_income"]) == D("525.00")


def test_other_income_sits_below_operating_income_not_in_revenue():
    """Interest income is not revenue. Folding it into the top line would
    overstate the business's actual sales — and it used to, because Income and
    Other Income shared a bucket."""
    e = net_effect([line("10", credit="500.00"), line(CASH, debit="500.00")],
                   type_by_account={**TYPES, "10": "Other Income"})
    assert D(e["revenue"]) == D("0.00")
    assert D(e["other_income"]) == D("500.00")
    assert D(e["operating_income"]) == D("0.00")
    assert D(e["net_income"]) == D("500.00")


def test_other_expense_sits_below_operating_income_too():
    """Interest paid is not an operating cost."""
    e = net_effect([line("11", debit="120.00"), line(CASH, credit="120.00")],
                   type_by_account={**TYPES, "11": "Other Expense"})
    assert D(e["opex"]) == D("0.00")
    assert D(e["operating_income"]) == D("0.00")
    assert D(e["net_income"]) == D("-120.00")


def test_gross_profit_rolls_up_across_a_batch():
    a = effect(line(SALES, credit="500.00"), line(AR, debit="500.00"))
    b = net_effect([line("9", debit="200.00"), line(AP, credit="200.00")],
                   type_by_account={**TYPES, "9": "Cost of Goods Sold"})
    t = combine_effects([a, b])
    assert D(t["gross_profit"]) == D("300.00")
    assert D(t["net_income"]) == D("300.00")


def test_the_control_reads_the_preparer_not_the_last_toucher():
    """THE BUG THIS SPLIT FIXES. prepared_by and approved_by were one column,
    stamped by every transition. So a reviewer who reopened an entry became its
    'last toucher' and was then blocked from re-approving work they never
    prepared — while the id of whoever actually prepared it was gone from the
    row. The predicate takes prepared_by alone; nothing else can reach it."""
    assert blocks_self_approval(prepared_by=BOB, user_id=ALICE, role="reviewer") is False
