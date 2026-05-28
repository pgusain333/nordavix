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
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.db.session import get_db
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
        "is_active":      row.is_active,
        "created_at":     row.created_at.isoformat() if row.created_at else None,
        "updated_at":     row.updated_at.isoformat() if row.updated_at else None,
    }


def _serialize(schedule_type: str, row) -> dict:
    out = _serialize_common(row)
    if schedule_type == "prepaid":
        out.update({
            "invoice_date":   row.invoice_date.isoformat() if row.invoice_date else None,
            "total_amount":   str(row.total_amount),
            "start_date":     row.start_date.isoformat(),
            "end_date":       row.end_date.isoformat(),
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
    if "is_active" in body:     row.is_active = bool(body.get("is_active"))

    if schedule_type == "prepaid":
        if "invoice_date" in body: row.invoice_date = _parse_date(body.get("invoice_date"), "invoice_date")
        if "total_amount" in body: row.total_amount = _dec(body.get("total_amount")) or Decimal("0")
        if "start_date" in body:   row.start_date = _parse_date(body.get("start_date"), "start_date")
        if "end_date" in body:     row.end_date = _parse_date(body.get("end_date"), "end_date")
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


# ── Endpoints ─────────────────────────────────────────────────────────────


@router.get("/accounts")
async def list_accounts(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Active balance-sheet accounts available to map schedule items to.
    Pulled live from QBO with the same query the books-setup wizard
    uses so the picker always reflects the current chart of accounts.

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
    types = list(ACCOUNT_TYPE_GROUPS.keys())
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
        if atype not in ACCOUNT_TYPE_GROUPS:
            continue
        out.append({
            "qbo_account_id": str(a.get("Id") or ""),
            "name":           str(a.get("Name") or ""),
            "number":         str(a.get("AcctNum") or ""),
            "account_type":   atype,
            "group_label":    ACCOUNT_TYPE_GROUPS[atype],
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
    await db.commit()
    await db.refresh(row)
    return _serialize(schedule_type, row)


@router.put("/{schedule_type}/{item_id}", dependencies=[Depends(require_role("preparer"))])
async def update_item(
    schedule_type: str,
    item_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    body: dict = Body(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    Model = _model_for(schedule_type)
    row = (await db.execute(
        select(Model).where(Model.tenant_id == tenant_id, Model.id == item_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{schedule_type} item not found.")
    _apply_body(schedule_type, row, body)
    await db.commit()
    await db.refresh(row)
    return _serialize(schedule_type, row)


@router.delete("/{schedule_type}/{item_id}", dependencies=[Depends(require_role("preparer"))])
async def delete_item(
    schedule_type: str,
    item_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    Model = _model_for(schedule_type)
    row = (await db.execute(
        select(Model).where(Model.tenant_id == tenant_id, Model.id == item_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{schedule_type} item not found.")
    await db.delete(row)
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
        "committed_at":    existing.committed_at.isoformat() if existing and existing.committed_at else None,
    }


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
    Model = _model_for(schedule_type)
    qbo_account_id = (body.get("qbo_account_id") or "").strip()
    if not qbo_account_id:
        raise HTTPException(status_code=400, detail="qbo_account_id is required.")
    pe = _parse_date(body.get("period_end"), "period_end")
    if pe is None:
        raise HTTPException(status_code=400, detail="period_end is required (YYYY-MM-DD).")
    items = (await db.execute(
        select(Model).where(
            Model.tenant_id == tenant_id,
            Model.qbo_account_id == qbo_account_id,
        )
    )).scalars().all()
    roller = _ROLLERS[schedule_type]
    snap = roller([i for i in items if i.is_active], pe)
    snap_d = snap.as_dict()

    # Upsert the snapshot row
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
    existing.committed_by      = user.id
    existing.committed_at      = _datetime.utcnow()
    if body.get("notes"):
        existing.notes = body.get("notes")

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
        total_days = calc._days_inclusive(it.start_date, it.end_date)
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
            "daily_rate":               str(_q_money(daily_rate)),
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
