"""Unit tests for the account-memory-context matcher (Client Memory · Slice B).

`_fact_note_for_account` decides whether a confirmed fact concerns a given
account and, if so, the note shown on the "What Nordavix knows" surfaces in flux
and recon. The reputation risk is a fact bleeding onto an UNRELATED account
(a wrong note next to a financial figure), so the no-false-match cases —
especially empty/blank ids — are tested as carefully as the positive ones. The
matcher is pure (no DB), so these are plain fast unit tests.
"""
from types import SimpleNamespace

from modules.memory.service import _fact_note_for_account, _recurring_slug


def _fact(kind, value, fid="fid-1"):
    return SimpleNamespace(kind=kind, value=value, id=fid)


# ── variance_expectation ───────────────────────────────────────────────────────

def test_expectation_matches_by_qbo_id_and_by_number():
    f = _fact("variance_expectation", {
        "qbo_account_id": "57", "account_number": "6010",
        "recurrence": "monthly", "expected_balance": "1200",
        "explanation": "Monthly D&O insurance",
    })
    by_id = _fact_note_for_account(f, "57", "9999")
    assert by_id and by_id["module"] == "flux" and "Expected ~$1,200 every month" in by_id["text"]
    by_num = _fact_note_for_account(f, None, "6010")
    assert by_num is not None
    # An unrelated account gets nothing.
    assert _fact_note_for_account(f, "999", "1234") is None


def test_expectation_annual_says_the_month():
    f = _fact("variance_expectation", {
        "qbo_account_id": "60", "recurrence": "annual", "month": 6,
        "expected_balance": "5000", "explanation": "Annual audit fee",
    })
    note = _fact_note_for_account(f, "60", None)
    assert note and "each June" in note["text"]


# ── offset_account ─────────────────────────────────────────────────────────────

def test_offset_matches_the_account_it_applies_to():
    f = _fact("offset_account", {
        "account_ref": "id:42", "to_account_number": "6200", "to_account_name": "Bank Fees",
    })
    note = _fact_note_for_account(f, "id:42", None)
    assert note and note["module"] == "adjustments"
    assert "6200 · Bank Fees" in note["text"]
    # Not the offset target itself, and not an unrelated account.
    assert _fact_note_for_account(f, "id:99", "6200") is None


# ── vendor_schedule (matches BOTH the BS account and the expense/offset side) ───

def test_vendor_schedule_matches_balance_sheet_account():
    f = _fact("vendor_schedule", {
        "vendor": "Acme Insurance", "schedule_type": "prepaid", "term_months": 12,
        "amortization_method": "straight_line",
        "qbo_account_id": "140", "offset_qbo_account_id": "610",
    })
    note = _fact_note_for_account(f, "140", None)
    assert note and note["module"] == "schedules"
    assert note["text"] == "Acme Insurance: 12-mo straight-line prepaid set up on this account."


def test_vendor_schedule_matches_expense_offset_account():
    f = _fact("vendor_schedule", {
        "vendor": "Acme Insurance", "schedule_type": "prepaid",
        "qbo_account_id": "140", "offset_qbo_account_id": "610",
    })
    note = _fact_note_for_account(f, "610", None)
    assert note and "posts into this account" in note["text"]


# ── No false matches — the reputation-critical cases ───────────────────────────

def test_blank_account_never_matches_blank_fact_fields():
    # An empty id must NOT match an empty stored id (would attach a note to
    # every numberless account).
    f = _fact("variance_expectation", {"qbo_account_id": "", "account_number": ""})
    assert _fact_note_for_account(f, "", "") is None
    assert _fact_note_for_account(f, None, None) is None


def test_offset_without_target_label_is_dropped():
    # A malformed offset fact with no target account yields no note rather than
    # an empty "booked to ." string.
    f = _fact("offset_account", {"account_ref": "id:7", "to_account_number": "", "to_account_name": ""})
    assert _fact_note_for_account(f, "id:7", None) is None


def test_id_preferred_no_number_crossmatch():
    # Fact is for account with QBO id "140" (and number "6010"). A DIFFERENT
    # account whose QBO id is "999" but whose account NUMBER happens to be "140"
    # must NOT match — ids differ, so the coincidental number collision is ignored.
    f = _fact("variance_expectation", {
        "qbo_account_id": "140", "account_number": "6010",
        "recurrence": "monthly", "expected_balance": "100",
    })
    assert _fact_note_for_account(f, "999", "140") is None
    # The right account (matching id) still matches.
    assert _fact_note_for_account(f, "140", None) is not None


# ── recon_recurring_item (Slice C) ─────────────────────────────────────────────

def test_recurring_item_matches_account_with_label_and_amount():
    f = _fact("recon_recurring_item", {
        "qbo_account_id": "88", "label": "In-transit deposits",
        "txn_type": "Deposit", "expected_amount": "5000",
    })
    note = _fact_note_for_account(f, "88", None)
    assert note and note["module"] == "recons"
    assert "In-transit deposits" in note["text"] and "$5,000" in note["text"]
    # Different account: no match.
    assert _fact_note_for_account(f, "99", None) is None


def test_recurring_item_without_amount_omits_the_tilde_figure():
    f = _fact("recon_recurring_item", {"qbo_account_id": "88", "label": "Unapplied cash"})
    note = _fact_note_for_account(f, "88", None)
    assert note and "Unapplied cash" in note["text"] and "≈" not in note["text"]


def test_recurring_slug_is_stable_and_distinct():
    assert _recurring_slug("In-transit deposits") == "in-transit-deposits"
    assert _recurring_slug("  Unapplied   A/R cash!! ") == "unapplied-a-r-cash"
    # Distinct labels → distinct slugs, so one account can carry several items.
    assert _recurring_slug("In-transit deposits") != _recurring_slug("Unapplied cash")
    # Blank label → empty slug (caller still namespaces by account id).
    assert _recurring_slug("   ") == ""


def test_unknown_kind_returns_none():
    assert _fact_note_for_account(_fact("something_else", {"qbo_account_id": "1"}), "1", None) is None
