"""
Schedules API.

Endpoints (all auth-required, tenant-scoped):

  GET    /schedules/overview                       — counts + totals per type
  GET    /schedules/{type}                         — list items
  POST   /schedules/{type}                         — create item
  PUT    /schedules/{type}/{id}                    — update item
  DELETE /schedules/{type}/{id}                    — delete item
  GET    /schedules/{type}/snapshot                — preview roll-forward for period_end
  POST   /schedules/{type}/snapshot/commit         — commit snapshot + push subledger
                                                     value into the matching
                                                     account_review_status row

`type` is one of: prepaid | accrual | fixed_asset | lease | loan.

Commit writes account_review_status.subledger_total / subledger_source
so the reconciliations overview picks up the schedule value as the
account's subledger without any cross-module coupling.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date as _date
from datetime import datetime as _datetime
from datetime import timedelta as _timedelta
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.guard import enforce_ai_limits
from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.db.base import current_request_readonly
from core.db.session import get_db
from models.closed_period import ClosedPeriod
from models.fixed_asset_candidate import FixedAssetCandidate
from models.missed_accrual_candidate import MissedAccrualCandidate
from models.prepaid_candidate import PrepaidCandidate
from models.qbo_connection import QboConnection
from models.schedule import (
    ScheduleAccrual,
    ScheduleFixedAsset,
    ScheduleLease,
    ScheduleLoan,
    SchedulePrepaid,
    ScheduleSnapshot,
)
from modules.schedules import calc
from modules.schedules.ai.accrual_detector import (
    find_unreversed_accruals,
    scan_for_missed_accruals,
)
from modules.schedules.ai.fixed_asset_detector import scan_for_fixed_asset_candidates
from modules.schedules.ai.prepaid_detector import scan_for_prepaid_candidates

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Type registry ─────────────────────────────────────────────────────────

_TYPES: dict[str, type] = {
    "prepaid":     SchedulePrepaid,
    "accrual":     ScheduleAccrual,
    "fixed_asset": ScheduleFixedAsset,
    "lease":       ScheduleLease,
    "loan":        ScheduleLoan,
}

_ROLLERS = {
    "prepaid":     calc.roll_prepaids,
    "accrual":     calc.roll_accruals,
    "fixed_asset": calc.roll_fixed_assets,
    "lease":       calc.roll_leases,
    "loan":        calc.roll_loans,
}

_HUMAN_NAMES = {
    "prepaid":     "Prepaid Expenses",
    "accrual":     "Accrued Expenses",
    "fixed_asset": "Fixed Assets",
    "lease":       "Leases",
    "loan":        "Loans",
}


def _model_for(schedule_type: str) -> type:
    m = _TYPES.get(schedule_type)
    if m is None:
        raise HTTPException(status_code=404, detail=f"Unknown schedule type: {schedule_type}")
    return m


def _parse_date(s: str | None, field: str) -> _date | None:
    if s is None or s == "":
        return None
    try:
        return _date.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be YYYY-MM-DD.")


def _dec(s: str | int | float | Decimal | None) -> Decimal | None:
    if s is None or s == "":
        return None
    try:
        return Decimal(str(s))
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid number: {s!r}")


# ── Serialization ─────────────────────────────────────────────────────────


def _serialize_common(row) -> dict:
    return {
        "id":             str(row.id),
        "qbo_account_id": row.qbo_account_id,
        "description":    row.description,
        "vendor":         row.vendor,
        "reference":      row.reference,
        "notes":          row.notes,
        "offset_qbo_account_id": getattr(row, "offset_qbo_account_id", None),
        "offset_account_name":   getattr(row, "offset_account_name", None),
        "is_active":      row.is_active,
        "created_at":     row.created_at.isoformat() if row.created_at else None,
        "updated_at":     row.updated_at.isoformat() if row.updated_at else None,
    }


def _serialize(schedule_type: str, row) -> dict:
    out = _serialize_common(row)
    if schedule_type == "prepaid":
        out.update({
            "invoice_date":         row.invoice_date.isoformat() if row.invoice_date else None,
            "total_amount":         str(row.total_amount),
            "start_date":           row.start_date.isoformat(),
            "end_date":             row.end_date.isoformat(),
            "amortization_method":  getattr(row, "amortization_method", "daily_rate"),
        })
    elif schedule_type == "accrual":
        out.update({
            "accrual_date":   row.accrual_date.isoformat(),
            "amount":         str(row.amount),
            "reverses_on":    row.reverses_on.isoformat() if row.reverses_on else None,
            "is_reversed":    row.is_reversed,
        })
    elif schedule_type == "fixed_asset":
        out.update({
            "category":              row.category,
            "in_service_date":       row.in_service_date.isoformat(),
            "cost":                  str(row.cost),
            "salvage_value":         str(row.salvage_value),
            "useful_life_months":    row.useful_life_months,
            "depreciation_method":   row.depreciation_method,
            "accumulated_dep_qbo_account_id": row.accumulated_dep_qbo_account_id,
            "disposed_on":           row.disposed_on.isoformat() if row.disposed_on else None,
            "disposal_proceeds":     str(row.disposal_proceeds) if row.disposal_proceeds is not None else None,
        })
    elif schedule_type == "lease":
        out.update({
            "lessor":              row.lessor,
            "lease_start":         row.lease_start.isoformat(),
            "lease_end":           row.lease_end.isoformat(),
            "monthly_payment":     str(row.monthly_payment),
            "discount_rate_pct":   str(row.discount_rate_pct) if row.discount_rate_pct is not None else None,
            "initial_rou_asset":   str(row.initial_rou_asset) if row.initial_rou_asset is not None else None,
            "initial_liability":   str(row.initial_liability) if row.initial_liability is not None else None,
            "rou_qbo_account_id":  row.rou_qbo_account_id,
        })
    elif schedule_type == "loan":
        out.update({
            "lender":              row.lender,
            "loan_date":           row.loan_date.isoformat(),
            "original_principal":  str(row.original_principal),
            "interest_rate_pct":   str(row.interest_rate_pct),
            "term_months":         row.term_months,
            "monthly_payment":     str(row.monthly_payment) if row.monthly_payment is not None else None,
            "payment_type":        row.payment_type,
        })
    return out


# ── Apply request body to model ───────────────────────────────────────────


def _apply_body(schedule_type: str, row, body: dict) -> None:
    """Mutate row in place from body. Type-specific field mapping."""
    if "qbo_account_id" in body:
        v = (body.get("qbo_account_id") or "").strip()
        if not v:
            raise HTTPException(status_code=400, detail="qbo_account_id is required.")
        row.qbo_account_id = v
    if "description" in body:
        v = (body.get("description") or "").strip()
        if not v:
            raise HTTPException(status_code=400, detail="description is required.")
        row.description = v
    if "vendor" in body:        row.vendor = body.get("vendor") or None
    if "reference" in body:     row.reference = body.get("reference") or None
    if "notes" in body:         row.notes = body.get("notes") or None
    if "offset_qbo_account_id" in body: row.offset_qbo_account_id = body.get("offset_qbo_account_id") or None
    if "offset_account_name" in body:   row.offset_account_name = body.get("offset_account_name") or None
    if "is_active" in body:     row.is_active = bool(body.get("is_active"))

    if schedule_type == "prepaid":
        if "invoice_date" in body: row.invoice_date = _parse_date(body.get("invoice_date"), "invoice_date")
        if "total_amount" in body: row.total_amount = _dec(body.get("total_amount")) or Decimal("0")
        if "start_date" in body:   row.start_date = _parse_date(body.get("start_date"), "start_date")
        if "end_date" in body:     row.end_date = _parse_date(body.get("end_date"), "end_date")
        if "amortization_method" in body:
            m = (body.get("amortization_method") or "daily_rate").strip()
            if m not in ("daily_rate", "straight_line"):
                raise HTTPException(
                    status_code=400,
                    detail="amortization_method must be 'daily_rate' or 'straight_line'.",
                )
            row.amortization_method = m
        if row.end_date is not None and row.start_date is not None and row.end_date < row.start_date:
            raise HTTPException(status_code=400, detail="end_date must be on or after start_date.")
    elif schedule_type == "accrual":
        if "accrual_date" in body: row.accrual_date = _parse_date(body.get("accrual_date"), "accrual_date")
        if "amount" in body:       row.amount = _dec(body.get("amount")) or Decimal("0")
        if "reverses_on" in body:  row.reverses_on = _parse_date(body.get("reverses_on"), "reverses_on")
        if "is_reversed" in body:  row.is_reversed = bool(body.get("is_reversed"))
    elif schedule_type == "fixed_asset":
        if "category" in body:           row.category = body.get("category") or None
        if "in_service_date" in body:    row.in_service_date = _parse_date(body.get("in_service_date"), "in_service_date")
        if "cost" in body:               row.cost = _dec(body.get("cost")) or Decimal("0")
        if "salvage_value" in body:      row.salvage_value = _dec(body.get("salvage_value")) or Decimal("0")
        if "useful_life_months" in body: row.useful_life_months = int(body.get("useful_life_months") or 0)
        if "depreciation_method" in body: row.depreciation_method = body.get("depreciation_method") or "straight_line"
        if "accumulated_dep_qbo_account_id" in body:
            row.accumulated_dep_qbo_account_id = body.get("accumulated_dep_qbo_account_id") or None
        if "disposed_on" in body:        row.disposed_on = _parse_date(body.get("disposed_on"), "disposed_on")
        if "disposal_proceeds" in body:  row.disposal_proceeds = _dec(body.get("disposal_proceeds"))
        if row.useful_life_months is not None and row.useful_life_months < 1:
            raise HTTPException(status_code=400, detail="useful_life_months must be >= 1.")
    elif schedule_type == "lease":
        if "lessor" in body:               row.lessor = body.get("lessor") or None
        if "lease_start" in body:          row.lease_start = _parse_date(body.get("lease_start"), "lease_start")
        if "lease_end" in body:            row.lease_end = _parse_date(body.get("lease_end"), "lease_end")
        if "monthly_payment" in body:      row.monthly_payment = _dec(body.get("monthly_payment")) or Decimal("0")
        if "discount_rate_pct" in body:    row.discount_rate_pct = _dec(body.get("discount_rate_pct"))
        if "initial_rou_asset" in body:    row.initial_rou_asset = _dec(body.get("initial_rou_asset"))
        if "initial_liability" in body:    row.initial_liability = _dec(body.get("initial_liability"))
        if "rou_qbo_account_id" in body:   row.rou_qbo_account_id = body.get("rou_qbo_account_id") or None
        if row.lease_end is not None and row.lease_start is not None and row.lease_end < row.lease_start:
            raise HTTPException(status_code=400, detail="lease_end must be on or after lease_start.")
    elif schedule_type == "loan":
        if "lender" in body:                row.lender = body.get("lender") or None
        if "loan_date" in body:             row.loan_date = _parse_date(body.get("loan_date"), "loan_date")
        if "original_principal" in body:    row.original_principal = _dec(body.get("original_principal")) or Decimal("0")
        if "interest_rate_pct" in body:     row.interest_rate_pct = _dec(body.get("interest_rate_pct")) or Decimal("0")
        if "term_months" in body:           row.term_months = int(body.get("term_months") or 0)
        if "monthly_payment" in body:       row.monthly_payment = _dec(body.get("monthly_payment"))
        if "payment_type" in body:          row.payment_type = body.get("payment_type") or "amortizing"
        if row.term_months is not None and row.term_months < 1:
            raise HTTPException(status_code=400, detail="term_months must be >= 1.")


# ── Client Memory capture helpers ─────────────────────────────────────────


def _months_between(start, end) -> int | None:
    """Whole months from start — the exact inverse of the UI's addMonthsIso
    (end = start + N months − 1 day). None if either date is missing."""
    if not start or not end:
        return None
    ep = end + _timedelta(days=1)
    return max(1, (ep.year - start.year) * 12 + (ep.month - start.month))


def _schedule_memory_defaults(schedule_type: str, row) -> tuple:
    """(party, defaults, when) for a Client Memory capture, or (None, None,
    None) when the row isn't learnable (no vendor / lessor / lender). `party`
    is the vendor (prepaid/accrual/fixed_asset), lessor (lease), or lender
    (loan). `defaults` carries the explicit setup choices we learn from; `when`
    is the item's anchor date (the signal's period_end column is non-null)."""
    common = {
        "offset_qbo_account_id": getattr(row, "offset_qbo_account_id", None),
        "offset_account_name":   getattr(row, "offset_account_name", None),
        "qbo_account_id":        row.qbo_account_id,
    }
    if schedule_type == "prepaid":
        return (row.vendor, {
            "schedule_type": "prepaid",
            "amortization_method": row.amortization_method,
            "term_months": _months_between(row.start_date, row.end_date),
            **common,
        }, row.start_date)
    if schedule_type == "accrual":
        return (row.vendor, {"schedule_type": "accrual", **common}, row.accrual_date)
    if schedule_type == "fixed_asset":
        return (row.vendor, {
            "schedule_type": "fixed_asset",
            "category": row.category,
            "useful_life_months": row.useful_life_months,
            "depreciation_method": row.depreciation_method,
            "accumulated_dep_qbo_account_id": row.accumulated_dep_qbo_account_id,
            **common,
        }, row.in_service_date)
    if schedule_type == "lease":
        return (row.lessor, {
            "schedule_type": "lease",
            "term_months": _months_between(row.lease_start, row.lease_end),
            "discount_rate_pct": (str(row.discount_rate_pct) if row.discount_rate_pct is not None else None),
            "rou_qbo_account_id": row.rou_qbo_account_id,
            **common,
        }, row.lease_start)
    if schedule_type == "loan":
        return (row.lender, {
            "schedule_type": "loan",
            "term_months": row.term_months,
            "interest_rate_pct": (str(row.interest_rate_pct) if row.interest_rate_pct is not None else None),
            "payment_type": row.payment_type,
            **common,
        }, row.loan_date)
    return (None, None, None)


# ── Endpoints ─────────────────────────────────────────────────────────────


@router.get("/accounts")
async def list_accounts(
    tenant_id: CurrentTenantId,
    kind: str = Query("balance_sheet", description="balance_sheet (default) | expense (P&L accounts)"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Active accounts available to map schedule items to. The default returns
    balance-sheet accounts (the prepaid asset / accrued liability side);
    kind="expense" returns P&L / income-statement accounts (the account a
    prepaid amortizes into, an accrual books to, etc.). Pulled live from QBO
    so the picker always reflects the current chart of accounts.

    Returns: { accounts: [{ qbo_account_id, name, number, account_type }] }
    """
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    # Re-use recons.overview.ACCOUNT_TYPE_GROUPS so the BS account
    # filter stays consistent across the app.
    from modules.recons.overview import ACCOUNT_TYPE_GROUPS
    from modules.recons.service import _qbo_get
    # Default = balance-sheet accounts (the schedule's asset/liability side).
    # "expense" = P&L / income-statement accounts (the offset side).
    if kind in ("expense", "pl", "income_statement"):
        type_groups = {
            "Expense":            "Expense",
            "Other Expense":      "Other Expense",
            "Cost of Goods Sold": "Cost of Goods Sold",
            "Income":             "Income",
            "Other Income":       "Other Income",
        }
    else:
        type_groups = ACCOUNT_TYPE_GROUPS
    types = list(type_groups.keys())
    quoted = ", ".join(f"'{t}'" for t in types)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType FROM Account "
        f"WHERE AccountType IN ({quoted}) AND Active = true MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
    except Exception as e:
        logger.exception("Schedules accounts pull failed")
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch accounts from QuickBooks ({e}).",
        )
    accounts_meta = data.get("QueryResponse", {}).get("Account", []) or []
    out = []
    for a in accounts_meta:
        atype = a.get("AccountType", "")
        if atype not in type_groups:
            continue
        out.append({
            "qbo_account_id": str(a.get("Id") or ""),
            "name":           str(a.get("Name") or ""),
            "number":         str(a.get("AcctNum") or ""),
            "account_type":   atype,
            "group_label":    type_groups[atype],
        })
    out.sort(key=lambda r: (r["group_label"], r["number"] or r["name"]))
    return {"accounts": out}


@router.get("/overview")
async def overview(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Counts + ending-balance totals per schedule type for the given period."""
    pe = _parse_date(period_end, "period_end")
    assert pe is not None
    types_out = []
    for stype in calc.SCHEDULE_TYPES:
        Model = _TYPES[stype]
        items = (await db.execute(
            select(Model).where(Model.tenant_id == tenant_id)
        )).scalars().all()
        active = [i for i in items if i.is_active]
        # Quick aggregate for cards — roll across ALL accounts as one
        # combined snapshot for the type. Per-account detail lives on
        # the detail page.
        roller = _ROLLERS[stype]
        snap = roller(active, pe)
        # Last committed snapshot status (across any account for this type)
        latest_committed = (await db.execute(
            select(ScheduleSnapshot).where(
                ScheduleSnapshot.tenant_id == tenant_id,
                ScheduleSnapshot.schedule_type == stype,
                ScheduleSnapshot.period_end == pe,
                ScheduleSnapshot.status == "committed",
            ).limit(1)
        )).scalar_one_or_none()
        types_out.append({
            "type":          stype,
            "human_name":    _HUMAN_NAMES[stype],
            "active_count":  len(active),
            "total_count":   len(items),
            "ending_balance": snap.as_dict()["ending_balance"],
            "period_expense": snap.as_dict()["period_expense"],
            "any_committed_for_period": latest_committed is not None,
        })
    return {"period_end": pe.isoformat(), "types": types_out}


@router.get("/{schedule_type}")
async def list_items(
    schedule_type: str,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
    qbo_account_id: str | None = Query(default=None),
    include_inactive: bool = Query(default=True),
) -> dict:
    Model = _model_for(schedule_type)
    q = select(Model).where(Model.tenant_id == tenant_id)
    if qbo_account_id:
        q = q.where(Model.qbo_account_id == qbo_account_id)
    if not include_inactive:
        q = q.where(Model.is_active == True)  # noqa: E712
    rows = (await db.execute(q)).scalars().all()
    return {
        "schedule_type": schedule_type,
        "items":         [_serialize(schedule_type, r) for r in rows],
    }


# ── Snapshot staleness ───────────────────────────────────────────────────
#
# A committed ScheduleSnapshot is a point-in-time roll-forward. The moment
# the underlying items change (add / edit / delete / bulk-import), that
# committed snapshot no longer reflects reality — and every downstream
# consumer that gates on status=="committed" (close-task completion, the
# dashboard close-progress, the recon's schedule-backed subledger) would
# otherwise treat the out-of-date snapshot as done.
#
# So on ANY item mutation we flip the affected account's committed
# snapshots to status="stale" (keeping committed_at so the UI can still
# say "last committed <when>"). The schedule page then re-shows the
# Commit button, the close task re-opens, and progress drops — all from
# this one status change. Closed periods are never reopened: their books
# are locked, and a stale recompute there would be a compliance problem.


def _item_account_ids(schedule_type: str, row) -> set[str]:
    """Every GL account a schedule item rolls up to. Most types have one
    (qbo_account_id); FA also hits its accumulated-depreciation account and
    leases also hit the ROU asset account — changing the item invalidates
    snapshots on ALL of them."""
    ids = {(getattr(row, "qbo_account_id", "") or "")}
    if schedule_type == "fixed_asset":
        ids.add(getattr(row, "accumulated_dep_qbo_account_id", None) or "")
    if schedule_type == "lease":
        ids.add(getattr(row, "rou_qbo_account_id", None) or "")
    return {i for i in ids if i}


async def _invalidate_committed_snapshots(
    db: AsyncSession,
    tenant_id,
    schedule_type: str,
    qbo_account_ids: set[str],
) -> int:
    """Flip committed snapshots for the given account(s) to 'stale' so the
    user is prompted to re-commit. Skips closed (locked) periods. Mutates
    rows in the current session WITHOUT committing — the caller owns the
    transaction. Returns the number of snapshots invalidated."""
    ids = {a for a in qbo_account_ids if a}
    if not ids:
        return 0
    closed = set(
        (await db.execute(select(ClosedPeriod.period_end))).scalars().all()
    )
    rows = (await db.execute(
        select(ScheduleSnapshot).where(
            ScheduleSnapshot.tenant_id == tenant_id,
            ScheduleSnapshot.schedule_type == schedule_type,
            ScheduleSnapshot.qbo_account_id.in_(ids),
            ScheduleSnapshot.status == "committed",
        )
    )).scalars().all()
    n = 0
    for r in rows:
        if r.period_end in closed:
            continue   # books locked — leave the committed snapshot intact
        r.status = "stale"
        n += 1
    return n


async def _reflag_approved_recons(
    db: AsyncSession,
    tenant_id,
    qbo_account_ids: set[str],
    *,
    user_id,
    reason: str,
) -> int:
    """A schedule change invalidates any ALREADY-APPROVED reconciliation for
    the affected account(s) — the numbers it was approved on just moved. Revert
    each approved (non-closed) recon to 'reviewed', clear the approval stamps,
    and audit it, so it's re-reviewed before close. Skips closed (locked)
    periods. Mutates rows WITHOUT committing — the caller owns the transaction.
    Returns the count re-flagged."""
    from core.audit.log import write_audit_event
    from models.account_review_status import AccountReviewStatus

    ids = {a for a in qbo_account_ids if a}
    if not ids:
        return 0
    closed = set((await db.execute(
        select(ClosedPeriod.period_end).where(ClosedPeriod.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalars().all())
    rows = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.tenant_id == tenant_id,
            AccountReviewStatus.qbo_account_id.in_(ids),
            AccountReviewStatus.status == "approved",
        ),
        execution_options={"skip_tenant_filter": True},
    )).scalars().all()
    n = 0
    for r in rows:
        if r.period_end in closed:
            continue   # books locked — can't touch the approval
        r.status = "reviewed"
        r.approved_by = None
        r.approved_at = None
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user_id,
            action="recon.reflag_schedule_change",
            entity_type="account_review_status", entity_id=r.id,
            metadata={
                "qbo_account_id": r.qbo_account_id,
                "period_end": r.period_end.isoformat(),
                "reason": reason,
            },
        )
        n += 1
    return n


@router.post("/{schedule_type}", dependencies=[Depends(require_role("preparer"))])
async def create_item(
    schedule_type: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    Model = _model_for(schedule_type)
    row = Model(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        created_by=user.id,
        qbo_account_id="",
        description="",
    )
    _apply_body(schedule_type, row, body)
    if not row.qbo_account_id:
        raise HTTPException(status_code=400, detail="qbo_account_id is required.")
    db.add(row)
    # Adding a line invalidates any committed snapshot for this account —
    # the roll-forward changed, so the period needs a re-commit.
    accts = _item_account_ids(schedule_type, row)
    await _invalidate_committed_snapshots(db, tenant_id, schedule_type, accts)
    # …and un-approves any already-approved recon on those accounts: it was
    # signed off on numbers that just changed.
    await _reflag_approved_recons(db, tenant_id, accts, user_id=user.id, reason="schedule item added")

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.item_created", entity_type="schedule_item", entity_id=row.id,
        metadata={"summary": f"Created {schedule_type} schedule item '{row.description}'"},
    )
    await db.commit()
    await db.refresh(row)
    result = _serialize(schedule_type, row)

    # ── Client Memory: learn this party's setup for this schedule type ──────
    # Runs AFTER the create is durably committed, in its own transaction, so a
    # learning failure can never block or undo the create. Every captured field
    # is an explicit user choice — a deterministic signal, no inference. Skipped
    # for read-only (demo / suspended) requests.
    if not current_request_readonly.get():
        party, defaults, when = _schedule_memory_defaults(schedule_type, row)
        if party and str(party).strip() and when is not None:
            try:
                from modules.memory import service as memory
                await memory.record_schedule_default(
                    db, tenant_id=tenant_id, schedule_type=schedule_type,
                    vendor=party, defaults=defaults, item_id=row.id,
                    when=when, created_by=user.id,
                )
                await memory.distill_schedule_default(
                    db, tenant_id=tenant_id, schedule_type=schedule_type,
                    vendor=party, defaults=defaults,
                )
                await db.commit()
            except Exception:
                logger.exception("client-memory schedule capture failed (item=%s)", row.id)
                await db.rollback()

    return result


@router.put("/{schedule_type}/{item_id}", dependencies=[Depends(require_role("preparer"))])
async def update_item(
    schedule_type: str,
    item_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    Model = _model_for(schedule_type)
    row = (await db.execute(
        select(Model).where(Model.tenant_id == tenant_id, Model.id == item_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{schedule_type} item not found.")
    # Capture account(s) BEFORE the edit — if the user re-points the item
    # to a different GL account, both the old and new account's committed
    # snapshots are now stale.
    affected = _item_account_ids(schedule_type, row)
    _apply_body(schedule_type, row, body)
    affected |= _item_account_ids(schedule_type, row)
    await _invalidate_committed_snapshots(db, tenant_id, schedule_type, affected)
    # Editing a line moves the subledger → un-approve any approved recon on the
    # old or new account so it's re-reviewed before close.
    await _reflag_approved_recons(db, tenant_id, affected, user_id=user.id, reason="schedule item edited")
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.item_updated", entity_type="schedule_item", entity_id=row.id,
        metadata={"summary": f"Updated {schedule_type} schedule item '{row.description}'"},
    )
    await db.commit()
    await db.refresh(row)
    return _serialize(schedule_type, row)


@router.delete("/{schedule_type}/{item_id}", dependencies=[Depends(require_role("preparer"))])
async def delete_item(
    schedule_type: str,
    item_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    Model = _model_for(schedule_type)
    row = (await db.execute(
        select(Model).where(Model.tenant_id == tenant_id, Model.id == item_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{schedule_type} item not found.")
    # Removing a line changes the roll-forward → invalidate this account's
    # committed snapshots and re-flag any approved recon before deleting.
    accts = _item_account_ids(schedule_type, row)
    await _invalidate_committed_snapshots(db, tenant_id, schedule_type, accts)
    await _reflag_approved_recons(db, tenant_id, accts, user_id=user.id, reason="schedule item deleted")
    item_name = row.description  # capture before the row is deleted
    await db.delete(row)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.item_deleted", entity_type="schedule_item", entity_id=item_id,
        metadata={"summary": f"Deleted {schedule_type} schedule item '{item_name}'"},
    )
    await db.commit()
    return {"id": str(item_id), "deleted": True}


@router.get("/{schedule_type}/snapshot")
async def snapshot(
    schedule_type: str,
    tenant_id: CurrentTenantId,
    qbo_account_id: str = Query(..., description="GL account to roll forward"),
    period_end: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Preview the roll-forward for one (account, period) pair. Read-only.
    Use POST /snapshot/commit to persist + push to recon.
    """
    Model = _model_for(schedule_type)
    pe = _parse_date(period_end, "period_end")
    assert pe is not None
    items = (await db.execute(
        select(Model).where(
            Model.tenant_id == tenant_id,
            Model.qbo_account_id == qbo_account_id,
        )
    )).scalars().all()
    roller = _ROLLERS[schedule_type]
    snap = roller([i for i in items if i.is_active], pe)
    # Is there a committed snapshot for this period already?
    existing = (await db.execute(
        select(ScheduleSnapshot).where(
            ScheduleSnapshot.tenant_id == tenant_id,
            ScheduleSnapshot.schedule_type == schedule_type,
            ScheduleSnapshot.qbo_account_id == qbo_account_id,
            ScheduleSnapshot.period_end == pe,
        )
    )).scalar_one_or_none()
    return {
        "schedule_type":   schedule_type,
        "qbo_account_id":  qbo_account_id,
        "period_end":      pe.isoformat(),
        **snap.as_dict(),
        "committed":       existing is not None and existing.status == "committed",
        # `stale` = was committed, but items have since changed, so the
        # persisted snapshot is out of date and the period needs a
        # re-commit. committed_at is preserved on stale rows so the UI can
        # show "last committed <when>".
        "stale":           existing is not None and existing.status == "stale",
        "committed_at":    existing.committed_at.isoformat() if existing and existing.committed_at else None,
    }


async def _commit_one_snapshot(
    db: AsyncSession,
    tenant_id,
    schedule_type: str,
    qbo_account_id: str,
    pe,
    user_id,
    *,
    notes: str | None = None,
) -> tuple[ScheduleSnapshot, dict]:
    """Roll forward + upsert the committed snapshot for one (type, account, period),
    then re-flag that account's approved recon (the subledger just moved). Mutates
    rows in the caller's transaction WITHOUT committing — the caller owns commit +
    audit. Shared by the single-account and commit-all endpoints so both behave
    identically. Returns (snapshot row, snapshot dict)."""
    Model = _model_for(schedule_type)
    items = (await db.execute(
        select(Model).where(
            Model.tenant_id == tenant_id,
            Model.qbo_account_id == qbo_account_id,
        )
    )).scalars().all()
    roller = _ROLLERS[schedule_type]
    snap = roller([i for i in items if i.is_active], pe)
    snap_d = snap.as_dict()

    existing = (await db.execute(
        select(ScheduleSnapshot).where(
            ScheduleSnapshot.tenant_id == tenant_id,
            ScheduleSnapshot.schedule_type == schedule_type,
            ScheduleSnapshot.qbo_account_id == qbo_account_id,
            ScheduleSnapshot.period_end == pe,
        )
    )).scalar_one_or_none()
    if existing is None:
        existing = ScheduleSnapshot(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            schedule_type=schedule_type,
            qbo_account_id=qbo_account_id,
            period_end=pe,
        )
        db.add(existing)
    existing.beginning_balance = Decimal(snap_d["beginning_balance"])
    existing.additions         = Decimal(snap_d["additions"])
    existing.period_expense    = Decimal(snap_d["period_expense"])
    existing.payments          = Decimal(snap_d["payments"])
    existing.other             = Decimal(snap_d["other"])
    existing.ending_balance    = Decimal(snap_d["ending_balance"])
    existing.item_count        = snap.item_count
    existing.status            = "committed"
    existing.committed_by      = user_id
    existing.committed_at      = _datetime.utcnow()
    if notes:
        existing.notes = notes

    # Committing a schedule moves the account's subledger — un-approve any
    # already-approved recon on this account so it's re-reviewed before close.
    await _reflag_approved_recons(
        db, tenant_id, {qbo_account_id}, user_id=user_id, reason="schedule committed",
    )
    return existing, snap_d


@router.post("/{schedule_type}/snapshot/commit", dependencies=[Depends(require_role("preparer"))])
async def commit_snapshot(
    schedule_type: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Persist the period snapshot. Does NOT modify the recon's subledger
    value automatically — the recon stays in control of its SL logic.

    Once a snapshot is committed, the recon UI surfaces the individual
    schedule items as selectable line items in the inline accordion
    (via GET /{type}/suggestions) so the preparer can pick which ones
    contribute to the account's subledger balance.

    Body: { qbo_account_id: str, period_end: str, notes?: str }
    """
    qbo_account_id = (body.get("qbo_account_id") or "").strip()
    if not qbo_account_id:
        raise HTTPException(status_code=400, detail="qbo_account_id is required.")
    pe = _parse_date(body.get("period_end"), "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    # Books locked for this period → can't commit a schedule into it.
    is_closed = (await db.execute(
        select(ClosedPeriod).where(
            ClosedPeriod.tenant_id == tenant_id, ClosedPeriod.period_end == pe,
        ),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none() is not None
    if is_closed:
        raise HTTPException(
            status_code=423,
            detail=f"Books are closed for {pe.isoformat()}. Reopen the period before committing a schedule.",
        )
    existing, snap_d = await _commit_one_snapshot(
        db, tenant_id, schedule_type, qbo_account_id, pe, user.id, notes=body.get("notes"),
    )

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.snapshot_committed", entity_type="schedule_snapshot", entity_id=existing.id,
        metadata={"summary": (
            f"Committed {schedule_type} snapshot for account {qbo_account_id} "
            f"({pe.isoformat()}), {existing.item_count} item(s)"
        )},
    )
    await db.commit()
    await db.refresh(existing)
    return {
        "schedule_type":   schedule_type,
        "qbo_account_id":  qbo_account_id,
        "period_end":      pe.isoformat(),
        **snap_d,
        "committed":       True,
        "committed_at":    existing.committed_at.isoformat() if existing.committed_at else None,
        "pushed_to_recon": False,
    }


@router.post("/{schedule_type}/snapshot/commit-all", dependencies=[Depends(require_role("preparer"))])
async def commit_all_snapshots(
    schedule_type: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Commit the period roll-forward for EVERY GL account that has active items
    in this schedule — one click instead of drilling into each account. Skips a
    locked period (423) and re-flags each committed account's approved recon (the
    same maker/checker control as a single commit). When the schedule has no items
    it's a no-op (committed_count=0): an empty schedule never needs a commit and
    never blocks the close.

    Body: { period_end: str }
    """
    Model = _model_for(schedule_type)
    pe = _parse_date(body.get("period_end"), "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    is_closed = (await db.execute(
        select(ClosedPeriod).where(
            ClosedPeriod.tenant_id == tenant_id, ClosedPeriod.period_end == pe,
        ),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none() is not None
    if is_closed:
        raise HTTPException(
            status_code=423,
            detail=f"Books are closed for {pe.isoformat()}. Reopen the period before committing a schedule.",
        )
    # Distinct GL accounts with at least one active item for this schedule type.
    rows = (await db.execute(
        select(Model.qbo_account_id).where(
            Model.tenant_id == tenant_id, Model.is_active.is_(True),
        )
    )).scalars().all()
    accounts = sorted({(a or "").strip() for a in rows if (a or "").strip()})
    for acct in accounts:
        await _commit_one_snapshot(db, tenant_id, schedule_type, acct, pe, user.id)
    if accounts:
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="schedule.snapshot_committed_all",
            entity_type="schedule_snapshot", entity_id=None,
            metadata={"summary": (
                f"Committed {len(accounts)} {schedule_type} snapshot(s) for {pe.isoformat()}"
            )},
        )
    await db.commit()
    return {
        "schedule_type":   schedule_type,
        "period_end":      pe.isoformat(),
        "committed_count": len(accounts),
        "accounts":        accounts,
    }


# ── Accrual suggestions for recon inline accordion ─────────────────────────


@router.get("/accrual/suggestions")
async def accrual_suggestions(
    tenant_id: CurrentTenantId,
    qbo_account_id: str = Query(..., description="GL account to look up accruals for"),
    period_end: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Delta-based line items for accrued liability accounts.

    Each accrual emits up to two lines depending on the period:
      - "accrual" line: +amount when accrual_date falls in this period
      - "reversal" line: -amount when reverses_on falls in this period

    The recon's existing build-up math (opening + selected items) then
    handles the lifecycle naturally:
      - Month X (accrual booked): +amount added to SL
      - Month X+1 (reversal):     -amount applied to SL → closes to 0

    Gated on a committed snapshot for this (account, period) just like
    prepaids — until the preparer commits in the Accruals schedule page,
    the recon accordion stays blank for this account.

    For accruals neither booked nor reversed in this period (i.e.,
    carried-forward from a prior period and still outstanding), no
    line is emitted — they're already represented in the rolled-
    forward opening balance, so adding a line would double-count.
    """
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")

    snapshot = (await db.execute(
        select(ScheduleSnapshot).where(
            ScheduleSnapshot.tenant_id == tenant_id,
            ScheduleSnapshot.schedule_type == "accrual",
            ScheduleSnapshot.qbo_account_id == qbo_account_id,
            ScheduleSnapshot.period_end == pe,
            ScheduleSnapshot.status == "committed",
        )
    )).scalar_one_or_none()

    if snapshot is None:
        any_active = (await db.execute(
            select(ScheduleAccrual.id).where(
                ScheduleAccrual.tenant_id == tenant_id,
                ScheduleAccrual.qbo_account_id == qbo_account_id,
                ScheduleAccrual.is_active == True,  # noqa: E712
            ).limit(1)
        )).first()
        return {
            "qbo_account_id":   qbo_account_id,
            "period_end":       pe.isoformat(),
            "items":            [],
            "committed":        False,
            "has_uncommitted":  any_active is not None,
        }

    items = (await db.execute(
        select(ScheduleAccrual).where(
            ScheduleAccrual.tenant_id == tenant_id,
            ScheduleAccrual.qbo_account_id == qbo_account_id,
            ScheduleAccrual.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    p_start, p_end = calc._period_bounds(pe)
    out: list[dict] = []
    for it in items:
        amt = Decimal(it.amount)
        # ACCRUAL line — booking in this period.
        if p_start <= it.accrual_date <= p_end:
            out.append({
                "item_id":          str(it.id),
                "line_kind":        "accrual",
                "line_date":        it.accrual_date.isoformat(),
                "amount":           str(_q_money(amt)),
                "description":      it.description,
                "vendor":           it.vendor,
                "reference":        it.reference,
                "accrual_date":     it.accrual_date.isoformat(),
                "amount_original":  str(_q_money(amt)),
                "reverses_on":      it.reverses_on.isoformat() if it.reverses_on else None,
                "is_reversed_flag": bool(it.is_reversed),
            })
        # REVERSAL line — reverses_on falls in this period AND the
        # accrual was booked before (not same-period book+reverse,
        # which would still emit both lines and net to 0 if both
        # checked).
        if it.reverses_on is not None and p_start <= it.reverses_on <= p_end:
            out.append({
                "item_id":          str(it.id),
                "line_kind":        "reversal",
                "line_date":        it.reverses_on.isoformat(),
                "amount":           str(_q_money(-amt)),
                "description":      it.description,
                "vendor":           it.vendor,
                "reference":        it.reference,
                "accrual_date":     it.accrual_date.isoformat(),
                "amount_original":  str(_q_money(amt)),
                "reverses_on":      it.reverses_on.isoformat() if it.reverses_on else None,
                "is_reversed_flag": bool(it.is_reversed),
            })

    # Sort: by date (chronological), then accrual before reversal on
    # the same date so the lifecycle reads top-to-bottom.
    out.sort(key=lambda r: (r["line_date"], 0 if r["line_kind"] == "accrual" else 1))
    return {
        "qbo_account_id":   qbo_account_id,
        "period_end":       pe.isoformat(),
        "items":            out,
        "committed":        True,
        "committed_at":     snapshot.committed_at.isoformat() if snapshot.committed_at else None,
        "has_uncommitted":  False,
    }


# ── Prepaid suggestions for recon inline accordion ─────────────────────────


@router.get("/prepaid/suggestions")
async def prepaid_suggestions(
    tenant_id: CurrentTenantId,
    qbo_account_id: str = Query(..., description="GL account to look up prepaids for"),
    period_end: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return one row per active prepaid item mapped to this GL account
    that's still amortizing as of period_end. Used by the recon's
    inline accordion to offer per-item subledger components: each row
    has a checkbox, and the recon UI sums the checked items into its
    subledger total via the existing reconciling-items mechanism.

    Days-based math throughout:
      - total_days        = inclusive days in [start_date, end_date]
      - daily_rate        = total_amount / total_days
      - period_amortization = daily_rate × days of overlap with the
                              calendar month containing period_end
      - unamortized_at_period_end = how much remains on the BS
                                     (the value to include in subledger)
    """
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")

    # Gate on a committed snapshot for this (account, period_end). The
    # user wanted explicit "commit" to be the trigger that exposes items
    # to the recon — until then, the accordion stays blank for this
    # account. Returns the committed flag so the UI can hint at the
    # missing commit if items exist but haven't been locked in yet.
    snapshot = (await db.execute(
        select(ScheduleSnapshot).where(
            ScheduleSnapshot.tenant_id == tenant_id,
            ScheduleSnapshot.schedule_type == "prepaid",
            ScheduleSnapshot.qbo_account_id == qbo_account_id,
            ScheduleSnapshot.period_end == pe,
            ScheduleSnapshot.status == "committed",
        )
    )).scalar_one_or_none()

    if snapshot is None:
        # Tell the UI whether there ARE items waiting to be committed,
        # so it can show a "commit snapshot to surface items" hint
        # instead of just nothing.
        any_active = (await db.execute(
            select(SchedulePrepaid.id).where(
                SchedulePrepaid.tenant_id == tenant_id,
                SchedulePrepaid.qbo_account_id == qbo_account_id,
                SchedulePrepaid.is_active == True,  # noqa: E712
            ).limit(1)
        )).first()
        return {
            "qbo_account_id":     qbo_account_id,
            "period_end":         pe.isoformat(),
            "items":              [],
            "committed":          False,
            "has_uncommitted":    any_active is not None,
        }

    items = (await db.execute(
        select(SchedulePrepaid).where(
            SchedulePrepaid.tenant_id == tenant_id,
            SchedulePrepaid.qbo_account_id == qbo_account_id,
            SchedulePrepaid.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    p_start, p_end = calc._period_bounds(pe)
    out: list[dict] = []
    for it in items:
        # Skip items that haven't started yet (started AFTER period_end)
        # — they're future commitments, not part of this period's SL.
        if it.start_date > p_end:
            continue
        unamortized = calc._prepaid_unamortized_as_of(it, pe)
        period_amort = calc._prepaid_period_expense(it, p_start, p_end)
        daily_rate = calc._prepaid_daily_rate(it)
        monthly_rate = calc._prepaid_monthly_rate(it)
        total_days = calc._days_inclusive(it.start_date, it.end_date)
        total_months = calc._prepaid_months_touched(it)
        amortized_to_date = calc._prepaid_amortized_through(it, pe)
        out.append({
            "item_id":                  str(it.id),
            "description":              it.description,
            "vendor":                   it.vendor,
            "reference":                it.reference,
            "invoice_date":             it.invoice_date.isoformat() if it.invoice_date else None,
            "start_date":               it.start_date.isoformat(),
            "end_date":                 it.end_date.isoformat(),
            "total_amount":             str(_q_money(Decimal(it.total_amount))),
            "total_days":               total_days,
            "total_months":             total_months,
            "amortization_method":      calc._prepaid_method(it),
            "daily_rate":               str(_q_money(daily_rate)),
            "monthly_rate":             str(_q_money(monthly_rate)),
            "period_amortization":      str(_q_money(period_amort)),
            "amortized_to_date":        str(_q_money(amortized_to_date)),
            "unamortized_at_period_end": str(_q_money(unamortized)),
            "fully_amortized":          unamortized == Decimal("0"),
        })
    # Sort: amortizing items first (most-relevant), then fully-amortized.
    out.sort(key=lambda r: (r["fully_amortized"], r["start_date"]))
    return {
        "qbo_account_id":   qbo_account_id,
        "period_end":       pe.isoformat(),
        "items":            out,
        "committed":        True,
        "committed_at":     snapshot.committed_at.isoformat() if snapshot.committed_at else None,
        "has_uncommitted":  False,
    }


def _q_money(d: Decimal) -> Decimal:
    """Local 2dp quantizer matching the rest of the app's display format."""
    return d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ── Generic suggestion helper for the 3 amort-based types ─────────────────


async def _generic_suggestions(
    db: AsyncSession,
    tenant_id,
    schedule_type: str,
    qbo_account_id: str,
    pe,
    model_cls,
    line_fn,
    extra_account_field: str | None = None,
) -> dict:
    """
    Shared scaffold for fixed_asset / lease / loan suggestion endpoints.
    All three gate on a committed snapshot and emit delta line items via
    type-specific helpers in calc.py.

    `extra_account_field` covers Fixed Assets where one item maps to two
    accounts (cost via qbo_account_id + accumulated dep via
    accumulated_dep_qbo_account_id) — both need to surface suggestions
    for the same item.
    """
    snapshot = (await db.execute(
        select(ScheduleSnapshot).where(
            ScheduleSnapshot.tenant_id == tenant_id,
            ScheduleSnapshot.schedule_type == schedule_type,
            ScheduleSnapshot.qbo_account_id == qbo_account_id,
            ScheduleSnapshot.period_end == pe,
            ScheduleSnapshot.status == "committed",
        )
    )).scalar_one_or_none()

    if snapshot is None:
        # Count active items mapped to this account (via either field)
        q = select(model_cls.id).where(
            model_cls.tenant_id == tenant_id,
            model_cls.is_active == True,  # noqa: E712
        )
        if extra_account_field:
            q = q.where(
                (model_cls.qbo_account_id == qbo_account_id) |
                (getattr(model_cls, extra_account_field) == qbo_account_id)
            )
        else:
            q = q.where(model_cls.qbo_account_id == qbo_account_id)
        any_active = (await db.execute(q.limit(1))).first()
        return {
            "qbo_account_id":   qbo_account_id,
            "period_end":       pe.isoformat(),
            "items":            [],
            "committed":        False,
            "has_uncommitted":  any_active is not None,
        }

    # Pull ALL active items for the type (line_fn filters by account itself).
    items = (await db.execute(
        select(model_cls).where(
            model_cls.tenant_id == tenant_id,
            model_cls.is_active == True,  # noqa: E712
        )
    )).scalars().all()

    p_start, p_end = calc._period_bounds(pe)
    lines = line_fn(items, qbo_account_id, p_start, p_end)
    lines.sort(key=lambda r: (r["line_date"], r["line_kind"]))
    return {
        "qbo_account_id":   qbo_account_id,
        "period_end":       pe.isoformat(),
        "items":            lines,
        "committed":        True,
        "committed_at":     snapshot.committed_at.isoformat() if snapshot.committed_at else None,
        "has_uncommitted":  False,
    }


@router.get("/fixed_asset/suggestions")
async def fixed_asset_suggestions(
    tenant_id: CurrentTenantId,
    qbo_account_id: str = Query(...),
    period_end: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delta-based lines for the FA recon. One item may emit lines for
    BOTH the cost account AND the accumulated-depreciation account
    depending on which one the user opened."""
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    return await _generic_suggestions(
        db, tenant_id, "fixed_asset", qbo_account_id, pe,
        ScheduleFixedAsset, calc.fa_lines_for_account,
        extra_account_field="accumulated_dep_qbo_account_id",
    )


@router.get("/lease/suggestions")
async def lease_suggestions(
    tenant_id: CurrentTenantId,
    qbo_account_id: str = Query(...),
    period_end: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delta-based lines for the lease liability recon. Cash-basis leases
    (no discount_rate / initial_liability set) emit nothing."""
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    return await _generic_suggestions(
        db, tenant_id, "lease", qbo_account_id, pe,
        ScheduleLease, calc.lease_lines_for_account,
    )


@router.get("/loan/suggestions")
async def loan_suggestions(
    tenant_id: CurrentTenantId,
    qbo_account_id: str = Query(...),
    period_end: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delta-based lines for the loan liability recon."""
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    return await _generic_suggestions(
        db, tenant_id, "loan", qbo_account_id, pe,
        ScheduleLoan, calc.loan_lines_for_account,
    )


# ── Phase 1: Renewal alerts ──────────────────────────────────────────────
#
# Surfaces every active prepaid item that needs the user's attention this
# period — either expiring soon (so they should set up the renewal item)
# or already past its end-date (so they should mark it inactive). Pure
# database query, no QBO call, no AI inference. The "attention list" of
# the prepaids module — drives the orange banner on PrepaidsPage.


@router.get("/prepaid/alerts")
async def prepaid_alerts(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    expiring_within_days: int = Query(
        60, ge=1, le=365,
        description="Days lookahead for 'expiring soon' bucket.",
    ),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return two buckets of active prepaid items needing attention as of
    period_end:

      expiring_soon  end_date in (period_end, period_end + N days]
      past_due       end_date <= period_end (still flagged active)

    Each list sorted by end_date ascending so the most urgent rows
    bubble to the top. days_to_end is included so the UI can render
    "ends in 12 days" vs "ended 45 days ago" without a second pass
    over dates on the client.
    """
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")

    horizon = pe + _timedelta(days=expiring_within_days)

    rows = (await db.execute(
        select(SchedulePrepaid).where(
            SchedulePrepaid.tenant_id == tenant_id,
            SchedulePrepaid.is_active == True,  # noqa: E712
        ).order_by(SchedulePrepaid.end_date)
    )).scalars().all()

    expiring_soon: list[dict] = []
    past_due: list[dict] = []

    for r in rows:
        days_to_end = (r.end_date - pe).days
        item = {
            "id":             str(r.id),
            "qbo_account_id": r.qbo_account_id,
            "vendor":         r.vendor,
            "description":    r.description,
            "reference":      r.reference,
            "total_amount":   str(r.total_amount),
            "start_date":     r.start_date.isoformat(),
            "end_date":       r.end_date.isoformat(),
            "days_to_end":    days_to_end,
        }
        if days_to_end > 0 and r.end_date <= horizon:
            expiring_soon.append(item)
        elif days_to_end <= 0:
            past_due.append(item)

    return {
        "period_end":           pe.isoformat(),
        "expiring_within_days": expiring_within_days,
        "expiring_soon":        expiring_soon,
        "past_due":             past_due,
        "total":                len(expiring_soon) + len(past_due),
    }


# ── Phase 2: AI detection of new prepaids in GL ──────────────────────────
#
# Endpoints:
#   POST /prepaid/ai/scan       — run detector, persist new candidates,
#                                 return full open list + counts
#   GET  /prepaid/ai/candidates — list open candidates without re-scanning
#   POST /prepaid/ai/candidates/{id}/dismiss — user says "not a prepaid"
#   POST /prepaid/ai/candidates/{id}/accept  — user added a schedule item;
#                                 record the linkage so re-scans skip it
#
# Detection writes to prepaid_candidates (Alembic 024). Idempotent on
# rescan via the (tenant, gl_txn_id) unique constraint.


def _serialize_candidate(row: PrepaidCandidate) -> dict:
    return {
        "id":                str(row.id),
        "period_end":        row.period_end.isoformat(),
        "gl_account_id":     row.gl_account_id,
        "gl_account_name":   row.gl_account_name,
        "gl_txn_id":         row.gl_txn_id,
        "gl_txn_date":       row.gl_txn_date.isoformat(),
        "gl_amount":         str(row.gl_amount),
        "gl_memo":           row.gl_memo,
        "gl_vendor":         row.gl_vendor,
        "ai_vendor":         row.ai_vendor,
        "ai_service_start":  row.ai_service_start.isoformat() if row.ai_service_start else None,
        "ai_service_months": row.ai_service_months,
        "ai_method":         row.ai_method,
        "ai_confidence":     str(row.ai_confidence),
        "ai_reasoning":      row.ai_reasoning,
        "ai_target_account_id": row.ai_target_account_id,
        "status":            row.status,
        "accepted_item_id":  str(row.accepted_item_id) if row.accepted_item_id else None,
        "created_at":        row.created_at.isoformat() if row.created_at else None,
    }


# ── Import existing prepaids from QBO ─────────────────────────────────
#
# First-month onboarding helper. When a tenant starts using Nordavix
# they typically already have prepaid items sitting on their QBO BS
# in an "Other Current Assets" / "Prepaid Expenses" account. Rather
# than re-entering each one by hand, we offer to pull the historical
# GL entries from that account, propose a SchedulePrepaid per debit,
# and bulk-create on confirm.
#
# Preview-then-confirm flow:
#   1) Frontend POSTs preview_only=true → returns proposed items
#      with sensible defaults (12-month term from txn date).
#   2) User reviews the list, clicks "Import N items".
#   3) Frontend POSTs preview_only=false → creates the SchedulePrepaid
#      rows and returns the persisted serializations.
#
# Dedup: existing items on the same account with matching
# (description, total_amount, start_date) are skipped so re-running
# the import doesn't duplicate.


def _next_year_minus_one_day(d: _date) -> _date:
    """End date for a 1-year prepaid starting on `d`. Lands on the
    same calendar day next year minus one (so Jan 15 → Jan 14 next
    year, giving a 12-month coverage window exactly)."""
    try:
        target = _date(d.year + 1, d.month, d.day)
    except ValueError:
        # Leap-day fallback (Feb 29 → Feb 28)
        target = _date(d.year + 1, d.month, 28)
    return target - _timedelta(days=1)


@router.post("/prepaid/import-qbo", dependencies=[Depends(require_role("preparer"))])
async def prepaid_import_qbo(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Bulk-import prepaids from a QBO BS account.

    Body: {
      qbo_account_id:  str,   # the prepaid asset account
      lookback_months: int,   # how far back to scan (default 12)
      preview_only:    bool,  # true = dry-run, just return proposals
    }
    """
    qbo_id = ((body or {}).get("qbo_account_id") or "").strip()
    if not qbo_id:
        raise HTTPException(status_code=400, detail="qbo_account_id is required.")
    try:
        lookback = int((body or {}).get("lookback_months") or 12)
    except Exception:
        raise HTTPException(status_code=400, detail="lookback_months must be an integer.")
    if lookback < 1 or lookback > 60:
        raise HTTPException(status_code=400, detail="lookback_months must be between 1 and 60.")
    preview_only = bool((body or {}).get("preview_only") or False)

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    from core.qbo_gl import pull_gl_transactions

    end = _date.today()
    start = end - _timedelta(days=lookback * 30)

    try:
        txns = await pull_gl_transactions(conn, db, qbo_id, start, end)
    except Exception:
        logger.exception("Prepaid import-from-QBO: GL pull failed for acct=%s", qbo_id)
        raise HTTPException(status_code=502, detail="QBO GL pull failed. Try again.")

    # Dedup against existing items on the same account. Match on
    # (description_lower, total_amount, start_date) — strict enough to
    # catch true duplicates without skipping renewals that share a
    # vendor but have different dates/amounts.
    existing = list((await db.execute(
        select(SchedulePrepaid).where(
            SchedulePrepaid.tenant_id == tenant_id,
            SchedulePrepaid.qbo_account_id == qbo_id,
        )
    )).scalars().all())
    existing_keys = {
        (e.description.strip().lower(), str(e.total_amount), e.start_date.isoformat())
        for e in existing
        if e.description and e.start_date is not None
    }

    proposed: list[dict] = []
    skipped = 0
    for t in txns:
        amount_raw = t.get("amount") or Decimal("0")
        # Debits only — credits on a prepaid asset are amortization
        # reductions / writeoffs, not new prepaid additions.
        if amount_raw <= 0:
            continue
        amount = Decimal(amount_raw)
        txn_date = t.get("txn_date")
        if not txn_date:
            continue

        memo = (t.get("memo") or "").strip()[:200]
        vendor = (t.get("entity_name") or "").strip()
        description = memo or (vendor and f"{vendor} — prepaid") or "Prepaid (imported from QBO)"

        key = (description.strip().lower(), str(amount), txn_date.isoformat())
        if key in existing_keys:
            skipped += 1
            continue

        proposed.append({
            "qbo_account_id":      qbo_id,
            "description":         description[:255],
            "vendor":              (vendor[:255] if vendor else None),
            "reference":           ((t.get("txn_number") or "")[:100] or None),
            "invoice_date":        txn_date,
            "total_amount":        amount,
            "start_date":          txn_date,
            # Default 12-month coverage — user adjusts in the table
            # afterward. We pick this default because the vast majority
            # of small-business prepaids (insurance, SaaS, maintenance
            # contracts) are 12-month policies.
            "end_date":            _next_year_minus_one_day(txn_date),
            "amortization_method": "straight_line",
            "qbo_txn_id":          t.get("qbo_txn_id"),
        })

    # Sort by date desc so the most recent additions show first.
    proposed.sort(key=lambda p: p["start_date"], reverse=True)

    if preview_only:
        return {
            "preview":       True,
            "would_create":  len(proposed),
            "skipped":       skipped,
            "lookback_months": lookback,
            "items":         [_serialize_proposed_prepaid(p) for p in proposed],
        }

    # Create the items
    user_uuid = uuid.UUID(str(user.id)) if user else None
    created: list[SchedulePrepaid] = []
    for p in proposed:
        row = SchedulePrepaid(
            tenant_id=tenant_id,
            qbo_account_id=p["qbo_account_id"],
            description=p["description"],
            vendor=p["vendor"],
            reference=p["reference"],
            notes=f"Imported from QBO ({p.get('qbo_txn_id') or 'no-txn-id'}) on {_date.today().isoformat()}.",
            is_active=True,
            created_by=user_uuid,
            invoice_date=p["invoice_date"],
            total_amount=p["total_amount"],
            start_date=p["start_date"],
            end_date=p["end_date"],
            amortization_method=p["amortization_method"],
        )
        db.add(row)
        created.append(row)
    if created:
        # Bulk-import added lines → any committed snapshot for this
        # account is now stale; prompt a re-commit.
        await _invalidate_committed_snapshots(db, tenant_id, "prepaid", {qbo_id})
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user_uuid,
            action="schedule.prepaids_imported", entity_type="schedule_item", entity_id=None,
            metadata={"summary": f"Imported {len(created)} prepaid item(s) from QuickBooks into account {qbo_id}"},
        )
        await db.commit()
        for c in created:
            await db.refresh(c)

    return {
        "preview":  False,
        "created":  len(created),
        "skipped":  skipped,
        "items":    [_serialize("prepaid", r) for r in created],
    }


def _serialize_proposed_prepaid(p: dict) -> dict:
    return {
        "qbo_account_id":      p["qbo_account_id"],
        "description":         p["description"],
        "vendor":              p["vendor"],
        "reference":           p["reference"],
        "invoice_date":        p["invoice_date"].isoformat() if p["invoice_date"] else None,
        "total_amount":        str(p["total_amount"]),
        "start_date":          p["start_date"].isoformat(),
        "end_date":            p["end_date"].isoformat(),
        "amortization_method": p["amortization_method"],
        "qbo_txn_id":          p.get("qbo_txn_id"),
    }


# ── Accrual / FA / Loan import-from-QBO (mirror of prepaid_import_qbo) ─────
#
# Each pulls GL transactions on the user-selected liability/asset account
# over a lookback window, dedupes against existing schedule items, and
# either previews or creates real schedule rows with sensible per-type
# defaults the user can refine afterward. Pattern identical to the
# prepaid version above so the frontend banners can be carbon copies of
# ImportPrepaidsFromQboBanner with only the labels and defaults swapped.


def _first_of_next_month(d: _date) -> _date:
    """First day of the month after d. Used as default accrual reversal date —
    most accruals reverse on the first day of the following period."""
    if d.month == 12:
        return _date(d.year + 1, 1, 1)
    return _date(d.year, d.month + 1, 1)


def _serialize_proposed_accrual(p: dict) -> dict:
    return {
        "qbo_account_id": p["qbo_account_id"],
        "description":   p["description"],
        "vendor":        p["vendor"],
        "reference":     p["reference"],
        "accrual_date":  p["accrual_date"].isoformat(),
        "amount":        str(p["amount"]),
        "reverses_on":   p["reverses_on"].isoformat() if p["reverses_on"] else None,
        "qbo_txn_id":    p.get("qbo_txn_id"),
    }


def _serialize_proposed_fixed_asset(p: dict) -> dict:
    return {
        "qbo_account_id":      p["qbo_account_id"],
        "description":         p["description"],
        "vendor":              p["vendor"],
        "reference":           p["reference"],
        "category":            p.get("category"),
        "in_service_date":     p["in_service_date"].isoformat(),
        "cost":                str(p["cost"]),
        "salvage_value":       str(p["salvage_value"]),
        "useful_life_months":  p["useful_life_months"],
        "depreciation_method": p["depreciation_method"],
        "qbo_txn_id":          p.get("qbo_txn_id"),
    }


def _serialize_proposed_loan(p: dict) -> dict:
    return {
        "qbo_account_id":     p["qbo_account_id"],
        "description":        p["description"],
        "vendor":             p["vendor"],     # lender stored in vendor for proposal symmetry
        "reference":          p["reference"],
        "loan_date":          p["loan_date"].isoformat(),
        "original_principal": str(p["original_principal"]),
        "interest_rate_pct":  str(p["interest_rate_pct"]),
        "term_months":        p["term_months"],
        "payment_type":       p["payment_type"],
        "qbo_txn_id":         p.get("qbo_txn_id"),
    }


@router.post("/accrual/import-qbo", dependencies=[Depends(require_role("preparer"))])
async def accrual_import_qbo(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Bulk-import accruals from a QBO BS liability account.

    Body: {
      qbo_account_id:  str,   # the accrued liability account
      lookback_months: int,   # how far back to scan (default 12)
      preview_only:    bool,
    }

    Accruals are credit-natural — we import CREDIT postings as new
    accruals (debits are usually the reversal entry and shouldn't
    create new items).
    """
    qbo_id = ((body or {}).get("qbo_account_id") or "").strip()
    if not qbo_id:
        raise HTTPException(status_code=400, detail="qbo_account_id is required.")
    try:
        lookback = int((body or {}).get("lookback_months") or 12)
    except Exception:
        raise HTTPException(status_code=400, detail="lookback_months must be an integer.")
    if lookback < 1 or lookback > 60:
        raise HTTPException(status_code=400, detail="lookback_months must be between 1 and 60.")
    preview_only = bool((body or {}).get("preview_only") or False)

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    from core.qbo_gl import pull_gl_transactions

    end = _date.today()
    start = end - _timedelta(days=lookback * 30)

    try:
        txns = await pull_gl_transactions(conn, db, qbo_id, start, end)
    except Exception:
        logger.exception("Accrual import-from-QBO: GL pull failed for acct=%s", qbo_id)
        raise HTTPException(status_code=502, detail="QBO GL pull failed. Try again.")

    existing = list((await db.execute(
        select(ScheduleAccrual).where(
            ScheduleAccrual.tenant_id == tenant_id,
            ScheduleAccrual.qbo_account_id == qbo_id,
        )
    )).scalars().all())
    existing_keys = {
        (e.description.strip().lower(), str(e.amount), e.accrual_date.isoformat())
        for e in existing
        if e.description and e.accrual_date is not None
    }

    proposed: list[dict] = []
    skipped = 0
    for t in txns:
        amount_raw = t.get("amount") or Decimal("0")
        # Accruals = CREDIT postings (negative debit amount in GL convention).
        # Debits to the liability are reversal/payment entries — not new accruals.
        if amount_raw >= 0:
            continue
        amount = abs(Decimal(amount_raw))
        txn_date = t.get("txn_date")
        if not txn_date:
            continue

        memo = (t.get("memo") or "").strip()[:200]
        vendor = (t.get("entity_name") or "").strip()
        description = memo or (vendor and f"{vendor} — accrual") or "Accrual (imported from QBO)"

        key = (description.strip().lower(), str(amount), txn_date.isoformat())
        if key in existing_keys:
            skipped += 1
            continue

        proposed.append({
            "qbo_account_id": qbo_id,
            "description":    description[:255],
            "vendor":         (vendor[:255] if vendor else None),
            "reference":      ((t.get("txn_number") or "")[:100] or None),
            "accrual_date":   txn_date,
            "amount":         amount,
            # Default: reverses on the 1st of next month. Most accruals
            # are month-end JEs that reverse on day-one of the next month.
            "reverses_on":    _first_of_next_month(txn_date),
            "qbo_txn_id":     t.get("qbo_txn_id"),
        })

    proposed.sort(key=lambda p: p["accrual_date"], reverse=True)

    if preview_only:
        return {
            "preview":         True,
            "would_create":    len(proposed),
            "skipped":         skipped,
            "lookback_months": lookback,
            "items":           [_serialize_proposed_accrual(p) for p in proposed],
        }

    user_uuid = uuid.UUID(str(user.id)) if user else None
    created: list[ScheduleAccrual] = []
    for p in proposed:
        row = ScheduleAccrual(
            tenant_id=tenant_id,
            qbo_account_id=p["qbo_account_id"],
            description=p["description"],
            vendor=p["vendor"],
            reference=p["reference"],
            notes=f"Imported from QBO ({p.get('qbo_txn_id') or 'no-txn-id'}) on {_date.today().isoformat()}.",
            is_active=True,
            created_by=user_uuid,
            accrual_date=p["accrual_date"],
            amount=p["amount"],
            reverses_on=p["reverses_on"],
            is_reversed=False,
        )
        db.add(row)
        created.append(row)
    if created:
        # Bulk-import added lines → any committed snapshot for this
        # account is now stale; prompt a re-commit.
        await _invalidate_committed_snapshots(db, tenant_id, "accrual", {qbo_id})
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user_uuid,
            action="schedule.accruals_imported", entity_type="schedule_item", entity_id=None,
            metadata={"summary": f"Imported {len(created)} accrual item(s) from QuickBooks into account {qbo_id}"},
        )
        await db.commit()
        for c in created:
            await db.refresh(c)

    return {
        "preview": False,
        "created": len(created),
        "skipped": skipped,
        "items":   [_serialize("accrual", r) for r in created],
    }


@router.post("/fixed-asset/import-qbo", dependencies=[Depends(require_role("preparer"))])
async def fixed_asset_import_qbo(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Bulk-import fixed assets from a QBO BS asset account.

    Body: {
      qbo_account_id:  str,   # the FA COST account (not accum-dep)
      lookback_months: int,   # default 24 — assets are typically longer-lived
      preview_only:    bool,
      useful_life_months: int (optional, default 60 = 5 years),
    }

    Each debit to the cost account becomes a new fixed asset row.
    Default useful_life_months = 60 (5 years, standard MACRS class life
    for office equipment), straight-line, $0 salvage. User edits per row.
    """
    qbo_id = ((body or {}).get("qbo_account_id") or "").strip()
    if not qbo_id:
        raise HTTPException(status_code=400, detail="qbo_account_id is required.")
    try:
        lookback = int((body or {}).get("lookback_months") or 24)
    except Exception:
        raise HTTPException(status_code=400, detail="lookback_months must be an integer.")
    if lookback < 1 or lookback > 120:
        raise HTTPException(status_code=400, detail="lookback_months must be between 1 and 120.")
    preview_only = bool((body or {}).get("preview_only") or False)
    try:
        default_life = int((body or {}).get("useful_life_months") or 60)
    except Exception:
        raise HTTPException(status_code=400, detail="useful_life_months must be an integer.")
    if default_life < 1 or default_life > 600:
        raise HTTPException(status_code=400, detail="useful_life_months must be between 1 and 600.")

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    from core.qbo_gl import pull_gl_transactions

    end = _date.today()
    start = end - _timedelta(days=lookback * 30)

    try:
        txns = await pull_gl_transactions(conn, db, qbo_id, start, end)
    except Exception:
        logger.exception("FA import-from-QBO: GL pull failed for acct=%s", qbo_id)
        raise HTTPException(status_code=502, detail="QBO GL pull failed. Try again.")

    existing = list((await db.execute(
        select(ScheduleFixedAsset).where(
            ScheduleFixedAsset.tenant_id == tenant_id,
            ScheduleFixedAsset.qbo_account_id == qbo_id,
        )
    )).scalars().all())
    existing_keys = {
        (e.description.strip().lower(), str(e.cost), e.in_service_date.isoformat())
        for e in existing
        if e.description and e.in_service_date is not None
    }

    proposed: list[dict] = []
    skipped = 0
    for t in txns:
        amount_raw = t.get("amount") or Decimal("0")
        # Debits only — credits on a cost account are disposals/writeoffs,
        # not new asset acquisitions.
        if amount_raw <= 0:
            continue
        amount = Decimal(amount_raw)
        txn_date = t.get("txn_date")
        if not txn_date:
            continue

        memo = (t.get("memo") or "").strip()[:200]
        vendor = (t.get("entity_name") or "").strip()
        description = memo or (vendor and f"{vendor} — asset") or "Fixed asset (imported from QBO)"

        key = (description.strip().lower(), str(amount), txn_date.isoformat())
        if key in existing_keys:
            skipped += 1
            continue

        proposed.append({
            "qbo_account_id":      qbo_id,
            "description":         description[:255],
            "vendor":              (vendor[:255] if vendor else None),
            "reference":           ((t.get("txn_number") or "")[:100] or None),
            "category":            None,   # user picks per asset
            "in_service_date":     txn_date,
            "cost":                amount,
            "salvage_value":       Decimal("0.00"),
            "useful_life_months":  default_life,
            "depreciation_method": "straight_line",
            "qbo_txn_id":          t.get("qbo_txn_id"),
        })

    proposed.sort(key=lambda p: p["in_service_date"], reverse=True)

    if preview_only:
        return {
            "preview":         True,
            "would_create":    len(proposed),
            "skipped":         skipped,
            "lookback_months": lookback,
            "useful_life_months": default_life,
            "items":           [_serialize_proposed_fixed_asset(p) for p in proposed],
        }

    user_uuid = uuid.UUID(str(user.id)) if user else None
    created: list[ScheduleFixedAsset] = []
    for p in proposed:
        row = ScheduleFixedAsset(
            tenant_id=tenant_id,
            qbo_account_id=p["qbo_account_id"],
            description=p["description"],
            vendor=p["vendor"],
            reference=p["reference"],
            notes=f"Imported from QBO ({p.get('qbo_txn_id') or 'no-txn-id'}) on {_date.today().isoformat()}.",
            is_active=True,
            created_by=user_uuid,
            category=p["category"],
            in_service_date=p["in_service_date"],
            cost=p["cost"],
            salvage_value=p["salvage_value"],
            useful_life_months=p["useful_life_months"],
            depreciation_method=p["depreciation_method"],
        )
        db.add(row)
        created.append(row)
    if created:
        # Bulk-import added lines → any committed snapshot for this
        # account is now stale; prompt a re-commit.
        await _invalidate_committed_snapshots(db, tenant_id, "fixed_asset", {qbo_id})
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user_uuid,
            action="schedule.fixed_assets_imported", entity_type="schedule_item", entity_id=None,
            metadata={"summary": f"Imported {len(created)} fixed asset(s) from QuickBooks into account {qbo_id}"},
        )
        await db.commit()
        for c in created:
            await db.refresh(c)

    return {
        "preview": False,
        "created": len(created),
        "skipped": skipped,
        "items":   [_serialize("fixed_asset", r) for r in created],
    }


@router.post("/loan/import-qbo", dependencies=[Depends(require_role("preparer"))])
async def loan_import_qbo(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Bulk-import loans from a QBO BS liability account.

    Body: {
      qbo_account_id:  str,   # the loan payable / notes payable account
      lookback_months: int,   # default 24
      preview_only:    bool,
    }

    Each CREDIT to the liability becomes a new loan row with the
    transaction amount as original_principal. Interest rate, term, and
    monthly payment can't be derived from GL data — they default to
    placeholders (0% / 60mo / no payment) and the user MUST edit each
    row to fill in the real terms before any payment activity rolls
    forward correctly.
    """
    qbo_id = ((body or {}).get("qbo_account_id") or "").strip()
    if not qbo_id:
        raise HTTPException(status_code=400, detail="qbo_account_id is required.")
    try:
        lookback = int((body or {}).get("lookback_months") or 24)
    except Exception:
        raise HTTPException(status_code=400, detail="lookback_months must be an integer.")
    if lookback < 1 or lookback > 120:
        raise HTTPException(status_code=400, detail="lookback_months must be between 1 and 120.")
    preview_only = bool((body or {}).get("preview_only") or False)

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    from core.qbo_gl import pull_gl_transactions

    end = _date.today()
    start = end - _timedelta(days=lookback * 30)

    try:
        txns = await pull_gl_transactions(conn, db, qbo_id, start, end)
    except Exception:
        logger.exception("Loan import-from-QBO: GL pull failed for acct=%s", qbo_id)
        raise HTTPException(status_code=502, detail="QBO GL pull failed. Try again.")

    existing = list((await db.execute(
        select(ScheduleLoan).where(
            ScheduleLoan.tenant_id == tenant_id,
            ScheduleLoan.qbo_account_id == qbo_id,
        )
    )).scalars().all())
    existing_keys = {
        (e.description.strip().lower(), str(e.original_principal), e.loan_date.isoformat())
        for e in existing
        if e.description and e.loan_date is not None
    }

    proposed: list[dict] = []
    skipped = 0
    for t in txns:
        amount_raw = t.get("amount") or Decimal("0")
        # Originations = CREDIT to liability. Debits are principal
        # payments and shouldn't create new loans.
        if amount_raw >= 0:
            continue
        amount = abs(Decimal(amount_raw))
        txn_date = t.get("txn_date")
        if not txn_date:
            continue

        memo = (t.get("memo") or "").strip()[:200]
        lender = (t.get("entity_name") or "").strip()
        description = memo or (lender and f"{lender} — loan") or "Loan (imported from QBO)"

        key = (description.strip().lower(), str(amount), txn_date.isoformat())
        if key in existing_keys:
            skipped += 1
            continue

        proposed.append({
            "qbo_account_id":     qbo_id,
            "description":        description[:255],
            # Lender is stored in the shared `vendor` column on the
            # schedule_loans table for proposal symmetry — the actual
            # ScheduleLoan model has a typed `lender` column. We map
            # vendor → lender at create time below.
            "vendor":             (lender[:255] if lender else None),
            "reference":          ((t.get("txn_number") or "")[:100] or None),
            "loan_date":          txn_date,
            "original_principal": amount,
            "interest_rate_pct":  Decimal("0.0000"),  # user MUST edit
            "term_months":        60,                  # placeholder
            "payment_type":       "amortizing",
            "qbo_txn_id":         t.get("qbo_txn_id"),
        })

    proposed.sort(key=lambda p: p["loan_date"], reverse=True)

    if preview_only:
        return {
            "preview":         True,
            "would_create":    len(proposed),
            "skipped":         skipped,
            "lookback_months": lookback,
            "items":           [_serialize_proposed_loan(p) for p in proposed],
        }

    user_uuid = uuid.UUID(str(user.id)) if user else None
    created: list[ScheduleLoan] = []
    for p in proposed:
        row = ScheduleLoan(
            tenant_id=tenant_id,
            qbo_account_id=p["qbo_account_id"],
            description=p["description"],
            vendor=p["vendor"],
            reference=p["reference"],
            notes=(
                f"Imported from QBO ({p.get('qbo_txn_id') or 'no-txn-id'}) on "
                f"{_date.today().isoformat()}. INTEREST RATE and TERM are "
                "placeholders — edit this row to set the real loan terms before "
                "running any close."
            ),
            is_active=True,
            created_by=user_uuid,
            lender=p["vendor"],   # vendor column → lender on ScheduleLoan
            loan_date=p["loan_date"],
            original_principal=p["original_principal"],
            interest_rate_pct=p["interest_rate_pct"],
            term_months=p["term_months"],
            monthly_payment=None,
            payment_type=p["payment_type"],
        )
        db.add(row)
        created.append(row)
    if created:
        # Bulk-import added lines → any committed snapshot for this
        # account is now stale; prompt a re-commit.
        await _invalidate_committed_snapshots(db, tenant_id, "loan", {qbo_id})
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user_uuid,
            action="schedule.loans_imported", entity_type="schedule_item", entity_id=None,
            metadata={"summary": f"Imported {len(created)} loan(s) from QuickBooks into account {qbo_id}"},
        )
        await db.commit()
        for c in created:
            await db.refresh(c)

    return {
        "preview": False,
        "created": len(created),
        "skipped": skipped,
        "items":   [_serialize("loan", r) for r in created],
    }


@router.post("/prepaid/ai/scan",
             dependencies=[Depends(require_role("preparer")), Depends(enforce_ai_limits)])
async def prepaid_ai_scan(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    materiality_floor: str = Query(
        "500.00",
        description="Decimal floor in USD — txns below this are skipped.",
    ),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Scan the period for likely new prepaids. Runs synchronously (5-15s
    typical) — the UI shows a spinner on the Scan button.
    """
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    try:
        floor = Decimal(materiality_floor)
    except Exception:
        raise HTTPException(status_code=400, detail="materiality_floor must be a number.")

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    result = await scan_for_prepaid_candidates(
        conn, db,
        tenant_id=tenant_id,
        period_end=pe,
        materiality_floor=floor,
    )

    # The detector commits the candidate rows itself; this commit only
    # needs to persist the audit entry.
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.ai_scan_run", entity_type="prepaid_candidate", entity_id=None,
        metadata={"summary": f"AI prepaid scan found {result['new_candidates']} candidates for {pe.isoformat()}"},
    )
    await db.commit()

    return {
        "scanned_accounts": result["scanned_accounts"],
        "scanned_txns":     result["scanned_txns"],
        "new_candidates":   result["new_candidates"],
        "candidates":       [_serialize_candidate(r) for r in result["open"]],
    }


@router.get("/prepaid/ai/candidates")
async def prepaid_ai_candidates(
    tenant_id: CurrentTenantId,
    status: str = Query("open", description="open | accepted | dismissed | all"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """List PrepaidCandidate rows. Defaults to open. Used by the banner
    on PrepaidsPage to render without forcing a fresh scan."""
    q = select(PrepaidCandidate).where(PrepaidCandidate.tenant_id == tenant_id)
    if status != "all":
        q = q.where(PrepaidCandidate.status == status)
    q = q.order_by(
        PrepaidCandidate.ai_confidence.desc(),
        PrepaidCandidate.gl_amount.desc(),
    )
    rows = list((await db.execute(q)).scalars().all())
    return {
        "status":     status,
        "candidates": [_serialize_candidate(r) for r in rows],
    }


@router.post("/prepaid/ai/candidates/{candidate_id}/dismiss",
             dependencies=[Depends(require_role("preparer"))])
async def prepaid_ai_dismiss(
    candidate_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """User clicked 'Not a prepaid'. The candidate is silenced — future
    scans won't re-surface this txn (matched by gl_txn_id uniqueness)."""
    try:
        cid = uuid.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid candidate id.")

    row = (await db.execute(
        select(PrepaidCandidate).where(
            PrepaidCandidate.tenant_id == tenant_id,
            PrepaidCandidate.id == cid,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found.")

    row.status = "dismissed"
    row.status_changed_at = _datetime.utcnow()
    row.status_changed_by = uuid.UUID(str(user.id)) if user else None
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.candidate_dismissed", entity_type="prepaid_candidate", entity_id=row.id,
        metadata={"summary": f"Dismissed AI prepaid candidate '{row.gl_vendor or row.gl_memo or row.gl_txn_id}'"},
    )
    await db.commit()
    return {"id": str(row.id), "status": row.status}


@router.post("/prepaid/ai/candidates/{candidate_id}/accept",
             dependencies=[Depends(require_role("preparer"))])
async def prepaid_ai_accept(
    candidate_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(default={}),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Called by the frontend after it successfully creates a SchedulePrepaid
    from a candidate. Records the linkage so re-scans skip the source
    GL txn. Body: { schedule_item_id: "UUID" }.
    """
    try:
        cid = uuid.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid candidate id.")

    raw_item_id = (body or {}).get("schedule_item_id")
    item_uuid: uuid.UUID | None = None
    if raw_item_id:
        try:
            item_uuid = uuid.UUID(str(raw_item_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="schedule_item_id must be a UUID.")

    row = (await db.execute(
        select(PrepaidCandidate).where(
            PrepaidCandidate.tenant_id == tenant_id,
            PrepaidCandidate.id == cid,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found.")

    row.status = "accepted"
    row.status_changed_at = _datetime.utcnow()
    row.status_changed_by = uuid.UUID(str(user.id)) if user else None
    row.accepted_item_id = item_uuid
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.candidate_accepted", entity_type="prepaid_candidate", entity_id=row.id,
        metadata={"summary": f"Accepted AI prepaid candidate '{row.gl_vendor or row.gl_memo or row.gl_txn_id}'"},
    )
    await db.commit()
    return {"id": str(row.id), "status": row.status, "accepted_item_id": str(item_uuid) if item_uuid else None}


# ── Accrual AI: missed accruals (a) + unreversed accruals (d) ────────────


def _serialize_missed_accrual(row: MissedAccrualCandidate) -> dict:
    return {
        "id":                   str(row.id),
        "period_end":           row.period_end.isoformat(),
        "gl_account_id":        row.gl_account_id,
        "gl_account_name":      row.gl_account_name,
        "gl_txn_id":            row.gl_txn_id,
        "gl_txn_date":          row.gl_txn_date.isoformat(),
        "gl_amount":            str(row.gl_amount),
        "gl_memo":              row.gl_memo,
        "gl_vendor":            row.gl_vendor,
        "ai_vendor":            row.ai_vendor,
        "ai_service_period_end": row.ai_service_period_end.isoformat() if row.ai_service_period_end else None,
        "ai_suggested_amount":  str(row.ai_suggested_amount) if row.ai_suggested_amount is not None else None,
        "ai_confidence":        str(row.ai_confidence),
        "ai_reasoning":         row.ai_reasoning,
        "ai_target_account_id": row.ai_target_account_id,
        "status":               row.status,
        "accepted_item_id":     str(row.accepted_item_id) if row.accepted_item_id else None,
        "created_at":           row.created_at.isoformat() if row.created_at else None,
    }


@router.post("/accrual/ai/scan-missed",
             dependencies=[Depends(require_role("preparer")), Depends(enforce_ai_limits)])
async def accrual_ai_scan_missed(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="YYYY-MM-DD — the period_end we're checking for missed accruals."),
    materiality_floor: str = Query("500.00"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Scan the month AFTER period_end (plus first 15 days of the
    month after that) for payments that look like missed accruals."""
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    try:
        floor = Decimal(materiality_floor)
    except Exception:
        raise HTTPException(status_code=400, detail="materiality_floor must be a number.")

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    result = await scan_for_missed_accruals(
        conn, db,
        tenant_id=tenant_id,
        period_end=pe,
        materiality_floor=floor,
    )
    # The detector commits the candidate rows itself; this commit only
    # needs to persist the audit entry.
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.ai_scan_run", entity_type="missed_accrual_candidate", entity_id=None,
        metadata={"summary": f"AI missed-accrual scan found {result['new_candidates']} candidates for {pe.isoformat()}"},
    )
    await db.commit()
    return {
        "scanned_accounts": result["scanned_accounts"],
        "scanned_txns":     result["scanned_txns"],
        "scan_window":      result.get("scan_window"),
        "new_candidates":   result["new_candidates"],
        "candidates":       [_serialize_missed_accrual(r) for r in result["open"]],
    }


@router.get("/accrual/ai/missed-candidates")
async def accrual_ai_missed_candidates(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    status: str = Query("open"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """List missed-accrual candidates for the given period_end without
    re-scanning. Hydrates the banner on page load."""
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    q = select(MissedAccrualCandidate).where(
        MissedAccrualCandidate.tenant_id == tenant_id,
        MissedAccrualCandidate.period_end == pe,
    )
    if status != "all":
        q = q.where(MissedAccrualCandidate.status == status)
    q = q.order_by(
        MissedAccrualCandidate.ai_confidence.desc(),
        MissedAccrualCandidate.gl_amount.desc(),
    )
    rows = list((await db.execute(q)).scalars().all())
    return {
        "period_end": pe.isoformat(),
        "status":     status,
        "candidates": [_serialize_missed_accrual(r) for r in rows],
    }


@router.post("/accrual/ai/missed-candidates/{candidate_id}/dismiss",
             dependencies=[Depends(require_role("preparer"))])
async def accrual_ai_missed_dismiss(
    candidate_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        cid = uuid.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid candidate id.")
    row = (await db.execute(
        select(MissedAccrualCandidate).where(
            MissedAccrualCandidate.tenant_id == tenant_id,
            MissedAccrualCandidate.id == cid,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found.")
    row.status = "dismissed"
    row.status_changed_at = _datetime.utcnow()
    row.status_changed_by = uuid.UUID(str(user.id)) if user else None
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.candidate_dismissed", entity_type="missed_accrual_candidate", entity_id=row.id,
        metadata={"summary": f"Dismissed AI missed-accrual candidate '{row.gl_vendor or row.gl_memo or row.gl_txn_id}'"},
    )
    await db.commit()
    return {"id": str(row.id), "status": row.status}


@router.post("/accrual/ai/missed-candidates/{candidate_id}/accept",
             dependencies=[Depends(require_role("preparer"))])
async def accrual_ai_missed_accept(
    candidate_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(default={}),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Called by the frontend after it creates a ScheduleAccrual from
    the candidate. Records the linkage so re-scans skip the txn."""
    try:
        cid = uuid.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid candidate id.")
    raw_item_id = (body or {}).get("schedule_item_id")
    item_uuid: uuid.UUID | None = None
    if raw_item_id:
        try:
            item_uuid = uuid.UUID(str(raw_item_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="schedule_item_id must be a UUID.")
    row = (await db.execute(
        select(MissedAccrualCandidate).where(
            MissedAccrualCandidate.tenant_id == tenant_id,
            MissedAccrualCandidate.id == cid,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found.")
    row.status = "accepted"
    row.status_changed_at = _datetime.utcnow()
    row.status_changed_by = uuid.UUID(str(user.id)) if user else None
    row.accepted_item_id = item_uuid
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.candidate_accepted", entity_type="missed_accrual_candidate", entity_id=row.id,
        metadata={"summary": f"Accepted AI missed-accrual candidate '{row.gl_vendor or row.gl_memo or row.gl_txn_id}'"},
    )
    await db.commit()
    return {"id": str(row.id), "status": row.status, "accepted_item_id": str(item_uuid) if item_uuid else None}


@router.get("/accrual/ai/unreversed")
async def accrual_ai_unreversed(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Feature (d) — find active, not-reversed accruals that should
    have reversed by period_end, and attempt to match each to a
    current-period GL payment. Pure heuristic match — no AI call."""
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")
    rows = await find_unreversed_accruals(
        conn, db, tenant_id=tenant_id, period_end=pe,
    )
    return {
        "period_end": pe.isoformat(),
        "items":      rows,
        "total":      len(rows),
    }


# ── AI fixed-asset detection ────────────────────────────────────────────
#
# Mirrors the prepaid AI endpoints (scan / list / dismiss / accept).
# Identifies expense-account transactions that should have been
# capitalized as fixed assets per US-GAAP (tangible asset, useful life
# > 1 year, cost ≥ cap threshold). See fixed_asset_detector.py for the
# detailed capitalization logic and the Claude prompt.

def _serialize_fa_candidate(row: FixedAssetCandidate) -> dict:
    return {
        "id":                    str(row.id),
        "period_end":            row.period_end.isoformat(),
        "gl_account_id":         row.gl_account_id,
        "gl_account_name":       row.gl_account_name,
        "gl_txn_id":             row.gl_txn_id,
        "gl_txn_date":           row.gl_txn_date.isoformat(),
        "gl_amount":             str(row.gl_amount),
        "gl_memo":               row.gl_memo,
        "gl_vendor":             row.gl_vendor,
        "ai_description":        row.ai_description,
        "ai_vendor":             row.ai_vendor,
        "ai_category":           row.ai_category,
        "ai_in_service_date":    row.ai_in_service_date.isoformat() if row.ai_in_service_date else None,
        "ai_cost":               str(row.ai_cost) if row.ai_cost is not None else None,
        "ai_salvage_value":      str(row.ai_salvage_value) if row.ai_salvage_value is not None else None,
        "ai_useful_life_months": row.ai_useful_life_months,
        "ai_confidence":         str(row.ai_confidence),
        "ai_reasoning":          row.ai_reasoning,
        "ai_target_account_id":  row.ai_target_account_id,
        "status":                row.status,
        "accepted_item_id":      str(row.accepted_item_id) if row.accepted_item_id else None,
        "created_at":            row.created_at.isoformat() if row.created_at else None,
    }


@router.post("/fixed_asset/ai/scan",
             dependencies=[Depends(require_role("preparer")), Depends(enforce_ai_limits)])
async def fixed_asset_ai_scan(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="YYYY-MM-DD"),
    cap_threshold: str = Query(
        "1000.00",
        description=(
            "USD capitalization threshold. Anything below is below the de minimis "
            "safe harbor and won't be considered. IRS allows up to $2,500 "
            "without AFS, $5,000 with AFS."
        ),
    ),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Scan the period's expense GL for entries that should have been
    capitalized as fixed assets. Synchronous (5-15s typical)."""
    pe = _parse_date(period_end, "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required.")
    try:
        threshold = Decimal(cap_threshold)
    except Exception:
        raise HTTPException(status_code=400, detail="cap_threshold must be a number.")

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    result = await scan_for_fixed_asset_candidates(
        conn, db,
        tenant_id=tenant_id,
        period_end=pe,
        cap_threshold=threshold,
    )
    # The detector commits the candidate rows itself; this commit only
    # needs to persist the audit entry.
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.ai_scan_run", entity_type="fixed_asset_candidate", entity_id=None,
        metadata={"summary": f"AI fixed-asset scan found {result['new_candidates']} candidates for {pe.isoformat()}"},
    )
    await db.commit()
    return {
        "scanned_accounts": result["scanned_accounts"],
        "scanned_txns":     result["scanned_txns"],
        "ai_classified":    result.get("ai_classified", 0),
        "new_candidates":   result["new_candidates"],
        "cap_threshold":    str(threshold),
        "candidates":       [_serialize_fa_candidate(r) for r in result["open"]],
    }


@router.get("/fixed_asset/ai/candidates")
async def fixed_asset_ai_candidates(
    tenant_id: CurrentTenantId,
    status: str = Query("open", description="open | accepted | dismissed | all"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """List FixedAssetCandidate rows. Defaults to open. Used by the
    banner on FixedAssetsPage to render without forcing a fresh scan."""
    q = select(FixedAssetCandidate).where(FixedAssetCandidate.tenant_id == tenant_id)
    if status != "all":
        q = q.where(FixedAssetCandidate.status == status)
    q = q.order_by(
        FixedAssetCandidate.ai_confidence.desc(),
        FixedAssetCandidate.gl_amount.desc(),
    )
    rows = list((await db.execute(q)).scalars().all())
    return {
        "status":     status,
        "candidates": [_serialize_fa_candidate(r) for r in rows],
    }


@router.post("/fixed_asset/ai/candidates/{candidate_id}/dismiss",
             dependencies=[Depends(require_role("preparer"))])
async def fixed_asset_ai_dismiss(
    candidate_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """User clicked 'Not a fixed asset'. The candidate is silenced —
    future scans won't re-surface this txn (matched by gl_txn_id)."""
    try:
        cid = uuid.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid candidate id.")
    row = (await db.execute(
        select(FixedAssetCandidate).where(
            FixedAssetCandidate.tenant_id == tenant_id,
            FixedAssetCandidate.id == cid,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found.")
    row.status = "dismissed"
    row.status_changed_at = _datetime.utcnow()
    row.status_changed_by = uuid.UUID(str(user.id)) if user else None
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.candidate_dismissed", entity_type="fixed_asset_candidate", entity_id=row.id,
        metadata={"summary": f"Dismissed AI fixed-asset candidate '{row.ai_description or row.gl_vendor or row.gl_memo or row.gl_txn_id}'"},
    )
    await db.commit()
    return {"id": str(row.id), "status": row.status}


@router.post("/fixed_asset/ai/candidates/{candidate_id}/accept",
             dependencies=[Depends(require_role("preparer"))])
async def fixed_asset_ai_accept(
    candidate_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    body: dict = Body(default={}),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Called by the frontend after it creates a ScheduleFixedAsset
    from the candidate. Records the linkage so re-scans skip the txn.
    Body: { schedule_item_id: "UUID" }."""
    try:
        cid = uuid.UUID(candidate_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid candidate id.")
    raw_item_id = (body or {}).get("schedule_item_id")
    item_uuid: uuid.UUID | None = None
    if raw_item_id:
        try:
            item_uuid = uuid.UUID(str(raw_item_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="schedule_item_id must be a UUID.")
    row = (await db.execute(
        select(FixedAssetCandidate).where(
            FixedAssetCandidate.tenant_id == tenant_id,
            FixedAssetCandidate.id == cid,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Candidate not found.")
    row.status = "accepted"
    row.status_changed_at = _datetime.utcnow()
    row.status_changed_by = uuid.UUID(str(user.id)) if user else None
    row.accepted_item_id = item_uuid
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="schedule.candidate_accepted", entity_type="fixed_asset_candidate", entity_id=row.id,
        metadata={"summary": f"Accepted AI fixed-asset candidate '{row.ai_description or row.gl_vendor or row.gl_memo or row.gl_txn_id}'"},
    )
    await db.commit()
    return {"id": str(row.id), "status": row.status, "accepted_item_id": str(item_uuid) if item_uuid else None}
