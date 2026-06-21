"""
Invariant: the schedule-subledger PRELOAD path returns byte-for-byte the same
result as the per-account query path.

`modules/recons/overview.py` used to call `_schedule_backed_subledger` once per
schedule-backed account, and each call fired 5-7 queries (one per schedule type)
— an N+1 on every dashboard load. It now preloads every active schedule row once
(`_preload_active_schedules`) and hands the buckets in via `preloaded=`. That is
ONLY safe if a branch fed its preloaded rows produces exactly what it produced
when it queried the DB itself. This locks that equivalence so the optimization
can never silently change a subledger balance.

Two layers:
  • test_bucket_*  — PURE (no DB / no async). Proves `_bucket_schedules` keys
    every branch by the SAME column that branch filters on (the one real risk:
    a wrong bucket key would feed a branch the wrong rows). Runs standalone:
        python -m tests.test_schedule_preload
  • test_preload_matches_per_account_path — DB-backed (CI). Seeds one of every
    schedule type (plus a two-item account) and asserts preloaded == per-account
    for each, end to end through the real calc.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from modules.recons.agentic import _bucket_schedules


# ── Pure: bucketing keys each branch by the correct account column ──────────────
def test_bucket_schedules_keys_by_correct_column():
    prepaid = SimpleNamespace(qbo_account_id="PP")
    accrual = SimpleNamespace(qbo_account_id="AC")
    # Fixed assets bucket TWICE — cost on qbo_account_id, accum-dep on the
    # contra account — because _schedule_backed_subledger has a branch for each.
    fa = SimpleNamespace(qbo_account_id="FA-COST", accumulated_dep_qbo_account_id="FA-DEP")
    # Leases bucket TWICE — liability on qbo_account_id, ROU on rou_qbo_account_id.
    lease = SimpleNamespace(qbo_account_id="LEASE-LIAB", rou_qbo_account_id="LEASE-ROU")
    loan = SimpleNamespace(qbo_account_id="LOAN")

    pre = _bucket_schedules([prepaid], [accrual], [fa], [lease], [loan])

    # Each branch looks itself up by the qbo_account_id it's CALLED with, so the
    # bucket must be keyed on the exact column that branch's WHERE filters on.
    assert pre.prepaid_by_acct == {"PP": [prepaid]}
    assert pre.accrual_by_acct == {"AC": [accrual]}
    assert pre.fa_cost_by_acct == {"FA-COST": [fa]}
    assert pre.fa_dep_by_acct == {"FA-DEP": [fa]}           # contra account, not the cost account
    assert pre.lease_liab_by_acct == {"LEASE-LIAB": [lease]}
    assert pre.lease_rou_by_acct == {"LEASE-ROU": [lease]}  # ROU account, not the liability account
    assert pre.loan_by_acct == {"LOAN": [loan]}


def test_bucket_groups_multiple_items_and_skips_null_keys():
    a = SimpleNamespace(qbo_account_id="X")
    b = SimpleNamespace(qbo_account_id="X")          # same account → grouped
    c = SimpleNamespace(qbo_account_id=None)         # null key → skipped (no crash)
    pre = _bucket_schedules([a, b, c], [], [], [], [])
    assert pre.prepaid_by_acct == {"X": [a, b]}      # both items, insertion order preserved
    assert pre.accrual_by_acct == {}
    assert pre.fa_dep_by_acct == {}                  # absent attr defaults empty, no AttributeError


# ── DB-backed: preloaded path == per-account path, end to end (CI) ──────────────
def _norm(d: dict) -> dict:
    """Order-insensitive view of a subledger result: sl_signed / item_count /
    schedule_type must match exactly; the je_items / sl_entries / payment_entries
    LISTS hold the same set but their order is unspecified per-account (no ORDER
    BY) vs (created_at, id) when preloaded, so compare them as sorted sets."""
    out = dict(d)
    for k in ("je_items", "sl_entries", "payment_entries"):
        if isinstance(out.get(k), list):
            out[k] = sorted(out[k], key=lambda row: repr(sorted(row.items())))
    return out


async def test_preload_matches_per_account_path(session, tenant_a):
    from core.db.base import current_tenant_id
    from models.schedule import (
        ScheduleAccrual,
        ScheduleFixedAsset,
        ScheduleLease,
        ScheduleLoan,
        SchedulePrepaid,
    )
    from models.tenant import Tenant
    from modules.recons.agentic import (
        _preload_active_schedules,
        _schedule_backed_subledger,
    )

    current_tenant_id.set(tenant_a)
    pe = date(2025, 3, 31)
    t = tenant_a

    # Parent tenant row FIRST: the schedule tables FK tenant_id -> tenants.id in
    # the migrated (CI) schema, so the parent must exist before any child insert.
    # (The ORM create_all schema used locally omits this FK — which is exactly why
    # a test can pass locally yet fail under CI's `alembic upgrade head`.)
    session.add(Tenant(id=t, name="Test Co", clerk_org_id=f"org-{t}"))
    await session.flush()

    session.add_all([
        # Two prepaids on ONE account — exercises bucket grouping for an account
        # that resolves to more than one schedule item.
        SchedulePrepaid(tenant_id=t, qbo_account_id="PP", description="Insurance A",
                        invoice_date=date(2025, 1, 1), total_amount=Decimal("1200"),
                        start_date=date(2025, 1, 1), end_date=date(2025, 12, 31),
                        amortization_method="straight_line"),
        SchedulePrepaid(tenant_id=t, qbo_account_id="PP", description="Insurance B",
                        invoice_date=date(2025, 2, 1), total_amount=Decimal("600"),
                        start_date=date(2025, 2, 1), end_date=date(2025, 7, 31),
                        amortization_method="straight_line"),
        ScheduleAccrual(tenant_id=t, qbo_account_id="AC", description="Accrued bonus",
                        accrual_date=date(2025, 3, 1), amount=Decimal("500")),
        # One fixed asset → feeds BOTH the cost branch ("FA") and the
        # accumulated-depreciation branch ("AD").
        ScheduleFixedAsset(tenant_id=t, qbo_account_id="FA", description="Laptop",
                           in_service_date=date(2025, 1, 1), cost=Decimal("3600"),
                           useful_life_months=36, accumulated_dep_qbo_account_id="AD"),
        # One ASC 842 lease → feeds BOTH the liability branch ("LL") and the
        # ROU branch ("RU"). discount_rate + initial_liability make the
        # liability branch active; initial_rou_asset makes the ROU branch active.
        ScheduleLease(tenant_id=t, qbo_account_id="LL", description="Office lease",
                      lease_start=date(2025, 1, 1), lease_end=date(2027, 12, 31),
                      monthly_payment=Decimal("1000"), discount_rate_pct=Decimal("6.0"),
                      initial_liability=Decimal("30000"), initial_rou_asset=Decimal("30000"),
                      rou_qbo_account_id="RU"),
        ScheduleLoan(tenant_id=t, qbo_account_id="LN", description="Term loan",
                     loan_date=date(2025, 1, 1), original_principal=Decimal("50000"),
                     interest_rate_pct=Decimal("8.0"), term_months=60,
                     monthly_payment=Decimal("1013.82"), payment_type="amortizing"),
    ])
    await session.flush()

    pre = await _preload_active_schedules(session)

    for acct in ["PP", "AC", "FA", "AD", "LL", "RU", "LN"]:
        base = await _schedule_backed_subledger(session, t, acct, pe, preloaded=None)
        fast = await _schedule_backed_subledger(session, t, acct, pe, preloaded=pre)
        assert base is not None, f"{acct}: per-account path returned None (test seed wrong)"
        assert fast is not None, f"{acct}: preloaded path returned None"
        # The accounting-critical numbers must be IDENTICAL; the JE/entry lists
        # must hold the same set (order-insensitive — see _norm).
        assert base["sl_signed"] == fast["sl_signed"], f"{acct}: sl_signed differs"
        assert base["item_count"] == fast["item_count"], f"{acct}: item_count differs"
        assert base["schedule_type"] == fast["schedule_type"], f"{acct}: schedule_type differs"
        assert _norm(base) == _norm(fast), f"{acct}: full result differs"

    # An account with no schedule resolves to None on both paths.
    assert await _schedule_backed_subledger(session, t, "NONE", pe, preloaded=None) is None
    assert await _schedule_backed_subledger(session, t, "NONE", pe, preloaded=pre) is None


if __name__ == "__main__":
    # Pure tests only (the DB test needs the pytest `session` fixture).
    test_bucket_schedules_keys_by_correct_column()
    test_bucket_groups_multiple_items_and_skips_null_keys()
    print("SCHEDULE_PRELOAD_BUCKETING_OK")
