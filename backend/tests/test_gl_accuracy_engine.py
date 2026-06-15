"""Unit tests for the GL Accuracy detection engine (pure, no DB).

The reputation risk is a FALSE accusation, so the no-flag cases — legitimate
splits, thin history, sub-materiality, confirmed exceptions — are tested as hard
as the positive ones. `detect_misclassifications` is pure, so these are fast.
"""
from modules.gl_accuracy.engine import build_vendor_distribution, detect_misclassifications


def _t(vendor, acct, amount="500", acct_name=None, txn_id=None):
    return {
        "entity_name": vendor, "qbo_account_id": acct, "qbo_account_name": acct_name or f"Acct {acct}",
        "amount": amount, "qbo_txn_id": txn_id, "txn_type": "Bill", "txn_number": "", "txn_date": None, "memo": "",
    }


def _hist(vendor, acct, n, **kw):
    return [_t(vendor, acct, **kw) for _ in range(n)]


# ── Positive: a clear miscode is flagged ───────────────────────────────────────

def test_clear_miscode_high_confidence():
    history = _hist("AWS", "6010", 11, acct_name="Hosting")
    current = [_t("AWS", "6400", "1240", acct_name="Office Supplies", txn_id="tx1")]
    flags = detect_misclassifications(current, history)
    assert len(flags) == 1
    f = flags[0]
    assert f["suggested_account_id"] == "6010" and f["posted_account_id"] == "6400"
    assert f["dominant_count"] == 11 and f["total_count"] == 11
    assert f["confidence"] == "high"


def test_dominant_but_thin_or_imperfect_is_medium():
    # 6 of 8 → A (75%, < high threshold), this one to a rare account → medium.
    history = _hist("Zoom", "6020", 6, acct_name="Software") + _hist("Zoom", "6230", 2, acct_name="Travel")
    current = [_t("Zoom", "6400", "300", acct_name="Office Supplies", txn_id="z1")]
    flags = detect_misclassifications(current, history)
    assert len(flags) == 1 and flags[0]["confidence"] == "medium"
    assert flags[0]["suggested_account_id"] == "6020"


# ── No false positives — the reputation-critical cases ─────────────────────────

def test_legitimate_split_account_not_flagged():
    # Vendor regularly uses BOTH 6230 (8) and 6240 (4). A new entry to 6240 is a
    # normal split, not a miscode — must NOT be flagged.
    history = _hist("Uber", "6230", 8, acct_name="Travel") + _hist("Uber", "6240", 4, acct_name="Meals")
    current = [_t("Uber", "6240", "60", acct_name="Meals", txn_id="u1")]
    assert detect_misclassifications(current, history) == []


def test_thin_history_never_flags():
    history = _hist("NewCo", "6010", 3, acct_name="Hosting")  # below min_history=4
    current = [_t("NewCo", "6400", "900", acct_name="Office Supplies", txn_id="n1")]
    assert detect_misclassifications(current, history) == []


def test_below_materiality_skipped():
    history = _hist("AWS", "6010", 11, acct_name="Hosting")
    current = [_t("AWS", "6400", "10", acct_name="Office Supplies", txn_id="t1")]  # $10 < $25 floor
    assert detect_misclassifications(current, history) == []


def test_posting_to_habit_account_not_flagged():
    history = _hist("AWS", "6010", 11, acct_name="Hosting")
    current = [_t("AWS", "6010", "1240", acct_name="Hosting", txn_id="t1")]  # correctly coded
    assert detect_misclassifications(current, history) == []


def test_weak_dominance_not_flagged():
    # No habit: 5 → A, 5 → B (50/50). Neither is dominant; never flag.
    history = _hist("Split", "6010", 5, acct_name="A") + _hist("Split", "6020", 5, acct_name="B")
    current = [_t("Split", "6400", "500", acct_name="C", txn_id="s1")]
    assert detect_misclassifications(current, history) == []


def test_confirmed_exception_suppressed():
    history = _hist("AWS", "6010", 11, acct_name="Hosting")
    current = [_t("AWS", "6400", "1240", acct_name="Office Supplies", txn_id="t1")]
    exc = {("aws", "6400")}  # reviewer already said this pairing is correct
    assert detect_misclassifications(current, history, exceptions=exc) == []


def test_vendorless_and_accountless_rows_ignored():
    history = _hist("AWS", "6010", 11, acct_name="Hosting")
    current = [
        _t("", "6400", "1240", txn_id="t1"),            # no vendor (e.g. a JE)
        _t("AWS", "", "1240", txn_id="t2"),             # no account
    ]
    assert detect_misclassifications(current, history) == []


# ── Mechanics ──────────────────────────────────────────────────────────────────

def test_distribution_counts_and_skips_blanks():
    rows = _hist("AWS", "6010", 3) + [_t("", "6010"), _t("AWS", "")]
    d = build_vendor_distribution(rows)
    assert d["aws"]["total"] == 3 and d["aws"]["accounts"]["6010"]["count"] == 3


def test_credit_amount_still_flagged_and_signed_preserved():
    history = _hist("AWS", "6010", 11, acct_name="Hosting")
    current = [_t("AWS", "6400", "-1240", acct_name="Office Supplies", txn_id="t1")]  # a credit/refund
    flags = detect_misclassifications(current, history)
    assert len(flags) == 1 and flags[0]["amount"] == "-1240"  # sign kept for the reclass JE direction


def test_sort_high_then_dollars():
    history = (_hist("AWS", "6010", 11, acct_name="Hosting")
               + _hist("Adobe", "6020", 9, acct_name="Software")
               + _hist("Lyft", "6230", 6, acct_name="Travel"))
    current = [
        _t("Lyft", "6400", "5000", acct_name="Office Supplies", txn_id="big-medium"),  # medium, large $
        _t("AWS", "6400", "100", acct_name="Office Supplies", txn_id="small-high"),    # high, small $
    ]
    flags = detect_misclassifications(current, history)
    assert [f["qbo_txn_id"] for f in flags] == ["small-high", "big-medium"]  # high first
