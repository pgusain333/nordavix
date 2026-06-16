"""
Invariant: the recon tie-out gate (`is_reconciled` + `RECON_TOLERANCE`).

The reconciliation module's core promise is "GL ties to the subledger." This
locks the materiality floor and the comparison so a silent change to either —
the $1.00 constant or the abs() logic — fails CI instead of shipping. Without
it, a regression could let a materially-unreconciled account slip through the
approve / close gate (both call is_reconciled server-side).

No DB / async, so this also runs standalone:
    python tests/test_recon_tieout.py
"""
from decimal import Decimal

from modules.recons.overview import RECON_TOLERANCE, is_reconciled


def test_tolerance_is_one_dollar():
    # The hard backend floor. If this constant ever changes, that should be a
    # deliberate decision that fails this test and gets updated here on purpose —
    # never a silent drift.
    assert Decimal("1.00") == RECON_TOLERANCE, RECON_TOLERANCE


def test_exact_tie_reconciles():
    assert is_reconciled(Decimal("10000.00"), Decimal("10000.00")) is True
    assert is_reconciled(Decimal("0"), Decimal("0")) is True


def test_within_tolerance_reconciles():
    # Penny diffs and a diff sitting exactly on the floor both pass (<=).
    assert is_reconciled(Decimal("10000.00"), Decimal("9999.50")) is True
    assert is_reconciled(Decimal("10000.00"), Decimal("9999.00")) is True    # exactly 1.00
    assert is_reconciled(Decimal("10000.00"), Decimal("10001.00")) is True   # exactly 1.00 other way


def test_over_tolerance_does_not_reconcile():
    assert is_reconciled(Decimal("10000.00"), Decimal("9998.99")) is False   # 1.01
    assert is_reconciled(Decimal("10000.00"), Decimal("12000.00")) is False


def test_symmetric_in_direction():
    # |gl - subledger| — which side is larger must not matter.
    assert is_reconciled(Decimal("500.50"), Decimal("500.00")) == \
        is_reconciled(Decimal("500.00"), Decimal("500.50"))
    assert is_reconciled(Decimal("502.00"), Decimal("500.00")) is False
    assert is_reconciled(Decimal("500.00"), Decimal("502.00")) is False


def test_negative_balances_liability_style():
    # Liability / equity accounts carry negative signed balances; the gate works
    # the same on the magnitude of the difference.
    assert is_reconciled(Decimal("-5000.00"), Decimal("-5000.00")) is True
    assert is_reconciled(Decimal("-5000.00"), Decimal("-5000.75")) is True   # 0.75
    assert is_reconciled(Decimal("-5000.00"), Decimal("-5002.00")) is False  # 2.00


if __name__ == "__main__":
    test_tolerance_is_one_dollar()
    test_exact_tie_reconciles()
    test_within_tolerance_reconciles()
    test_over_tolerance_does_not_reconcile()
    test_symmetric_in_direction()
    test_negative_balances_liability_style()
    print("RECON_TIEOUT_OK")
