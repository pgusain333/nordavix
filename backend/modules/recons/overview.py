"""
Reconciliation overview — snapshot-first dashboard view.

How the data flows (post-refactor):

  POST /sync (explicit user action)
      ├── QBO TrialBalance     → gl_balance_snapshots
      ├── QBO Account list     → gl_balance_snapshots (metadata)
      ├── QBO AR/AP aging      → period_sync.ar/ap_aging_total
      └── QBO P&L (YTD)        → period_sync.actual_net_income

  GET /overview (every dashboard render, month-tile click, navigation)
      └── reads from gl_balance_snapshots + period_sync + account_review_status
          NO QBO CALLS — pure DB → instant.

This means navigation between months is free, and the user controls when
the data refreshes. If a period has never been synced (no `period_sync`
row) the endpoint returns `synced: false` with empty accounts; the UI
shows the existing "Sync from QuickBooks" CTA.

Per-account drill-in endpoints (`/account/{id}/subledger`,
`/account/{id}/variance`) still call QBO live — they're explicit click
actions where a short wait is expected, and the detail shapes (per-
customer/vendor lists, GL transactions) aren't snapshotted.

Subledger derivation per account type (unchanged):
  - Bank, Credit Card       → matches GL (no separate subledger)
  - Accounts Receivable     → sum of customer balances on AR aging report
                              (proportional split when multiple AR accounts)
  - Accounts Payable        → sum of vendor balances on AP aging report
  - All other account types → matches GL (no QBO subledger exists)
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from core.qbo_tb import TbBalances

from sqlalchemy.ext.asyncio import AsyncSession

from models.qbo_connection import QboConnection
from modules.recons.service import (
    _dec,
    _flatten_report_rows,
    _qbo_get,
    _refresh_token_if_needed,  # noqa: F401  re-used indirectly via _qbo_get
)

logger = logging.getLogger(__name__)


# ── QBO AccountType → display group ──────────────────────────────────────────

# Tells the UI how to label/group the row + which subledger logic to apply.
ACCOUNT_TYPE_GROUPS: dict[str, str] = {
    "Bank":                       "Bank",
    "Credit Card":                "Credit Card",
    "Accounts Receivable":        "AR",
    "Accounts Payable":           "AP",
    "Fixed Asset":                "Fixed Assets",
    "Other Current Asset":        "Other Current Assets",
    "Other Asset":                "Other Assets",
    "Other Current Liability":    "Other Current Liabilities",
    "Long Term Liability":        "Long Term Liabilities",
    "Equity":                     "Equity",
}

# Account types we never reconcile (income statement accounts)
SKIP_ACCOUNT_TYPES = {"Income", "Cost of Goods Sold", "Expense", "Other Income", "Other Expense"}


# ── Public functions ─────────────────────────────────────────────────────────

async def sync_overview(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> dict:
    """
    EXPLICIT SYNC PATH — called only by POST /sync. Pulls fresh data from
    QuickBooks (TrialBalance, Account list, AR/AP aging, YTD P&L), writes
    snapshots, then returns the same dict shape as `read_overview_from_snapshots`.

    Heavy: 5-8 QBO API calls. The user clicked Sync, they expect a wait.
    """
    import uuid as _uuid

    from core.db.base import current_tenant_id
    from core.gl_snapshot import capture_snapshot
    from models.period_sync import PeriodSync
    from sqlalchemy import select as _select

    tid = current_tenant_id.get()
    if tid is None:
        return _empty_overview(period_end, synced=False)

    accounts_meta = await _list_balance_sheet_accounts(conn, session)
    if not accounts_meta:
        return _empty_overview(period_end, synced=False)

    # Capture per-account GL balances (BS + P&L) → gl_balance_snapshots.
    # capture_snapshot pre-pulls the QBO TrialBalance itself, so we
    # reuse its result via a fresh _qbo_trial_balance_by_account call —
    # not ideal but the parsed shape is different and refactoring the
    # capture function to share is more churn than it's worth.
    try:
        await capture_snapshot(session, tid, period_end, conn=conn)
    except Exception:
        logger.exception("GL snapshot capture failed for %s — continuing", period_end)

    tb_balances = await _qbo_trial_balance_by_account(conn, session, period_end)

    # Pull AR / AP aging totals + persist for instant subsequent reads.
    ar_aging_sum = await _aging_total(conn, session, "AgedReceivables", period_end)
    ap_aging_sum = await _aging_total(conn, session, "AgedPayables", period_end)

    # Pull YTD Net Income for the TB check (independent cross-check
    # against our summed BS account balances).
    actual_ni: Decimal | None = None
    pl_error: str | None = None
    try:
        ytd_start = period_end.replace(month=1, day=1)
        pl_report = await _qbo_get(
            conn, session,
            "/reports/ProfitAndLoss",
            params={
                "start_date":        ytd_start.isoformat(),
                "end_date":          period_end.isoformat(),
                "accounting_method": "Accrual",
                "minorversion":      "65",
            },
        )
        actual_ni = _extract_net_income(pl_report)
        if actual_ni is None:
            pl_error = "Could not find Net Income row in P&L report."
    except Exception:
        logger.exception("ProfitAndLoss pull failed during sync_overview")
        pl_error = "Could not pull ProfitAndLoss report from QuickBooks."

    # Upsert period_sync row so future GET /overview reads serve from DB.
    existing = (await session.execute(
        _select(PeriodSync).where(
            PeriodSync.tenant_id == tid,
            PeriodSync.period_end == period_end,
        )
    )).scalar_one_or_none()
    if existing is None:
        session.add(PeriodSync(
            id=_uuid.uuid4(),
            tenant_id=tid,
            period_end=period_end,
            ar_aging_total=ar_aging_sum.quantize(Decimal("0.01")),
            ap_aging_total=ap_aging_sum.quantize(Decimal("0.01")),
            actual_net_income=actual_ni.quantize(Decimal("0.01")) if actual_ni is not None else None,
            pl_error=pl_error,
        ))
    else:
        existing.ar_aging_total = ar_aging_sum.quantize(Decimal("0.01"))
        existing.ap_aging_total = ap_aging_sum.quantize(Decimal("0.01"))
        existing.actual_net_income = actual_ni.quantize(Decimal("0.01")) if actual_ni is not None else None
        existing.pl_error = pl_error
        existing.synced_at = datetime.utcnow()
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        logger.exception("period_sync upsert failed for %s", period_end)

    # Build the overview from the freshly-captured data (skip the DB
    # read — we already have everything in memory).
    return await _build_overview_from_qbo_data(
        session=session,
        accounts_meta=accounts_meta,
        tb_balances=tb_balances,
        ar_aging_sum=ar_aging_sum,
        ap_aging_sum=ap_aging_sum,
        actual_ni=actual_ni,
        pl_error=pl_error,
        period_end=period_end,
    )


async def read_overview_from_snapshots(
    session: AsyncSession,
    period_end: date,
) -> dict:
    """
    DEFAULT READ PATH — called by GET /overview on every dashboard render
    and every month-tile click. Pure DB query, ~50ms. No QBO calls.

    Returns the same dict shape as `sync_overview`. If the period has
    never been synced (no period_sync row), returns `synced: false`
    with empty accounts so the UI can show the "Click Sync" CTA.
    """
    from core.db.base import current_tenant_id
    from models.gl_balance_snapshot import GlBalanceSnapshot
    from models.period_sync import PeriodSync
    from sqlalchemy import select as _select

    tid = current_tenant_id.get()
    if tid is None:
        return _empty_overview(period_end, synced=False)

    ps = (await session.execute(
        _select(PeriodSync).where(
            PeriodSync.tenant_id == tid,
            PeriodSync.period_end == period_end,
        )
    )).scalar_one_or_none()
    if ps is None:
        # Never synced for this period → return empty + synced=False so
        # the dashboard renders the "Sync from QuickBooks" CTA card.
        return _empty_overview(period_end, synced=False)

    # Pull every snapshot row for this period (one query).
    snap_rows = list((await session.execute(
        _select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.tenant_id == tid,
            GlBalanceSnapshot.period_end == period_end,
        )
    )).scalars().all())
    if not snap_rows:
        return _empty_overview(period_end, synced=False)

    # Convert snapshot rows into the accounts_meta shape that the shared
    # builder expects. Filter out P&L accounts — those are captured for
    # the financials module but don't belong in the recons overview.
    accounts_meta = [
        {
            "Id":           s.qbo_account_id,
            "Name":         s.account_name,
            "AcctNum":      s.account_number or "",
            "AccountType":  s.account_type,
        }
        for s in snap_rows
        if s.account_type in ACCOUNT_TYPE_GROUPS
    ]
    # In-memory TbBalances shape so _tb_lookup works against snapshots.
    tb_balances: dict = {
        "by_id":   {s.qbo_account_id: s.balance for s in snap_rows},
        "by_name": {s.account_name.lower(): s.balance for s in snap_rows},
        "rows":    len(snap_rows),
    }
    return await _build_overview_from_qbo_data(
        session=session,
        accounts_meta=accounts_meta,
        tb_balances=tb_balances,  # type: ignore[arg-type]
        ar_aging_sum=ps.ar_aging_total,
        ap_aging_sum=ps.ap_aging_total,
        actual_ni=ps.actual_net_income,
        pl_error=ps.pl_error,
        period_end=period_end,
        synced_at=ps.synced_at,
    )


# Back-compat alias — older code paths can keep importing fetch_overview.
# New code should call sync_overview or read_overview_from_snapshots
# explicitly.
async def fetch_overview(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> dict:
    return await sync_overview(conn, session, period_end)


async def _build_overview_from_qbo_data(
    *,
    session: AsyncSession,
    accounts_meta: list[dict],
    tb_balances: TbBalances,
    ar_aging_sum: Decimal,
    ap_aging_sum: Decimal,
    actual_ni: Decimal | None,
    pl_error: str | None,
    period_end: date,
    synced_at: datetime | None = None,
) -> dict:
    """
    Shared overview-builder used by both sync_overview (fresh QBO data
    in memory) and read_overview_from_snapshots (data assembled from
    snapshots). Identical output shape regardless of source.
    """

    # Sum of GL balances across all AR accounts (and AP accounts) so we can
    # apportion when there are multiple AR/AP accounts.
    ar_gl_total = sum(
        _tb_lookup(tb_balances, a) for a in accounts_meta if a["AccountType"] == "Accounts Receivable"
    )
    ap_gl_total = sum(
        _tb_lookup(tb_balances, a) for a in accounts_meta if a["AccountType"] == "Accounts Payable"
    )

    # Load persisted per-account review status for this period (one query).
    # The dashboard merges this into each account row so the user sees their
    # own approval state for the period they're looking at.
    from sqlalchemy import select

    from models.account_review_status import AccountReviewStatus
    from models.subledger_evidence import SubledgerEvidence
    status_rows = list((await session.execute(
        select(AccountReviewStatus).where(AccountReviewStatus.period_end == period_end)
    )).scalars().all())
    status_by_acct: dict[str, AccountReviewStatus] = {
        s.qbo_account_id: s for s in status_rows
    }

    # Also load every PRIOR-period override per account so we can default the
    # current period's subledger to the most recent prior closing — the
    # roll-forward. Without this the dashboard auto-matches AR/AP to their
    # aging totals, hiding the actual variance the user needs to investigate.
    # We sort desc by period_end and keep the FIRST row per account = most
    # recent prior.
    prior_rows = list((await session.execute(
        select(AccountReviewStatus)
        .where(AccountReviewStatus.period_end < period_end)
        .where(AccountReviewStatus.subledger_total.is_not(None))
        .order_by(AccountReviewStatus.qbo_account_id, AccountReviewStatus.period_end.desc())
    )).scalars().all())
    prior_by_acct: dict[str, AccountReviewStatus] = {}
    for r in prior_rows:
        if r.qbo_account_id not in prior_by_acct:
            prior_by_acct[r.qbo_account_id] = r

    # Pull the actual evidence rows so the dashboard can render an inline
    # "attachments" column with click-to-download — no second fetch needed.
    # Bounded per-period set; one query, fan out in memory below.
    ev_rows = list((await session.execute(
        select(SubledgerEvidence).where(SubledgerEvidence.period_end == period_end)
    )).scalars().all())
    evidence_by_acct: dict[str, list[SubledgerEvidence]] = {}
    for e in ev_rows:
        evidence_by_acct.setdefault(e.qbo_account_id, []).append(e)

    out_accounts: list[dict] = []
    for a in accounts_meta:
        acct_type = a.get("AccountType", "")
        group = ACCOUNT_TYPE_GROUPS.get(acct_type)
        if group is None:
            # Unknown or skip-list — don't surface
            continue

        gl_balance = _tb_lookup(tb_balances, a)
        qbo_id = str(a.get("Id"))
        review = status_by_acct.get(qbo_id)

        # Subledger resolution priority:
        #   1) Current-period manual override (what the user explicitly saved
        #      for this exact period) — final answer, takes precedence.
        #   2) Most recent PRIOR override — rolled forward. This is the
        #      starting point for reconciliation; user opens the row, sees
        #      the gap vs GL, ticks reconciling items to close it.
        #   3) QBO-computed default (AR aging total, AP aging, GL fallback)
        #      — only when no history exists for this account.
        is_manual = review is not None and review.subledger_total is not None
        prior_review = prior_by_acct.get(qbo_id)
        if is_manual:
            subledger_balance = review.subledger_total
            source = review.subledger_source or "Manually entered"
            has_detail = True
        elif prior_review is not None and prior_review.subledger_total is not None:
            subledger_balance = prior_review.subledger_total
            source = (
                f"Rolled forward from {prior_review.period_end} closing — "
                "open the row to add reconciling items and adjust to current period."
            )
            has_detail = True
        else:
            subledger_balance, source, has_detail = _subledger_for_account(
                acct_type=acct_type,
                gl_balance=gl_balance,
                ar_aging_sum=ar_aging_sum,
                ap_aging_sum=ap_aging_sum,
                ar_gl_total=ar_gl_total,
                ap_gl_total=ap_gl_total,
            )

        variance = (gl_balance - subledger_balance).quantize(Decimal("0.01"))

        out_accounts.append({
            "qbo_id":              qbo_id,
            "account_number":      a.get("AcctNum") or "",
            "account_name":        a.get("Name") or "",
            "account_type":        acct_type,
            "group_label":         group,
            "gl_balance":          str(gl_balance.quantize(Decimal("0.01"))),
            "subledger_balance":   str(subledger_balance.quantize(Decimal("0.01"))),
            "subledger_source":    source,
            "subledger_is_manual": is_manual,
            "subledger_is_rollforward": (
                not is_manual
                and prior_review is not None
                and prior_review.subledger_total is not None
            ),
            "rollforward_from":    prior_review.period_end.isoformat()
                                    if prior_review and not is_manual else None,
            "subledger_entered_by": str(review.subledger_entered_by)
                                    if (review and review.subledger_entered_by) else None,
            "subledger_entered_at": review.subledger_entered_at.isoformat()
                                    if (review and review.subledger_entered_at) else None,
            "evidence_count":      len(evidence_by_acct.get(qbo_id, [])),
            "evidence_files":      [
                {
                    "id":           str(f.id),
                    "file_name":    f.file_name,
                    "mime_type":    f.mime_type,
                    "uploaded_at":  f.uploaded_at.isoformat() if f.uploaded_at else None,
                }
                # Most-recent first so the row-level download button hits the
                # latest attachment when the user clicks it.
                for f in sorted(
                    evidence_by_acct.get(qbo_id, []),
                    key=lambda x: x.uploaded_at or datetime.min,
                    reverse=True,
                )
            ],
            "reconciling_items":   review.reconciling_items if review else [],
            "has_subledger_detail":has_detail,
            "variance":            str(variance),
            "review_status":       review.status if review else "pending",
            "reviewed_by":         str(review.reviewed_by) if review and review.reviewed_by else None,
            "reviewed_at":         review.reviewed_at.isoformat() if review and review.reviewed_at else None,
            "review_notes":        review.notes if review else None,
        })

    # Sort: by group, then by account number
    out_accounts.sort(key=lambda x: (x["group_label"], x["account_number"]))

    totals_gl  = sum((_dec(a["gl_balance"]) for a in out_accounts), Decimal("0"))
    totals_sub = sum((_dec(a["subledger_balance"]) for a in out_accounts), Decimal("0"))
    totals_var = (totals_gl - totals_sub).quantize(Decimal("0.01"))

    # Group rollups
    by_group_map: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "count": 0, "gl": Decimal("0"), "subledger": Decimal("0"),
    })
    for a in out_accounts:
        g = by_group_map[a["group_label"]]
        g["count"] += 1
        g["gl"]        += _dec(a["gl_balance"])
        g["subledger"] += _dec(a["subledger_balance"])

    by_group = [
        {
            "group":     name,
            "count":     v["count"],
            "gl":        str(v["gl"].quantize(Decimal("0.01"))),
            "subledger": str(v["subledger"].quantize(Decimal("0.01"))),
            "variance":  str((v["gl"] - v["subledger"]).quantize(Decimal("0.01"))),
        }
        for name, v in sorted(by_group_map.items())
    ]

    # Trial-balance proof: assets − (liab+equity) should equal P&L net
    # income for the YTD period. `actual_ni` is now passed in by both
    # callers (sync_overview pulls it fresh; read_overview_from_snapshots
    # reads it from period_sync), so we never call QBO here — the entire
    # builder is pure CPU + DB work.
    tb_check = _build_tb_check(period_end, out_accounts, actual_ni, pl_error)

    return {
        "period_end": period_end.isoformat(),
        "accounts":   out_accounts,
        "totals": {
            "gl":        str(totals_gl.quantize(Decimal("0.01"))),
            "subledger": str(totals_sub.quantize(Decimal("0.01"))),
            "variance":  str(totals_var),
        },
        "by_group":  by_group,
        "tb_check":  tb_check,
        # Tells the UI: real data backs this view. False (in
        # _empty_overview) means the period has never been synced.
        "synced":    True,
        "synced_at": synced_at.isoformat() if synced_at else None,
    }


async def fetch_subledger_detail(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> dict:
    """
    Per-account subledger explanation. The shape depends on AccountType:

      AR  → list of customers with aging buckets that roll up to this account's
            apportioned share of total AR (or full AR aging if only one AR
            account).
      AP  → list of vendors with aging buckets (same logic).
      Bank/CC → list of last-90-day transactions touching the account.
      Other  → list of last-90-day journal entry lines touching the account.

    Returns:
      {
        "account": { qbo_id, name, account_type, gl_balance, subledger_balance },
        "rows": [ { label, qbo_id?, current, 1-30, 31-60, 61-90, over_90, total, ... } ],
        "source": "human-readable label",
      }
    """
    accts = await _list_balance_sheet_accounts(conn, session)
    acct = next((a for a in accts if str(a.get("Id")) == str(qbo_account_id)), None)
    if acct is None:
        return {"account": None, "rows": [], "source": "Account not found in QuickBooks."}

    acct_type = acct.get("AccountType", "")
    tb_balances = await _qbo_trial_balance_by_account(conn, session, period_end)
    gl_balance = _tb_lookup(tb_balances, acct)

    base = {
        "account": {
            "qbo_id":         acct.get("Id"),
            "name":           acct.get("Name"),
            "account_number": acct.get("AcctNum") or "",
            "account_type":   acct_type,
            "gl_balance":     str(gl_balance.quantize(Decimal("0.01"))),
        },
    }

    if acct_type == "Accounts Receivable":
        rows, label = await _ar_subledger_rows(conn, session, period_end)
        return {**base, "rows": rows, "source": label}
    if acct_type == "Accounts Payable":
        rows, label = await _ap_subledger_rows(conn, session, period_end)
        return {**base, "rows": rows, "source": label}
    if acct_type in ("Bank", "Credit Card"):
        rows, label = await _txn_rows_for_account(conn, session, acct.get("Id"), period_end)
        return {**base, "rows": rows, "source": label}

    # Generic — show JE lines + any other txns that hit the account
    rows, label = await _je_rows_for_account(conn, session, acct.get("Id"), period_end)
    return {**base, "rows": rows, "source": label}


async def fetch_variance_detail(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> dict:
    """
    Show every transaction posted to this account in the last 90 days, via
    QBO's GeneralLedger report. Same approach as flux variance drill-in so
    totals reconcile uniformly across both modules.

    For AR/AP accounts we also annotate JEs that lack a customer/vendor ref
    — those are the canonical drivers of an aging-vs-GL gap.
    """
    from datetime import timedelta

    from core.qbo_gl import pull_gl_transactions

    accts = await _list_balance_sheet_accounts(conn, session)
    acct = next((a for a in accts if str(a.get("Id")) == str(qbo_account_id)), None)
    if acct is None:
        return {"rows": [], "source": "Account not found.", "total": "0"}

    period_start = period_end - timedelta(days=90)
    gl_rows = await pull_gl_transactions(conn, session, qbo_account_id, period_start, period_end)

    target_ar_ap = acct.get("AccountType") in ("Accounts Receivable", "Accounts Payable")
    rows: list[dict] = []
    total = Decimal("0")
    for r in gl_rows:
        amount = r["amount"]
        total += amount
        # For AR/AP, JEs without a customer/vendor in the entity column are
        # the most likely cause of an aging-vs-GL gap — flag them.
        is_je = r["txn_type"].lower() in ("journal entry", "journalentry")
        no_entity = not r["entity_name"]
        flag = "no_entity_ref" if (target_ar_ap and is_je and no_entity) else None
        rows.append({
            "txn_id":     r["qbo_txn_id"] or "",
            "txn_type":   r["txn_type"],
            "txn_number": r["txn_number"] or "",
            "txn_date":   r["txn_date"].isoformat() if r["txn_date"] else "",
            "amount":     str(amount),
            "memo":       r["memo"] or "",
            "entity":     r["entity_name"] or "",
            "flag":       flag,
        })

    label = (
        "Last 90 days of activity on this account from QuickBooks. "
        "JEs flagged as 'no customer/vendor ref' typically explain the GL-vs-subledger gap."
        if target_ar_ap
        else "Last 90 days of activity on this account from QuickBooks (GeneralLedger report)."
    )
    return {
        "rows":   rows,
        "source": label,
        "total":  str(total.quantize(Decimal("0.01"))),
    }


# ── Helpers ──────────────────────────────────────────────────────────────────

# Asset-side groups (debit-natural).
_ASSET_GROUPS = {
    "Bank", "AR", "Fixed Assets",
    "Other Current Assets", "Other Assets",
}

# Liability-side groups (credit-natural).
_LIABILITY_GROUPS = {
    "AP", "Credit Card",
    "Other Current Liabilities", "Long Term Liabilities",
}

# Equity group (credit-natural — Retained Earnings, Common Stock, etc.
# along with contra-equity like Owner's Draw that runs the other way).
_EQUITY_GROUPS = {"Equity"}

# Combined credit-natural set — kept for the sign-flip rules elsewhere
# in the codebase (frontend reconciling-items also imports this list).
_CREDIT_NATURAL_GROUPS = _LIABILITY_GROUPS | _EQUITY_GROUPS


def _classify(group_label: str) -> str | None:
    """Map a group_label to 'asset' / 'liability' / 'equity' / None."""
    if group_label in _ASSET_GROUPS:     return "asset"
    if group_label in _LIABILITY_GROUPS: return "liability"
    if group_label in _EQUITY_GROUPS:    return "equity"
    return None


def _build_tb_check(
    period_end: date,
    accounts: list[dict],
    actual_ni: Decimal | None,
    pl_error: str | None,
) -> dict | None:
    """
    Sync verification via the accounting equation.

    A balanced GL holds:

        Assets − Liabilities − Equity = Net Income (YTD)

    We sum the three sides FROM THE SYNCED PER-ACCOUNT BALANCES (using
    each account's QBO group_label to classify it), then compare against
    the pre-fetched `actual_ni` (pulled once during the explicit Sync
    action and cached in period_sync). If the implied NI matches the
    P&L's reported NI, the sync round-tripped correctly.

    Sign handling (the bug that crashed an earlier version):
      - GL balances are signed: assets debit-positive, liabilities
        and equity credit-negative.
      - Naively summing absolute values flips contra-account signs:
        Owner's Draw (a +debit balance on an Equity-typed account)
        would ADD to equity instead of SUBTRACT. Same for Accumulated
        Depreciation on the asset side.
      - Fix: sum the SIGNED values per side, then negate the credit
        sides at the end. Contra-accounts net correctly in both
        directions.

    Pure CPU — no QBO calls, no DB queries. The expensive `actual_ni`
    fetch happens once per Sync, not once per render.
    """
    sum_assets_signed     = Decimal("0")   # debit-natural, sum as-is
    sum_liab_signed       = Decimal("0")   # credit-natural, will negate
    sum_equity_signed     = Decimal("0")   # credit-natural, will negate
    for a in accounts:
        gl = _dec(a.get("gl_balance", "0"))
        cls = _classify(a.get("group_label", ""))
        if cls == "asset":      sum_assets_signed += gl
        elif cls == "liability": sum_liab_signed   += gl
        elif cls == "equity":    sum_equity_signed += gl

    total_assets      = sum_assets_signed.quantize(Decimal("0.01"))
    total_liabilities = (-sum_liab_signed).quantize(Decimal("0.01"))
    total_equity      = (-sum_equity_signed).quantize(Decimal("0.01"))
    implied_ni = (total_assets - total_liabilities - total_equity).quantize(Decimal("0.01"))

    ytd_start = period_end.replace(month=1, day=1)
    difference: Decimal | None = None
    balanced: bool | None = None
    if actual_ni is not None:
        difference = (implied_ni - actual_ni).quantize(Decimal("0.01"))
        balanced = abs(difference) < Decimal("1.00")  # $1 tolerance for rounding

    return {
        "period_end":         period_end.isoformat(),
        "ytd_start":          ytd_start.isoformat(),
        "total_assets":       str(total_assets),
        "total_liabilities":  str(total_liabilities),
        "total_equity":       str(total_equity),
        "implied_net_income": str(implied_ni),
        "actual_net_income":  str(actual_ni.quantize(Decimal("0.01"))) if actual_ni is not None else None,
        "difference":         str(difference) if difference is not None else None,
        "balanced":           balanced,
        "pl_error":           pl_error,
    }


def _extract_net_income(report: dict) -> Decimal | None:
    """
    QBO's ProfitAndLoss report ends with a NetIncome group row.
    Walk the row tree looking for `group == "NetIncome"` and pull the
    last numeric ColData value (the total column). Tolerant of report
    shapes that vary by accounting method / column config.
    """
    def walk(rows: list[dict]) -> Decimal | None:
        for r in rows:
            if r.get("group") == "NetIncome":
                summary = (r.get("Summary") or {}).get("ColData") or []
                # The last non-empty numeric ColData cell is the total.
                for cell in reversed(summary):
                    v = (cell or {}).get("value")
                    if v in (None, ""):
                        continue
                    try:
                        return _dec(v)
                    except Exception:
                        continue
                return None
            sub = (r.get("Rows") or {}).get("Row") or []
            if sub:
                found = walk(sub)
                if found is not None:
                    return found
        return None

    return walk((report.get("Rows") or {}).get("Row") or [])


async def _list_balance_sheet_accounts(
    conn: QboConnection,
    session: AsyncSession,
) -> list[dict]:
    """Return active accounts whose AccountType is reconcilable."""
    types = list(ACCOUNT_TYPE_GROUPS.keys())
    quoted = ", ".join(f"'{t}'" for t in types)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType, CurrentBalance "
        f"FROM Account WHERE AccountType IN ({quoted}) AND Active = true "
        f"MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("Account list pull failed")
        return []
    return data.get("QueryResponse", {}).get("Account", []) or []


async def _qbo_trial_balance_by_account(
    conn: QboConnection,
    session: AsyncSession,  # kept for backward-compat; unused
    period_end: date,
) -> TbBalances:
    """
    Thin wrapper around the shared core.qbo_tb fetcher + parser.
    Both Reconciliations and Flux Analysis go through core.qbo_tb so
    they're guaranteed to hit QBO with identical parameters and parse
    the response identically.
    """
    from core.qbo_tb import TbBalances, fetch_trial_balance, parse_trial_balance  # noqa: F401
    try:
        report = await fetch_trial_balance(conn, period_end)
    except Exception:
        logger.exception("TrialBalance pull failed for %s", period_end)
        return {"by_id": {}, "by_name": {}, "rows": 0}
    return parse_trial_balance(report)


def _tb_lookup(tb: TbBalances, acct: dict) -> Decimal:
    """
    Look up a QBO account's period-end balance via the canonical helper.
    Returns 0 (with a warning log) on a clean miss — never falls back to
    CurrentBalance which would be a today-value, not period-end.
    """
    from core.qbo_tb import lookup_balance
    acct_id  = str(acct.get("Id") or "")
    name     = str(acct.get("Name") or "").strip()
    acct_num = str(acct.get("AcctNum") or "").strip()
    bal = lookup_balance(tb, qbo_id=acct_id, acct_num=acct_num, name=name)
    if bal is None:
        logger.warning("TB lookup miss: id=%s acctnum=%r name=%r → 0", acct_id, acct_num, name)
        return Decimal("0")
    return bal


async def _aging_total(
    conn: QboConnection,
    session: AsyncSession,
    report_name: str,
    period_end: date,
) -> Decimal:
    """Total of the aging report (AR or AP) at period_end."""
    try:
        report = await _qbo_get(
            conn, session, f"/reports/{report_name}",
            params={"report_date": period_end.isoformat(), "aging_method": "Current"},
        )
    except Exception:
        logger.exception("%s pull failed for %s", report_name, period_end)
        return Decimal("0")

    rows = _flatten_report_rows(report)
    total = Decimal("0")
    aliases = ["Total", "Amount", "Balance"]
    for r in rows:
        name = r.get("col_0", "") or ""
        if str(name).strip().upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        v = None
        for a in aliases:
            if a in r:
                v = r[a]; break
        if v is None:
            v = r.get("col_6", "")  # positional fallback (aging Total column)
        total += _dec(v)
    return total


def _subledger_for_account(
    *,
    acct_type: str,
    gl_balance: Decimal,
    ar_aging_sum: Decimal,
    ap_aging_sum: Decimal,
    ar_gl_total: Decimal,
    ap_gl_total: Decimal,
) -> tuple[Decimal, str, bool]:
    """
    Decide the subledger balance + source label + whether a detail view exists.

    Sign convention:
      - QBO TrialBalance returns BALANCES (debit - credit). Liability/Equity
        accounts have credit balances, so GL comes back NEGATIVE.
      - QBO AgedReceivables / AgedPayables reports always return POSITIVE
        amounts (the balance owed/due as a magnitude).
      - To get a meaningful variance via simple subtraction we must align
        the signs: for natural-credit account types (AP, Credit Card,
        liabilities) we negate the subledger to match GL's natural sign.
    """
    if acct_type == "Accounts Receivable":
        # Apportion the AR aging across multiple AR accounts proportionally.
        # AR is a natural debit — subledger stays positive.
        if ar_gl_total != 0:
            share = gl_balance / ar_gl_total
            return (ar_aging_sum * share).quantize(Decimal("0.01")), \
                   "QuickBooks AgedReceivables report (proportionally allocated when multiple AR accounts exist).", \
                   True
        return ar_aging_sum, "QuickBooks AgedReceivables report.", True

    if acct_type == "Accounts Payable":
        # AP is a natural credit — flip the sign so it lines up with GL's
        # negative balance. Otherwise GL=-1603 vs Sub=+1603 nets to a phantom
        # -3206 variance even though the books actually reconcile.
        if ap_gl_total != 0:
            # ap_gl_total here is also negative (sum of credit balances) —
            # use absolute value for the proportional split so the share
            # itself is positive, then negate the resulting subledger.
            denom = abs(ap_gl_total) or Decimal("1")
            share = abs(gl_balance) / denom
            return (-ap_aging_sum * share).quantize(Decimal("0.01")), \
                   "QuickBooks AgedPayables report (proportionally allocated when multiple AP accounts exist).", \
                   True
        return -ap_aging_sum, "QuickBooks AgedPayables report.", True

    if acct_type in ("Bank", "Credit Card"):
        return gl_balance, "Matches GL — no separate subledger in QuickBooks.", True

    return gl_balance, "Matches GL — this account type has no separate subledger.", True


def _empty_overview(period_end: date, *, synced: bool = False) -> dict:
    return {
        "period_end": period_end.isoformat(),
        "accounts":   [],
        "totals":     {"gl": "0.00", "subledger": "0.00", "variance": "0.00"},
        "by_group":   [],
        # `synced: false` tells the dashboard to render the "Sync from
        # QuickBooks" CTA card instead of the empty-state table.
        "synced":     synced,
        "synced_at":  None,
        "tb_check":   None,
    }


async def _ar_subledger_rows(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> tuple[list[dict], str]:
    """Customer-level aging from AgedReceivables, formatted for the detail drawer."""
    try:
        report = await _qbo_get(
            conn, session, "/reports/AgedReceivables",
            params={"report_date": period_end.isoformat(), "aging_method": "Current"},
        )
    except Exception:
        return [], "Could not fetch AgedReceivables from QuickBooks."

    rows = _flatten_report_rows(report)
    POS = {"current": 1, "1_30": 2, "31_60": 3, "61_90": 4, "over_90": 5, "total": 6}

    def cell(r: dict, key: str) -> str:
        v = _try_titles(r, key)
        if v in (None, ""):
            v = r.get(f"col_{POS[key]}", "")
        return str(v or "0")

    out: list[dict] = []
    for r in rows:
        name = r.get("Customer") or r.get("col_0", "")
        s = str(name or "").strip()
        if not s or s.upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        total = _dec(cell(r, "total"))
        if total == 0:
            continue
        out.append({
            "label":         s,
            "qbo_id":        r.get("Customer_id") or r.get("_entity_id"),
            "current":       cell(r, "current"),
            "1_30":          cell(r, "1_30"),
            "31_60":         cell(r, "31_60"),
            "61_90":         cell(r, "61_90"),
            "over_90":       cell(r, "over_90"),
            "total":         cell(r, "total"),
        })
    out.sort(key=lambda x: _dec(x["total"]), reverse=True)
    return out, "QuickBooks AgedReceivables report at period end."


async def _ap_subledger_rows(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> tuple[list[dict], str]:
    """Vendor-level aging from AgedPayables, formatted for the detail drawer."""
    try:
        report = await _qbo_get(
            conn, session, "/reports/AgedPayables",
            params={"report_date": period_end.isoformat(), "aging_method": "Current"},
        )
    except Exception:
        return [], "Could not fetch AgedPayables from QuickBooks."

    rows = _flatten_report_rows(report)
    POS = {"current": 1, "1_30": 2, "31_60": 3, "61_90": 4, "over_90": 5, "total": 6}

    def cell(r: dict, key: str) -> str:
        v = _try_titles(r, key)
        if v in (None, ""):
            v = r.get(f"col_{POS[key]}", "")
        return str(v or "0")

    out: list[dict] = []
    for r in rows:
        name = r.get("Vendor") or r.get("col_0", "")
        s = str(name or "").strip()
        if not s or s.upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        total = _dec(cell(r, "total"))
        if total == 0:
            continue
        out.append({
            "label":     s,
            "qbo_id":    r.get("Vendor_id") or r.get("_entity_id"),
            "current":   cell(r, "current"),
            "1_30":      cell(r, "1_30"),
            "31_60":     cell(r, "31_60"),
            "61_90":     cell(r, "61_90"),
            "over_90":   cell(r, "over_90"),
            "total":     cell(r, "total"),
        })
    out.sort(key=lambda x: _dec(x["total"]), reverse=True)
    return out, "QuickBooks AgedPayables report at period end."


def _try_titles(r: dict, bucket: str) -> Any:
    """Find an aging value by trying common column-title variants."""
    aliases = {
        "current":   ["Current", "0-30", "0 - 30", "current", "Current Due"],
        "1_30":      ["1 - 30", "1-30", "1 to 30", "Days1to30", "Age1_30"],
        "31_60":     ["31 - 60", "31-60", "31 to 60", "Days31to60", "Age31_60"],
        "61_90":     ["61 - 90", "61-90", "61 to 90", "Days61to90", "Age61_90"],
        "over_90":   ["91 and over", "> 90", "Over 90", "Days90Plus", "Over90Days"],
        "total":     ["Total", "Amount", "Balance"],
    }
    for k in aliases[bucket]:
        if k in r and r[k] not in (None, ""):
            return r[k]
    return None


async def _txn_rows_for_account(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> tuple[list[dict], str]:
    """Bank/CC: recent transactions touching this account (last 90 days)."""
    cutoff = (period_end - timedelta(days=90)).isoformat()
    end = period_end.isoformat()
    out: list[dict] = []

    # Deposits and Purchases hit Bank/CC accounts directly via AccountRef
    for entity, name_field in [("Purchase", "DocNumber"), ("Deposit", "DocNumber")]:
        try:
            q = (
                f"SELECT Id, {name_field}, TotalAmt, TxnDate, PrivateNote, AccountRef "
                f"FROM {entity} WHERE TxnDate >= '{cutoff}' AND TxnDate <= '{end}' "
                f"MAXRESULTS 100"
            )
            data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        except Exception:
            continue
        for t in data.get("QueryResponse", {}).get(entity, []) or []:
            if (t.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            out.append({
                "txn_id":      t.get("Id"),
                "txn_type":    entity,
                "txn_number":  str(t.get(name_field) or ""),
                "txn_date":    t.get("TxnDate") or "",
                "amount":      str(t.get("TotalAmt") or "0"),
                "memo":        (t.get("PrivateNote") or "")[:200],
            })

    out.sort(key=lambda x: x["txn_date"], reverse=True)
    return out, "Recent deposits and purchases hitting this account (last 90 days)."


async def _je_rows_for_account(
    conn: QboConnection,
    session: AsyncSession,
    qbo_account_id: str,
    period_end: date,
) -> tuple[list[dict], str]:
    """Generic: list recent JE lines hitting the account."""
    cutoff = (period_end - timedelta(days=90)).isoformat()
    end = period_end.isoformat()
    try:
        q = (
            f"SELECT Id, DocNumber, TxnDate, PrivateNote, Line "
            f"FROM JournalEntry WHERE TxnDate >= '{cutoff}' AND TxnDate <= '{end}' "
            f"MAXRESULTS 100"
        )
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        jes = data.get("QueryResponse", {}).get("JournalEntry", []) or []
    except Exception:
        return [], "Could not fetch journal entries from QuickBooks."

    out: list[dict] = []
    for je in jes:
        amount = Decimal("0")
        for line in je.get("Line", []) or []:
            d = line.get("JournalEntryLineDetail") or {}
            if (d.get("AccountRef") or {}).get("value") != qbo_account_id:
                continue
            line_amt = _dec(line.get("Amount"))
            amount += line_amt if d.get("PostingType") == "Debit" else -line_amt
        if amount == 0:
            continue
        out.append({
            "txn_id":      je.get("Id"),
            "txn_type":    "JournalEntry",
            "txn_number":  str(je.get("DocNumber") or ""),
            "txn_date":    je.get("TxnDate") or "",
            "amount":      str(amount),
            "memo":        (je.get("PrivateNote") or "")[:200],
        })
    out.sort(key=lambda x: x["txn_date"], reverse=True)
    return out, "Recent journal entry activity on this account (last 90 days)."
