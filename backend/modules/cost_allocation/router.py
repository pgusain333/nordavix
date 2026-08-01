"""Nordavix Allocate — HTTP surface for the monthly §471(c) run.

    POST /api/allocation/runs             compute (or recompute) a period
    GET  /api/allocation/runs             list runs, newest period first
    GET  /api/allocation/runs/{id}        one run + its per-account detail
    POST /api/allocation/runs/{id}/approve   maker-checker sign-off
    GET  /api/allocation/runs/{id}/journal-entry       the reclass JE (preview)
    GET  /api/allocation/runs/{id}/journal-entry.csv   QBO JE import CSV
    GET  /api/allocation/runs/{id}/workpaper.csv       per-account detail

Every handler is tenant-scoped by the standard dependencies; TenantBase filters
SELECTs automatically and writes carry tenant_id explicitly.

Maker-checker mirrors the close app: a preparer can compute a run, but approving
one requires `reviewer`, and nobody can approve a run they prepared themselves.
"""
import csv
import io
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, require_role
from core.db.session import get_db
from models.cost_allocation import AllocRun, AllocRunLine
from models.proposed_entry import ProposedEntry
from models.user import User
from modules.adjustments.service import build_qbo_je_csv
from modules.cost_allocation.service import run_allocation, serialize_run

router = APIRouter()


class RunRequest(BaseModel):
    period_start: date
    period_end: date
    # Optional roll-forward inputs. Supplied together they produce COGS on the
    # run; omitted, the allocation still computes and COGS is filled in later.
    beginning_inventory: float | None = Field(default=None)
    ending_inventory: float | None = Field(default=None)
    purchases: float | None = Field(default=None)


def _dec(v: float | None):
    from decimal import Decimal
    return Decimal(str(v)) if v is not None else None


@router.post("/runs", status_code=status.HTTP_201_CREATED)
async def create_run(
    body: RunRequest,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Compute the allocation for a period, superseding any live run for it.

    Returns 201 with the run either way: a run that couldn't be computed comes
    back as a draft carrying `blocked_reason`, because "this client has no square
    footage on file" is a task for the practice, not an error to swallow.
    """
    if body.period_end < body.period_start:
        raise HTTPException(status_code=422, detail="period_end must be on or after period_start.")

    run = await run_allocation(
        db,
        tenant_id=tenant_id,
        period_start=body.period_start,
        period_end=body.period_end,
        user_id=user.id,
        beginning_inventory=_dec(body.beginning_inventory),
        ending_inventory=_dec(body.ending_inventory),
        purchases=_dec(body.purchases),
    )
    await db.commit()
    await db.refresh(run)
    return serialize_run(run)


@router.get("/runs")
async def list_runs(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Runs for this client, newest period first. Superseded ones included so
    the history of what was issued stays visible."""
    runs = (await db.execute(
        select(AllocRun).order_by(AllocRun.period_end.desc(), AllocRun.created_at.desc())
    )).scalars().all()
    return [serialize_run(r) for r in runs]


@router.get("/runs/{run_id}")
async def get_run(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One run plus its per-account allocation detail — the workpaper body."""
    run = (await db.execute(select(AllocRun).where(AllocRun.id == run_id))).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Allocation run not found.")

    lines = (await db.execute(
        select(AllocRunLine)
        .where(AllocRunLine.run_id == run_id)
        .order_by(AllocRunLine.pool_name, AllocRunLine.account_number, AllocRunLine.qbo_account_id)
    )).scalars().all()
    return serialize_run(run, list(lines))


async def _load_run(db: AsyncSession, run_id: uuid.UUID) -> AllocRun:
    run = (await db.execute(select(AllocRun).where(AllocRun.id == run_id))).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Allocation run not found.")
    return run


async def _load_entry(db: AsyncSession, run: AllocRun) -> ProposedEntry | None:
    """The reclass entry this run produced, keyed on (source, source_ref)."""
    return (await db.execute(
        select(ProposedEntry).where(
            ProposedEntry.source == "allocation",
            ProposedEntry.source_ref == str(run.id),
        ).order_by(ProposedEntry.created_at.desc())
    )).scalars().first()


@router.get("/runs/{run_id}/journal-entry")
async def get_journal_entry(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The reclass journal entry for review before it's exported or posted.

    Returns `available: false` with a reason rather than 404 when there's
    nothing to post, so the UI can explain the gap instead of showing a broken
    panel. Also lists the mirror COGS accounts the CSV needs to exist in QBO.
    """
    run = await _load_run(db, run_id)
    entry = await _load_entry(db, run)
    if entry is None:
        return {
            "available": False,
            "reason": (
                run.blocked_reason
                or "Nothing capitalized this period, so there is no entry to post."
            ),
            "lines": [], "total_debits": "0.00", "total_credits": "0.00", "balanced": True,
            "cogs_accounts": [],
        }

    lines = entry.lines or []
    dr = sum((Decimal(str(ln.get("debit") or 0)) for ln in lines), Decimal("0.00"))
    cr = sum((Decimal(str(ln.get("credit") or 0)) for ln in lines), Decimal("0.00"))
    # The mirror COGS accounts have to exist in QuickBooks before the CSV will
    # import — QBO matches journal lines on account NAME and rejects the file
    # otherwise. Surfaced so they can be created first rather than discovered
    # by a failed import.
    cogs_accounts = sorted({
        str(ln.get("account_name") or "")
        for ln in lines
        if not ln.get("account_qbo_id") and str(ln.get("account_name") or "")
    })
    return {
        "available": True,
        "reason": None,
        "entry_id": str(entry.id),
        "status": entry.status,
        "description": entry.description,
        "memo": entry.memo,
        "rationale": entry.rationale,
        "period_end": entry.period_end.isoformat(),
        "lines": lines,
        "total_debits": f"{dr:.2f}",
        "total_credits": f"{cr:.2f}",
        "balanced": dr == cr,
        "cogs_accounts": cogs_accounts,
    }


@router.get("/runs/{run_id}/journal-entry.csv")
async def export_journal_entry_csv(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """The reclass entry as a QuickBooks Online 'Import journal entries' CSV.

    Uses the SAME builder as the Adjustments export, so the column layout is
    identical to the one already proven against QBO — one row per JE line,
    lines sharing a Journal No so QBO groups them into a single entry. Labelled
    471C-n rather than ADJ-n so a capitalization entry is recognisable in
    QuickBooks without opening it.
    """
    run = await _load_run(db, run_id)
    entry = await _load_entry(db, run)
    if entry is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This run produced no journal entry. Set the inventory account "
                "under Settings, then re-run the period."
            ),
        )

    csv_text = build_qbo_je_csv([entry], journal_no_prefix="471C")
    filename = f"471c-journal-entry-{run.period_end.isoformat()}.csv"
    return Response(
        # utf-8-sig — the BOM is what makes Excel read a QBO account name like
        # "Café supplies" correctly instead of as mojibake.
        content=csv_text.encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/runs/{run_id}/workpaper.csv")
async def export_workpaper_csv(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """The per-account allocation detail — the workpaper body, for review or
    attaching to the tax file. Header rows carry the drivers actually applied,
    so the file stands on its own away from the app."""
    run = await _load_run(db, run_id)
    lines = (await db.execute(
        select(AllocRunLine)
        .where(AllocRunLine.run_id == run_id)
        .order_by(AllocRunLine.pool_name, AllocRunLine.account_number, AllocRunLine.qbo_account_id)
    )).scalars().all()

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Section 471(c) cost allocation workpaper"])
    w.writerow(["Period", f"{run.period_start.isoformat()} to {run.period_end.isoformat()}"])
    w.writerow(["Status", run.status])
    w.writerow(["Payroll factor", run.payroll_factor or ""])
    w.writerow(["Occupancy factor", run.occupancy_factor or ""])
    w.writerow([])
    w.writerow([
        "Account no.", "Account", "Pool", "Treatment", "Driver", "Rate applied",
        "Gross", "Capitalized", "Disallowed",
    ])
    for ln in lines:
        w.writerow([
            ln.account_number or "", ln.account_name or ln.qbo_account_id,
            ln.pool_name, ln.treatment, ln.driver or "",
            f"{ln.driver_pct:.6f}" if ln.driver_pct is not None else "",
            f"{ln.gross_amount:.2f}", f"{ln.capitalized_amount:.2f}", f"{ln.disallowed_amount:.2f}",
        ])
    w.writerow([])
    w.writerow([
        "", "TOTAL", "", "", "", "",
        f"{run.total_expenses or 0:.2f}",
        f"{run.capitalized_total or 0:.2f}",
        f"{run.disallowed_total or 0:.2f}",
    ])

    filename = f"471c-workpaper-{run.period_end.isoformat()}.csv"
    return Response(
        content=buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/runs/{run_id}/posting-check")
async def posting_check(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Confirm the reclass entry actually reached the client's books.

    This is what makes the §471(c) position real rather than merely computed:
    the method is defined by what the books do, so an entry that was exported
    and never posted leaves the ledger contradicting the return.
    """
    from modules.cost_allocation.conformity import check_posting

    run = await _load_run(db, run_id)
    result = await check_posting(db, run)

    if result.get("posted"):
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="allocation.posting_confirmed", entity_type="alloc_run", entity_id=run.id,
            metadata={"summary": (
                f"Confirmed the §471(c) entry for {run.period_end.isoformat()} is posted "
                f"in QuickBooks ({result.get('doc_number')})"
            )},
        )
    await db.commit()
    await db.refresh(run)
    return {
        **result,
        "posted_at": run.posted_at.isoformat() if run.posted_at else None,
        "posted_doc_number": run.posted_doc_number,
        "posting_checked_at": run.posting_checked_at.isoformat() if run.posting_checked_at else None,
    }


@router.get("/accounting-procedures")
async def accounting_procedures(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The client's written accounting procedures, generated from live config.

    §471(c)(1)(B)(ii) conditions the method on the taxpayer's own accounting
    procedures, so the policy has to exist as a document — not merely as the
    configuration rows that happen to be in place.
    """
    from modules.cost_allocation.conformity import build_procedures_memo

    name = await _client_name(db, tenant_id)
    return await build_procedures_memo(db, client_name=name, as_of=date.today())


@router.get("/accounting-procedures.md")
async def accounting_procedures_download(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """The same memo as a file for the permanent audit file."""
    from modules.cost_allocation.conformity import build_procedures_memo

    name = await _client_name(db, tenant_id)
    memo = await build_procedures_memo(db, client_name=name, as_of=date.today())
    slug = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-") or "client"
    filename = f"471c-accounting-procedures-{slug}-{date.today().isoformat()}.md"
    return Response(
        content=memo["markdown"].encode("utf-8-sig"),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _client_name(db: AsyncSession, tenant_id: uuid.UUID) -> str:
    """The company this memo is for. Falls back rather than failing — a missing
    name shouldn't stop the document being produced."""
    from models.tenant import Tenant

    row = (await db.execute(
        select(Tenant.name).where(Tenant.id == tenant_id)
        .execution_options(skip_tenant_filter=True)
    )).scalars().first()
    return row or "the taxpayer"


# ── Year end ──────────────────────────────────────────────────────────────────

@router.get("/annual/years")
async def annual_years(
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Tax years this client has runs in, newest first."""
    from models.cost_allocation import AllocSettings
    from modules.cost_allocation.annual import available_tax_years

    cfg = (await db.execute(select(AllocSettings))).scalars().first()
    fye = cfg.fiscal_year_end if cfg else None
    period_ends = list((await db.execute(select(AllocRun.period_end))).scalars().all())
    return {
        "fiscal_year_end": fye,
        "years": available_tax_years(period_ends, date.today(), fye),
    }


@router.get("/annual")
async def annual_rollup(
    tenant_id: CurrentTenantId,
    tax_year: int,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The year rolled up, with the checklist of what it's made of.

    Reports before it totals: missing months, unapproved months, months never
    confirmed posted, and breaks in the inventory chain. An annual figure that
    can't say what it contains isn't a figure anyone should sign.
    """
    from modules.cost_allocation.annual import build_annual

    if not 2000 <= tax_year <= 2100:
        raise HTTPException(status_code=422, detail="tax_year is out of range.")
    return await build_annual(db, tenant_id=tenant_id, tax_year=tax_year)


@router.get("/annual/workpaper.csv")
async def annual_workpaper_csv(
    tenant_id: CurrentTenantId,
    tax_year: int,
    user: User = Depends(require_role("preparer")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """The year-end workpaper: the checklist, the monthly roll, the account
    detail and the Form 1125-A lines, in one file for the tax return file.

    The exceptions are printed even when there are none, so a reviewer can see
    the control ran rather than infer it from silence.
    """
    from modules.cost_allocation.annual import build_annual

    if not 2000 <= tax_year <= 2100:
        raise HTTPException(status_code=422, detail="tax_year is out of range.")
    data = await build_annual(db, tenant_id=tenant_id, tax_year=tax_year)
    name = await _client_name(db, tenant_id)
    check = data["checklist"]

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Section 471(c) annual cost allocation workpaper"])
    w.writerow(["Client", name])
    w.writerow(["Tax year", tax_year])
    w.writerow(["Period", f"{data['year_start']} to {data['year_end']}"])
    w.writerow(["Prepared", datetime.now(UTC).date().isoformat()])
    w.writerow([])

    w.writerow(["Completeness"])
    w.writerow(["Complete", "Yes" if data["complete"] else "No"])
    w.writerow(["Months expected", check["months_expected"]])
    w.writerow(["Months present", check["months_present"]])
    w.writerow(["Missing months", ", ".join(check["missing_periods"]) or "None"])
    w.writerow(["Not approved", ", ".join(check["unapproved_periods"]) or "None"])
    w.writerow(["Not confirmed posted", ", ".join(check["unposted_periods"]) or "None"])
    w.writerow([
        "Inventory chain breaks",
        ", ".join(
            f"{b['period_end']} opens at {b['beginning']} vs {b['prior_ending']} closing "
            f"{b['prior_period_end']}"
            for b in check["inventory_breaks"]
        ) or "None",
    ])
    w.writerow(["Months without inventory", ", ".join(check["periods_missing_inventory"]) or "None"])
    w.writerow([
        "Section 448(c) test concluded",
        "Yes" if check["eligibility_concluded"] else "No",
    ])
    w.writerow([])

    w.writerow(["Monthly roll"])
    w.writerow([
        "Period end", "Status", "Posted", "Total expenses", "Capitalized", "Disallowed",
        "Beginning inventory", "Purchases", "Ending inventory",
    ])
    for m in data["months"]:
        w.writerow([
            m["period_end"], m["status"], "Yes" if m["posted"] else "No",
            m["total_expenses"] or "", m["capitalized"] or "", m["disallowed"] or "",
            m["beginning_inventory"] or "", m["purchases"] or "", m["ending_inventory"] or "",
        ])
    t = data["totals"]
    w.writerow(["TOTAL", "", "", t["total_expenses"], t["capitalized"], t["disallowed"]])
    w.writerow([])

    w.writerow(["Capitalized by pool"])
    w.writerow(["Pool", "Capitalized", "Form 1125-A line"])
    for p in data["by_pool"]:
        w.writerow([
            p["pool_name"], p["capitalized"],
            "3 - cost of labor" if p["form_1125a_line"] == "labor" else "5 - other costs",
        ])
    w.writerow([])

    w.writerow(["Account detail"])
    w.writerow(["Account no.", "Account", "Pool", "Treatment", "Gross", "Capitalized", "Disallowed"])
    for a in data["by_account"]:
        w.writerow([
            a["account_number"] or "", a["account_name"] or a["qbo_account_id"],
            a["pool_name"], a["treatment"], a["gross"], a["capitalized"], a["disallowed"],
        ])
    w.writerow([])

    rf = data["roll_forward"]
    w.writerow(["Inventory roll-forward"])
    if rf:
        w.writerow(["Beginning inventory", rf["beginning_inventory"]])
        w.writerow(["Capitalized cost", rf["capitalized"]])
        w.writerow(["Purchases", rf["purchases"]])
        w.writerow(["Ending inventory", rf["ending_inventory"]])
        w.writerow(["Cost of goods sold", rf["cogs"]])
    else:
        w.writerow(["Not available - beginning or ending inventory was not captured"])
    w.writerow([])

    f = data["form_1125a"]
    w.writerow(["Form 1125-A"])
    w.writerow(["Line 1", "Inventory at beginning of year", f["line_1_beginning_inventory"]])
    w.writerow(["Line 2", "Purchases", f["line_2_purchases"]])
    w.writerow(["Line 3", "Cost of labor", f["line_3_cost_of_labor"]])
    w.writerow(["Line 5", "Other costs", f["line_5_other_costs"]])
    w.writerow(["Line 6", "Total", f["line_6_total"]])
    w.writerow(["Line 7", "Inventory at end of year", f["line_7_ending_inventory"]])
    w.writerow(["Line 8", "Cost of goods sold", f["line_8_cogs"]])
    w.writerow([])
    w.writerow([
        "Note",
        "Line 4 (additional Section 263A costs) is not presented: Section 280E denies "
        "Section 263A to this taxpayer, which is why Section 471(c) is used.",
    ])
    if not data["complete"]:
        w.writerow([
            "Note",
            "These figures are built on an incomplete year. See Completeness above.",
        ])

    filename = f"471c-annual-workpaper-{tax_year}.csv"
    return Response(
        content=buf.getvalue().encode("utf-8-sig"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/runs/{run_id}/approve")
async def approve_run(
    run_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: User = Depends(require_role("reviewer")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Sign off a run. Reviewer+ only, and never your own work."""
    run = (await db.execute(select(AllocRun).where(AllocRun.id == run_id))).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Allocation run not found.")
    if run.status == "superseded":
        raise HTTPException(status_code=409, detail="This run has been superseded by a newer one.")
    if run.blocked_reason:
        raise HTTPException(
            status_code=409,
            detail=f"This run is blocked and can't be approved: {run.blocked_reason}",
        )
    if run.status == "approved":
        return serialize_run(run)
    # Maker-checker: the preparer can't be the approver.
    if run.prepared_by is not None and run.prepared_by == user.id:
        raise HTTPException(
            status_code=403,
            detail="An allocation must be approved by someone other than the person who prepared it.",
        )

    run.status = "approved"
    run.approved_by = user.id
    run.approved_at = datetime.now(UTC)

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="allocation.run_approved", entity_type="alloc_run", entity_id=run.id,
        metadata={"summary": (
            f"Approved §471(c) allocation for {run.period_end.isoformat()} "
            f"({run.capitalized_total} capitalized)"
        )},
    )
    await db.commit()
    await db.refresh(run)
    return serialize_run(run)
