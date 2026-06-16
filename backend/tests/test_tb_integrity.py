"""
Invariant: trial-balance ingest integrity (`tb_imbalance`).

A real QBO trial balance always ties (Σdebits == Σcredits). tb_imbalance is how
the sync decides whether OUR parse is complete — a non-zero result means a cell
was dropped or misread, so the snapshot can't be trusted (it gates period close
via period_sync.tb_balanced). This locks the math so a regression that always
returns 0 — silently passing a broken parse — fails CI.

Pure (no DB / async), so it also runs standalone:
    python tests/test_tb_integrity.py
"""
from decimal import Decimal

from core.qbo_tb import tb_imbalance


def test_balanced_tb_is_zero():
    tb = {"debit_total": Decimal("125000.00"), "credit_total": Decimal("125000.00"), "rows": 40}
    assert tb_imbalance(tb) == Decimal("0.00"), tb_imbalance(tb)


def test_debit_heavy_is_positive():
    tb = {"debit_total": Decimal("125000.00"), "credit_total": Decimal("124000.00")}
    assert tb_imbalance(tb) == Decimal("1000.00"), tb_imbalance(tb)


def test_credit_heavy_is_negative():
    tb = {"debit_total": Decimal("100000.00"), "credit_total": Decimal("100250.50")}
    assert tb_imbalance(tb) == Decimal("-250.50"), tb_imbalance(tb)


def test_missing_totals_read_as_zero():
    # A partial / legacy TbBalances with no totals must read as balanced (0),
    # never crash — the function uses .get() defaults.
    assert tb_imbalance({"rows": 0}) == Decimal("0.00")
    assert tb_imbalance({}) == Decimal("0.00")


def test_result_is_quantized_to_cents():
    # Sub-cent input is rounded to 2dp so the close-gate compare is stable.
    out = tb_imbalance({"debit_total": Decimal("100.005"), "credit_total": Decimal("0")})
    assert out.as_tuple().exponent == -2, out


if __name__ == "__main__":
    test_balanced_tb_is_zero()
    test_debit_heavy_is_positive()
    test_credit_heavy_is_negative()
    test_missing_totals_read_as_zero()
    test_result_is_quantized_to_cents()
    print("TB_INTEGRITY_OK")
