"""The four open-month detectors — the ones the daily watch can actually use.

Every other detector in Risk Radar either reads the month-end balance snapshot
(which the current month does not have) or looks for something ABSENT by the end
of a period. Neither can fire on the 10th, and a watch that can only speak at
month end isn't a watch.

These four read the transaction stream, so they fire the day an entry lands. The
tests below are weighted the way the engine is: the reputation risk is a FALSE
accusation arriving unprompted in someone's inbox, so the no-flag cases are
tested harder than the positive ones.
"""
from datetime import date, timedelta
from decimal import Decimal

from modules.gl_accuracy.engine import (
    KIND_ACCOUNT_SPIKE,
    KIND_FUTURE_DATED,
    KIND_MISSING_PAYEE,
    KIND_NEW_VENDOR,
    _detector_account_spike,
    _detector_future_dated,
    _detector_missing_payee,
    _detector_new_vendor,
    run_detectors,
)

TODAY = date(2026, 8, 20)


def _t(vendor, acct="6010", amount="500", *, acct_name=None, txn_id=None,
       txn_type="Bill", txn_date=None):
    return {
        "entity_name": vendor, "qbo_account_id": acct,
        "qbo_account_name": acct_name or f"Acct {acct}",
        "amount": amount, "qbo_txn_id": txn_id, "txn_type": txn_type,
        "txn_number": "", "txn_date": txn_date, "memo": "",
    }


def _known_vendors(n=8, acct="6010"):
    """A believable history: enough distinct vendors that "new" means something."""
    return [_t(f"Vendor {i}", acct, "300", txn_date=date(2026, 3, 1)) for i in range(n)]


def _run(fn, current, history, opts=None):
    return fn(current, history, [], set(), opts or {"today": TODAY})


# ── New vendor ─────────────────────────────────────────────────────────────

def test_a_material_first_payment_to_an_unknown_payee_is_flagged():
    flags = _run(_detector_new_vendor,
                 [_t("Northwind Consulting", "6010", "4200", txn_id="n1")],
                 _known_vendors())
    assert len(flags) == 1
    f = flags[0]
    assert f["kind"] == KIND_NEW_VENDOR
    assert f["action_kind"] == "flag"          # nothing to reclass; it's a question
    assert "Northwind Consulting" in f["title"]


def test_a_known_vendor_is_never_new():
    flags = _run(_detector_new_vendor,
                 [_t("Vendor 3", "6010", "9000", txn_id="k1")],
                 _known_vendors())
    assert flags == []


def test_vendor_matching_ignores_case_and_spacing():
    """QBO names arrive inconsistently punctuated. 'AWS ' and 'aws' are one
    supplier, and treating them as two would announce a new vendor every month."""
    flags = _run(_detector_new_vendor,
                 [_t("  AWS  ", "6010", "5000", txn_id="a1")],
                 _known_vendors() + [_t("aws", "6010", "400")])
    assert flags == []


def test_the_detector_stands_down_when_history_is_too_thin():
    """THE FAILURE THAT MATTERS. A first-month workspace, or a history pull that
    came back short, makes EVERY vendor look new — a hundred false findings that
    bury the real ones and, with email on, land in an inbox."""
    for hist in ([], _known_vendors(1), _known_vendors(4)):
        flags = _run(_detector_new_vendor,
                     [_t("Anyone", "6010", "9999", txn_id="x")], hist)
        assert flags == [], f"flagged against {len(hist)} known vendors"


def test_one_finding_per_vendor_not_per_line():
    """Four invoices from one new supplier is one thing to check."""
    cur = [_t("Northwind", "6010", "1200", txn_id=f"n{i}") for i in range(4)]
    flags = _run(_detector_new_vendor, cur, _known_vendors())
    assert len(flags) == 1
    assert flags[0]["amount"] == "4800.00"     # the total, not the largest line


def test_a_small_first_payment_is_below_materiality():
    flags = _run(_detector_new_vendor,
                 [_t("Corner Cafe", "6010", "40", txn_id="c1")], _known_vendors())
    assert flags == []


def test_a_blank_payee_is_not_a_new_vendor():
    """That's the missing-payee detector's finding; reporting it twice under two
    headings is how one problem becomes two alerts."""
    flags = _run(_detector_new_vendor,
                 [_t("", "6010", "9000", txn_id="b1")], _known_vendors())
    assert flags == []


# ── Account spike ──────────────────────────────────────────────────────────

def _months(acct, per_month, n=6, start=(2026, 2)):
    """`n` months of history for one account at `per_month` each."""
    out = []
    y, m = start
    for i in range(n):
        mm = m + i
        yy, mm = y + (mm - 1) // 12, (mm - 1) % 12 + 1
        out.append(_t("Someone", acct, per_month, txn_date=date(yy, mm, 5)))
    return out


def test_an_account_far_above_its_own_norm_is_flagged():
    flags = _run(_detector_account_spike,
                 [_t("Contractor", "6300", "14000", acct_name="Repairs", txn_id="r1")],
                 _months("6300", "2000"))
    assert len(flags) == 1
    f = flags[0]
    assert f["kind"] == KIND_ACCOUNT_SPIKE
    assert f["evidence"]["monthly_median"] == "2000.00"
    assert f["dedupe_key"] == "6300"   # keyed on the account, so a re-scan updates in place


def test_normal_variation_is_not_a_spike():
    """An account 40% above its median is a busy month, not an anomaly. Flagging
    it is how a daily check becomes background noise."""
    flags = _run(_detector_account_spike,
                 [_t("Contractor", "6300", "2800")], _months("6300", "2000"))
    assert flags == []


def test_a_big_multiple_of_a_tiny_baseline_is_not_flagged():
    """THE CLASSIC FALSE POSITIVE. $60 against a $10 median is 6× and means
    nothing. The excess has to clear a dollar floor as well as a multiple."""
    flags = _run(_detector_account_spike,
                 [_t("Someone", "6300", "60")], _months("6300", "10"))
    assert flags == []


def test_an_account_without_enough_history_is_left_alone():
    """Three months is not a norm. Nothing to compare against means nothing to say."""
    flags = _run(_detector_account_spike,
                 [_t("Someone", "6300", "50000")], _months("6300", "2000", n=3))
    assert flags == []


def test_a_part_month_can_only_be_late_never_premature():
    """The baseline is a FULL month's median and the current figure is
    month-to-date, so early in the month the comparison under-calls. That is the
    safe direction and it is deliberate: pro-rating would invent a spike out of
    a large invoice that always lands on the 3rd."""
    # Half of a 5x month, seen mid-month: 5x total would be 10000, half is 5000.
    flags = _run(_detector_account_spike,
                 [_t("Someone", "6300", "5000")], _months("6300", "2000"))
    assert flags == [], "flagged a part-month total as a spike"


def test_the_spike_reports_the_arithmetic_it_used():
    f = _run(_detector_account_spike,
             [_t("Contractor", "6300", "14000", acct_name="Repairs")],
             _months("6300", "2000"))[0]
    ev = f["evidence"]
    assert Decimal(ev["period_total"]) - Decimal(ev["monthly_median"]) == Decimal(ev["excess"])
    assert ev["months_of_history"] == 6


# ── Future dated ───────────────────────────────────────────────────────────

def test_an_entry_dated_next_year_is_flagged_high():
    """The 2027-for-2026 typo — a year of distortion nobody is looking at yet."""
    flags = _run(_detector_future_dated,
                 [_t("Acme", "6010", "3000", txn_id="f1",
                     txn_date=TODAY.replace(year=TODAY.year + 1))], [])
    assert len(flags) == 1
    assert flags[0]["kind"] == KIND_FUTURE_DATED
    assert flags[0]["severity"] == "high"


def test_todays_and_past_entries_are_not_future_dated():
    for d in (TODAY, TODAY - timedelta(days=1), TODAY - timedelta(days=400)):
        assert _run(_detector_future_dated,
                    [_t("Acme", "6010", "3000", txn_date=d)], []) == []


def test_a_scheduled_bill_a_few_days_out_is_still_reported_but_not_high():
    f = _run(_detector_future_dated,
             [_t("Acme", "6010", "600", txn_date=TODAY + timedelta(days=3))], [])
    assert len(f) == 1 and f[0]["severity"] == "medium"


def test_the_detector_stands_down_when_it_is_not_told_the_date():
    """The engine is pure and cannot call date.today(). Guessing — assuming a
    date, or skipping the check silently while reporting success — is worse than
    not running: it would flag or clear entries against the wrong day."""
    assert _detector_future_dated(
        [_t("Acme", "6010", "3000", txn_date=TODAY + timedelta(days=200))],
        [], [], set(), {},
    ) == []


def test_an_unparseable_date_is_skipped_not_guessed():
    assert _run(_detector_future_dated,
                [_t("Acme", "6010", "3000", txn_date="not a date")], []) == []


# ── Missing payee ──────────────────────────────────────────────────────────

def test_a_material_expense_with_no_payee_is_flagged():
    flags = _run(_detector_missing_payee,
                 [_t("", "6010", "7000", txn_id="m1", txn_type="Expense")], [])
    assert len(flags) == 1
    assert flags[0]["kind"] == KIND_MISSING_PAYEE
    assert flags[0]["vendor"] == "(no payee)"


def test_journals_transfers_and_deposits_are_exempt():
    """A blank name on these is normal bookkeeping. Flagging every accrual JE
    would train people to ignore the check inside a week."""
    for t in ("Journal Entry", "Transfer", "Deposit"):
        assert _run(_detector_missing_payee,
                    [_t("", "6010", "9000", txn_type=t)], []) == [], t


def test_an_entry_that_has_a_payee_is_not_flagged():
    assert _run(_detector_missing_payee,
                [_t("Acme", "6010", "9000", txn_type="Expense")], []) == []


def test_whitespace_is_not_a_payee():
    flags = _run(_detector_missing_payee,
                 [_t("   ", "6010", "9000", txn_type="Expense")], [])
    assert len(flags) == 1


def test_a_small_entry_with_no_payee_is_below_materiality():
    assert _run(_detector_missing_payee,
                [_t("", "6010", "80", txn_type="Expense")], []) == []


# ── Registered and reachable ───────────────────────────────────────────────

def test_the_new_detectors_run_from_the_registry():
    """A detector that isn't in DETECTORS is dead code — it passes its own unit
    tests forever and never sees a real ledger."""
    current = [
        _t("Northwind Consulting", "6010", "4200", txn_id="n1", txn_date=TODAY),
        _t("Someone", "6300", "14000", acct_name="Repairs", txn_id="r1", txn_date=TODAY),
        _t("Acme", "6010", "3000", txn_id="f1", txn_date=TODAY + timedelta(days=200)),
        _t("", "6010", "7000", txn_id="m1", txn_type="Expense", txn_date=TODAY),
    ]
    history = _known_vendors() + _months("6300", "2000")
    kinds = {f["kind"] for f in run_detectors(current, history, opts={"today": TODAY})}
    for k in (KIND_NEW_VENDOR, KIND_ACCOUNT_SPIKE, KIND_FUTURE_DATED, KIND_MISSING_PAYEE):
        assert k in kinds, f"{k} never fired through run_detectors"


def test_clean_books_produce_nothing():
    """The whole point of the daily watch is silence on a quiet day — the sweep
    only speaks when there is something new, so a detector that always finds
    something would email every workspace every morning."""
    current = [_t("Vendor 1", "6010", "300", txn_date=TODAY),
               _t("Vendor 2", "6010", "250", txn_date=TODAY)]
    history = _known_vendors() + _months("6010", "600")
    flags = run_detectors(current, history, opts={"today": TODAY})
    noisy = [f for f in flags if f["kind"] in
             (KIND_NEW_VENDOR, KIND_ACCOUNT_SPIKE, KIND_FUTURE_DATED, KIND_MISSING_PAYEE)]
    assert noisy == [], f"clean books produced {[f['title'] for f in noisy]}"
