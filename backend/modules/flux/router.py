"""
Flux Analysis API — full implementation.

Endpoints:
  GET  /trial-balances                      list all TBs for tenant
  POST /trial-balances                      create a new TB record
  GET  /trial-balances/{id}                 get one TB
  POST /trial-balances/{id}/upload          upload Excel/CSV, return column preview
  POST /trial-balances/{id}/parse           confirm mapping, create accounts + variances
  POST /trial-balances/{id}/run             enqueue AI narrative generation
  GET  /trial-balances/{id}/variances       list variances with account + narrative data
  POST /trial-balances/{id}/variances/{v}   /approve — mark approved
  POST /trial-balances/{id}/variances/{v}   /status   — flip review status
  PUT  /trial-balances/{id}/variances/{v}   /narrative — manual edit
  GET  /trial-balances/{id}/export          Excel download
"""
import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.ai.guard import enforce_ai_limits
from core.audit.log import write_audit_event
from core.auth.dependencies import ROLE_ORDER, CurrentTenantId, CurrentUser, require_role
from core.config import settings
from core.db.session import assert_tenant_owns, get_db
from models.account import Account
from models.closed_period import ClosedPeriod
from models.narrative import Narrative
from models.qbo_connection import QboConnection
from models.trial_balance import TrialBalance
from models.user import User
from models.variance import Variance
from models.variance_transaction import VarianceTransaction
from modules.flux.schemas import (
    ColumnMappingBody,
    ComparisonModeBody,
    FluxRunResponse,
    NarrativeUpdate,
    ParseResult,
    SaveExpectationBody,
    TrialBalanceCreate,
    TrialBalanceResponse,
    UploadPreview,
    VarianceResponse,
    VarianceStatusUpdate,
)
from modules.flux.service import (
    _account_key,
    create_accounts_and_variances,
    parse_accounts_from_file,
    parse_file_to_preview,
    parse_qbo_pl_amounts,
    parse_qbo_trial_balance_report,
)
from modules.flux.tasks import (  # noqa: F401  (kept for celery)
    generate_narrative_async,
    generate_narrative_task,
)
from modules.flux.variance_txns import pull_transactions_for_variance
from modules.memory.service import (
    build_expectation_value,
    expectation_title,
    record_expectation_signal,
    serialize_fact,
    upsert_expectation_fact,
)
from modules.qbo.router import _get_valid_token  # type: ignore  # reuse existing helper

router = APIRouter()

# Module-level logger — referenced by /agentic/run, /agentic/cancel,
# /status, etc. WAS missing entirely until this commit, which means
# every code path that touched `logger.info(...)` raised
# NameError: name 'logger' is not defined and FastAPI returned a 500.
# The frontend's silent .catch on bulk operations masked the failure,
# making clicks look like no-ops. Defining it here brings those
# endpoints back to life — Fly logs will now show real progress.
logger = logging.getLogger(__name__)


# ── Trial Balances ──────────────────────────────────────────────────────────────

@router.get("/trial-balances", response_model=list[TrialBalanceResponse])
async def list_trial_balances(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> list[TrialBalance]:
    """List all trial balances for the current tenant, newest first."""
    result = await db.execute(
        select(TrialBalance).order_by(TrialBalance.created_at.desc())
    )
    return list(result.scalars().all())


async def _require_tb_open(tb_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> None:
    """Dependency: block writes to a trial balance whose period is closed (423).
    The period is TrialBalance.period_current; an admin must reopen first. A
    missing TB / missing period falls through to the endpoint's own 404 handling.
    Keeps flux's backend in lockstep with the dashboard's closed-period lockdown."""
    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.id == tb_id)
    )).scalar_one_or_none()
    if tb is None or tb.period_current is None:
        return
    cp = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == tb.period_current)
    )).scalar_one_or_none()
    if cp is not None:
        raise HTTPException(
            status_code=423,
            detail=(
                f"Books are closed for period {tb.period_current}. "
                "An admin must reopen the period before edits are allowed."
            ),
        )


@router.post(
    "/trial-balances",
    response_model=TrialBalanceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_trial_balance(
    body: TrialBalanceCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TrialBalance:
    """Create a new trial balance record (before file upload)."""
    tb = TrialBalance(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=body.name,
        period_current=body.period_current,
        period_prior=body.period_prior,
        materiality_threshold=body.materiality_threshold,
        created_by=user.id,
        status="pending",
    )
    db.add(tb)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.analysis_created", entity_type="trial_balance", entity_id=tb.id,
        metadata={"summary": f"Created flux analysis '{body.name}' ({body.period_current} vs {body.period_prior})"},
    )
    await db.commit()
    await db.refresh(tb)
    return tb


@router.post(
    "/trial-balances/from-qbo",
    response_model=TrialBalanceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_trial_balance_from_qbo(
    body: TrialBalanceCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> TrialBalance:
    """
    Create a flux analysis directly from a connected QuickBooks Online account
    — no manual upload. Pulls the TrialBalance report for both periods,
    computes variances, and queues AI commentary for material lines.

    Periods are interpreted as the LAST day of each comparison period. We pull
    two TrialBalance reports (one per period) and merge them by account.
    """

    import httpx

    # 1) Validate QBO connection
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(
            status_code=409,
            detail="QuickBooks isn't connected. Connect it from the Connections page first.",
        )

    # 2) Insert the TB stub up front so the user can see progress
    tb = TrialBalance(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=body.name,
        period_current=body.period_current,
        period_prior=body.period_prior,
        materiality_threshold=body.materiality_threshold,
        created_by=user.id,
        status="processing",
    )
    db.add(tb)
    await db.commit()
    await db.refresh(tb)

    # 3) Pull both TrialBalance reports from QBO via the canonical helper
    # in core.qbo_tb. Reconciliations uses the same helper — that way the
    # two modules can never drift on how QBO is queried, which used to
    # cause the same account to show different balances in Flux vs Recons.
    from core.qbo_tb import fetch_trial_balance
    try:
        report_current = await fetch_trial_balance(
            conn, body.period_current, period_start=body.period_start_current,
        )
        report_prior = await fetch_trial_balance(
            conn, body.period_prior, period_start=body.period_start_prior,
        )
    except Exception as exc:
        tb.status = "error"
        tb.error_detail = str(exc)[:1000]
        await db.commit()
        # Full detail stays in the log + error_detail column; the client gets a
        # generic message so upstream QBO errors can't leak internals (URLs,
        # request ids, token fragments) into the browser.
        logger.exception("QBO trial-balance fetch failed for tb %s", tb.id)
        raise HTTPException(
            status_code=502,
            detail="QuickBooks did not return the trial balance. Try again, or reconnect QuickBooks if this persists.",
        )

    # 3b) Pull the Account list so we can use the proper AcctNum from QBO
    # instead of relying on whatever the TrialBalance report shows as the row
    # label (which is often just the account name, no number).
    # IMPORTANT: pass `query` via httpx `params=` so it's URL-encoded properly
    # — the previous f-string approach turned spaces into URL breaks and the
    # whole query silently returned 0 results.
    qbo_acct_lookup: dict[str, dict] = {}
    try:
        from core.qbo_http import request_with_retry
        token = await _get_valid_token(conn, db)
        url = f"{settings.qbo_base_url}/v3/company/{conn.realm_id}/query"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        params = {
            "query": "SELECT Id, Name, AcctNum, AccountType FROM Account WHERE Active = true MAXRESULTS 1000",
            "minorversion": "65",
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await request_with_retry(
                lambda: client.get(url, headers=headers, params=params),
                label="QBO Account query (flux)",
            )
        if resp.status_code == 200:
            for a in resp.json().get("QueryResponse", {}).get("Account", []) or []:
                qbo_acct_lookup[str(a.get("Id"))] = a
    except Exception:
        # Best-effort: parser falls back to text-prefix parsing if lookup is empty
        qbo_acct_lookup = {}

    # 3c) Pull the ProfitAndLoss report for each period so income-statement
    # accounts show TRUE PERIOD activity (May, not Jan→May), instead of the
    # TrialBalance's fiscal-YTD figure. The parser overrides P&L-type rows with
    # these; balance-sheet accounts keep the TB point-in-time balance. Best-effort:
    # on any failure (or when a period start wasn't supplied) we fall back to the
    # TB figures — P&L then reads YTD, as before — rather than failing the run.
    pl_current: dict | None = None
    pl_prior: dict | None = None
    if body.period_start_current and body.period_start_prior:
        try:
            from core.qbo_tb import fetch_profit_and_loss
            pl_report_current = await fetch_profit_and_loss(
                conn, body.period_current, period_start=body.period_start_current,
            )
            pl_report_prior = await fetch_profit_and_loss(
                conn, body.period_prior, period_start=body.period_start_prior,
            )
            pl_current = parse_qbo_pl_amounts(pl_report_current)
            pl_prior = parse_qbo_pl_amounts(pl_report_prior)
        except Exception:
            logger.warning(
                "flux: ProfitAndLoss period-activity pull failed for tb %s — "
                "income-statement accounts will show TrialBalance year-to-date instead.",
                tb.id, exc_info=True,
            )
            pl_current = pl_prior = None

    # 4) Parse into account dicts and persist accounts + variances
    try:
        account_dicts = parse_qbo_trial_balance_report(
            report_current, report_prior, tb.fs_line_mapping or {},
            qbo_acct_lookup=qbo_acct_lookup,
            pl_current=pl_current, pl_prior=pl_prior,
        )
    except Exception as exc:
        tb.status = "error"
        tb.error_detail = f"QBO report parse failed: {exc}"
        await db.commit()
        raise HTTPException(status_code=502, detail=tb.error_detail)

    if not account_dicts:
        tb.status = "error"
        tb.error_detail = "QBO TrialBalance returned no account rows for these periods."
        await db.commit()
        raise HTTPException(status_code=422, detail=tb.error_detail)

    _, _, _material = await create_accounts_and_variances(db, tb, tenant_id, account_dicts)
    # AI is on-demand only — the user clicks "Find reasons" or "Regenerate"
    # from the variance table to fire commentary. No auto-spend at creation.
    # Status goes straight to ready_for_review so the user can browse rows.
    tb.status = "ready_for_review"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.analysis_created", entity_type="trial_balance", entity_id=tb.id,
        metadata={"summary": f"Created flux analysis '{tb.name}' from QuickBooks ({tb.period_current} vs {tb.period_prior})"},
    )
    await db.commit()
    await db.refresh(tb)
    return tb


@router.get("/trial-balances/{tb_id}", response_model=TrialBalanceResponse)
async def get_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> TrialBalance:
    """Get a single trial balance."""
    result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trial balance not found")
    return tb


@router.post("/trial-balances/{tb_id}/comparison-mode", response_model=TrialBalanceResponse,
             dependencies=[Depends(_require_tb_open)])
async def set_comparison_mode(
    tb_id: uuid.UUID,
    body: ComparisonModeBody,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> TrialBalance:
    """Flip a flux analysis between the actual-vs-prior and actual-vs-expected
    lens. Persisted on the analysis so the choice sticks for everyone viewing it.
    Pure view preference — no role gate beyond workspace membership."""
    if body.mode not in ("prior", "expected"):
        raise HTTPException(status_code=400, detail="mode must be 'prior' or 'expected'")
    result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trial balance not found")
    tb.comparison_mode = body.mode
    await db.commit()
    await db.refresh(tb)
    return tb


# ── Upload & Parse ──────────────────────────────────────────────────────────────

@router.post("/trial-balances/{tb_id}/upload", response_model=UploadPreview,
             dependencies=[Depends(_require_tb_open)])
async def upload_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> UploadPreview:
    """
    Upload an Excel or CSV trial balance file.
    Parses headers and returns a column mapping preview for the user to confirm.
    The file content is stored in the TB's column_mapping for re-processing.
    """
    result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    allowed_exts = {"xlsx", "xls", "csv"}
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in allowed_exts:
        raise HTTPException(status_code=400, detail="File must be .xlsx, .xls or .csv")

    file_bytes = await file.read()
    if len(file_bytes) > 10 * 1024 * 1024:  # 10 MB limit
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")

    try:
        headers, sample_rows, detected = parse_file_to_preview(file_bytes, file.filename or "file.xlsx")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not parse file: {str(e)}")

    # Store raw file bytes in column_mapping temporarily (base64) for re-use in /parse
    import base64
    # Keep only the basename of the client-supplied filename — strip any path
    # separators so a crafted name can never read as a path downstream.
    safe_name = (file.filename or "file.xlsx").replace("\\", "/").rsplit("/", 1)[-1] or "file.xlsx"
    tb.column_mapping = {
        "_file_b64": base64.b64encode(file_bytes).decode("ascii"),
        "_filename": safe_name,
    }
    tb.status = "pending"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.tb_file_uploaded", entity_type="trial_balance", entity_id=tb.id,
        metadata={"summary": f"Uploaded trial balance file '{safe_name}' to '{tb.name}'"},
    )
    await db.commit()

    return UploadPreview(
        headers=headers,
        sample_rows=sample_rows,
        detected_mapping=detected,
    )


@router.post("/trial-balances/{tb_id}/parse", response_model=ParseResult,
             dependencies=[Depends(_require_tb_open)])
async def parse_trial_balance(
    tb_id: uuid.UUID,
    body: ColumnMappingBody,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> ParseResult:
    """
    Confirm column mapping and parse the trial balance.
    Creates Account and Variance rows, enqueues AI narrative tasks.
    """
    result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    if tb.status not in ("pending", "error"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot parse TB with status '{tb.status}'"
        )

    # Retrieve stored file
    import base64
    file_b64 = tb.column_mapping.get("_file_b64")
    filename  = tb.column_mapping.get("_filename", "file.xlsx")
    if not file_b64:
        raise HTTPException(status_code=400, detail="No file uploaded. Please upload a file first.")

    file_bytes = base64.b64decode(file_b64)

    # Required: account number + name + EITHER a current_balance column OR a
    # (current_debit, current_credit) pair. Prior is treated as zero if missing.
    if not body.mapping.get("account_number") or not body.mapping.get("account_name"):
        raise HTTPException(
            status_code=400,
            detail="Missing column mappings: account_number and account_name are required.",
        )
    has_balance_curr = bool(body.mapping.get("current_balance"))
    has_dc_curr = bool(body.mapping.get("current_debit")) and bool(body.mapping.get("current_credit"))
    if not (has_balance_curr or has_dc_curr):
        raise HTTPException(
            status_code=400,
            detail="Need either a current-period balance column OR a (debit, credit) pair.",
        )

    tb.status = "processing"
    tb.column_mapping = {
        **tb.column_mapping,
        **body.mapping,
    }
    await db.commit()

    try:
        account_dicts = parse_accounts_from_file(
            file_bytes,
            filename,
            body.mapping,
            tb.fs_line_mapping or {},
        )
    except Exception as e:
        tb.status = "error"
        tb.error_detail = str(e)[:1000]
        await db.commit()
        raise HTTPException(status_code=422, detail=f"Parse error: {str(e)}")

    if not account_dicts:
        tb.status = "error"
        tb.error_detail = "No account rows found. Check column mapping and file content."
        await db.commit()
        raise HTTPException(status_code=422, detail=tb.error_detail)

    # Persist accounts + variances
    accts, vars_, material = await create_accounts_and_variances(
        db, tb, tenant_id, account_dicts
    )

    # AI commentary is on-demand only — user clicks "Find reasons" or per-row
    # "Generate AI commentary" from the variance table. No auto-spend.
    tb.status = "ready_for_review"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.tb_parsed", entity_type="trial_balance", entity_id=tb.id,
        metadata={"summary": f"Parsed trial balance for '{tb.name}' — {accts} accounts, {vars_} variances ({material} material)"},
    )
    await db.commit()

    return ParseResult(
        accounts_created=accts,
        variances_created=vars_,
        material_count=material,
    )


# ── Run ─────────────────────────────────────────────────────────────────────────

@router.post("/trial-balances/{tb_id}/run", response_model=FluxRunResponse,
             dependencies=[Depends(enforce_ai_limits), Depends(_require_tb_open)])
async def run_flux(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> FluxRunResponse:
    """
    Run AI narrative generation for every material variance that doesn't yet
    have one (status pending or flagged). Also used right after /parse.
    """
    result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    if tb.status not in ("parsed", "error", "ready_for_review", "complete", "generating"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot run flux on TB with status '{tb.status}'"
        )

    # Pick up anything that's material and not already done by the AI.
    # We include "flagged" so a previous transient failure can be retried.
    var_result = await db.execute(
        select(Variance).join(Account, Variance.account_id == Account.id)
        .where(
            Account.trial_balance_id == tb_id,
            Variance.is_material == True,
            Variance.status.in_(("pending", "flagged")),
        )
    )
    pending = list(var_result.scalars().all())

    queued = 0
    for var in pending:
        background_tasks.add_task(generate_narrative_async, str(var.id), str(tenant_id))
        queued += 1

    if queued > 0:
        tb.status = "generating"
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="flux.analysis_run", entity_type="trial_balance", entity_id=tb.id,
            metadata={"summary": f"Queued AI commentary for {queued} material variance{'s' if queued != 1 else ''} on '{tb.name}'"},
        )
        await db.commit()

    task_id = f"batch-{tb_id}"
    return FluxRunResponse(
        trial_balance_id=tb_id,
        task_id=task_id,
        status="queued" if queued > 0 else "no_pending",
        message=(
            f"Queued AI analysis for {queued} variance{'s' if queued != 1 else ''}."
            if queued > 0
            else "All material variances already have AI commentary."
        ),
    )


# ── Variances ───────────────────────────────────────────────────────────────────

@router.get("/trial-balances/{tb_id}/variances", response_model=list[VarianceResponse])
async def list_variances(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> list[VarianceResponse]:
    """
    List all variances for a trial balance, joined with account + narrative data.
    Sorted by: material first, then by dollar variance descending.
    """
    # Confirm TB exists
    tb_result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    if tb_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    # Join Variance → Account → Narrative (left outer)
    stmt = (
        select(Variance, Account, Narrative)
        .join(Account, Variance.account_id == Account.id)
        .outerjoin(Narrative, Narrative.variance_id == Variance.id)
        .where(Account.trial_balance_id == tb_id)
        .order_by(
            Variance.is_material.desc(),
            Variance.dollar_variance.desc(),
        )
    )
    rows = (await db.execute(stmt)).all()

    responses: list[VarianceResponse] = []
    for var, acct, narr in rows:
        responses.append(
            VarianceResponse(
                id=var.id,
                account_id=var.account_id,
                qbo_account_id=acct.qbo_account_id,
                account_number=acct.account_number,
                account_name=acct.account_name,
                current_balance=acct.current_balance,
                prior_balance=acct.prior_balance,
                dollar_variance=var.dollar_variance,
                pct_variance=var.pct_variance,
                is_material=var.is_material,
                anomaly_flags=var.anomaly_flags or [],
                status=var.status,
                expected_value=var.expected_value,
                expected_basis=var.expected_basis,
                dollar_variance_expected=var.dollar_variance_expected,
                pct_variance_expected=var.pct_variance_expected,
                pre_explained=var.pre_explained,
                fs_category=acct.fs_category,
                narrative=narr.content if narr else None,
                confidence_score=narr.confidence_score if narr else None,
                approved_by=var.approved_by,
                approved_at=var.approved_at,
                ai_commentary=var.ai_commentary,
            )
        )

    # After listing — check if all material variances are now done → mark complete
    await _maybe_mark_complete(tb_id, responses, db)

    return responses


async def _maybe_mark_complete(
    tb_id: uuid.UUID,
    variances: list[VarianceResponse],
    db: AsyncSession,
) -> None:
    """If all material variances are approved or generated, mark TB as complete."""
    try:
        material = [v for v in variances if v.is_material]
        if not material:
            return
        all_done = all(
            v.status in ("approved", "edited", "generated")
            for v in material
        )
        if all_done:
            tb_result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
            tb = tb_result.scalar_one_or_none()
            if tb and tb.status not in ("complete", "error"):
                tb.status = "ready_for_review"
                await db.commit()
    except Exception:
        pass


@router.post(
    "/trial-balances/{tb_id}/variances/{var_id}/approve",
    dependencies=[Depends(require_role("reviewer")), Depends(_require_tb_open)],
)
async def approve_variance(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Mark a variance as approved + stamp who approved it and when.

    Reviewer or admin only — preparers can flag/prepare but the sign-off
    has to come from a separate role to keep the maker/checker pattern
    intact. 403 if a preparer hits this endpoint directly.
    """
    var_result = await db.execute(select(Variance).where(Variance.id == var_id))
    var = var_result.scalar_one_or_none()
    if var is None:
        raise HTTPException(status_code=404, detail="Variance not found")

    # Maker/checker: the user who created (ran) this flux analysis can't also
    # sign off its variance lines — self-approval defeats the control. Admins
    # bypass (master access / solo firms), mirroring the recon subledger rule.
    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.id == tb_id)
    )).scalar_one_or_none()
    if tb is not None and user.role != "admin" and tb.created_by == user.id:
        raise HTTPException(
            status_code=403,
            detail=(
                "You created this flux analysis — variance sign-off must come "
                "from a different user (maker/checker control). Admins can bypass."
            ),
        )

    var.status = "approved"
    var.approved_by = user.id
    var.approved_at = datetime.now(UTC)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.variance_approved",
        entity_type="variance", entity_id=var_id,
        metadata={"summary": "Approved variance line", "trial_balance_id": str(tb_id)},
    )
    await db.commit()
    return {
        "id": str(var_id),
        "status": "approved",
        "approved_by": str(user.id),
        "approved_at": var.approved_at.isoformat(),
    }


@router.post("/trial-balances/{tb_id}/variances/{var_id}/save-expectation",
             dependencies=[Depends(_require_tb_open)])
async def save_variance_expectation(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    body: SaveExpectationBody,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Capture this variance's explanation as a recurring expectation for the
    account (Client Memory). Creates a SUGGESTED fact only — confirm-first: a
    reviewer must confirm it in Settings → Memory before it ever applies. Any
    member may suggest (preparers explain; reviewers confirm)."""
    if body.recurrence not in ("monthly", "quarterly", "annual", "one_off"):
        raise HTTPException(
            status_code=400,
            detail="recurrence must be 'monthly', 'quarterly', 'annual', or 'one_off'.",
        )

    var = (await db.execute(select(Variance).where(Variance.id == var_id))).scalar_one_or_none()
    if var is None:
        raise HTTPException(status_code=404, detail="Variance not found")
    acct = (await db.execute(select(Account).where(Account.id == var.account_id))).scalar_one_or_none()
    if acct is None:
        raise HTTPException(status_code=404, detail="Account not found")
    tb = (await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))).scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    # The explanation is the heart of the rule — prefer the user's own words, then
    # fall back to the variance's AI commentary / written narrative. Require one so
    # we never store an empty, low-quality memory.
    explanation = (body.explanation or "").strip()
    if not explanation and isinstance(var.ai_commentary, dict):
        explanation = (var.ai_commentary.get("narrative") or var.ai_commentary.get("headline") or "").strip()
    if not explanation:
        narr = (await db.execute(
            select(Narrative).where(Narrative.variance_id == var_id)
        )).scalar_one_or_none()
        if narr and narr.content:
            explanation = narr.content.strip()
    if not explanation:
        raise HTTPException(
            status_code=400,
            detail="Add an explanation first (run AI or write commentary) — a recurring expectation needs a reason.",
        )

    account_key = _account_key(acct.qbo_account_id, acct.account_number)
    if not account_key:
        raise HTTPException(status_code=400, detail="This account has no stable identifier to learn from.")

    value = build_expectation_value(
        account_number=acct.account_number,
        account_name=acct.account_name,
        qbo_account_id=acct.qbo_account_id,
        default_balance=acct.current_balance,
        period_current=tb.period_current,
        recurrence=body.recurrence,
        explanation=explanation,
        expected_amount=body.expected_amount,
        tolerance_mode=body.tolerance_mode,
        tolerance_pct=body.tolerance_pct,
        tolerance_abs=body.tolerance_abs,
    )
    title = expectation_title(
        acct.account_name, body.recurrence, value["month"], value["expected_balance"], explanation,
    )

    await record_expectation_signal(
        db, tenant_id=tenant_id, account_key=account_key,
        period_end=tb.period_current, value=value, variance_id=var_id, created_by=user.id,
    )
    fact = await upsert_expectation_fact(
        db, tenant_id=tenant_id, account_key=account_key, value=value, title=title,
    )
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="memory.expectation_captured", entity_type="variance", entity_id=var_id,
        metadata={"summary": f"Captured recurring expectation — {title}",
                  "trial_balance_id": str(tb_id), "fact_id": str(fact.id)},
    )
    await db.commit()
    return serialize_fact(fact)


# Status values the /status endpoint accepts. We intentionally exclude
# "approved" from this list — Approve has its own endpoint that also
# stamps approved_by + approved_at and writes a distinct audit event.
# Likewise "generating" is set by the AI runner, not by humans.
_ALLOWED_STATUS_FLIPS = {"pending", "generated", "edited", "flagged"}


@router.post("/trial-balances/{tb_id}/variances/{var_id}/status",
             dependencies=[Depends(_require_tb_open)])
async def set_variance_status(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    body: VarianceStatusUpdate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Flip a variance's review status — backs the Mark prepared / Flag /
    Reset to pending buttons in the bulk-action toolbar.

    Returning a row to "pending" clears approved_by + approved_at so the
    audit trail stays honest (the variance is no longer signed off).
    Other flips leave the approval stamps alone.

    Logs every transition (with the previous and new status) at INFO so
    Fly/Sentry has a clear signal when a flip fails or hangs — the
    frontend's earlier silent-failure mode hid these from view.
    """
    if body.status not in _ALLOWED_STATUS_FLIPS:
        logger.warning(
            "set_variance_status: rejected unknown status=%r (tb=%s var=%s tenant=%s)",
            body.status, tb_id, var_id, tenant_id,
        )
        raise HTTPException(
            status_code=400,
            detail=f"status must be one of {sorted(_ALLOWED_STATUS_FLIPS)}",
        )

    # Role gate — mirrors the recon status endpoint: flagging is a reviewer
    # signal ("needs attention before sign-off"), so it stays reviewer/admin.
    # pending / generated / edited are the preparer's normal workflow.
    if body.status == "flagged" and ROLE_ORDER.get(user.role or "preparer", 0) < ROLE_ORDER["reviewer"]:
        raise HTTPException(
            status_code=403,
            detail=f"Only reviewers and admins can flag variances. Your role is {user.role or 'preparer'}.",
        )

    var_result = await db.execute(select(Variance).where(Variance.id == var_id))
    var = var_result.scalar_one_or_none()
    if var is None:
        # Most likely cause: the variance belongs to a different tenant
        # (the tenant filter listener silently drops it from the SELECT
        # result, so we see None rather than getting back a foreign row).
        logger.warning(
            "set_variance_status: variance not found (tb=%s var=%s tenant=%s) — "
            "possibly a tenant-scope miss",
            tb_id, var_id, tenant_id,
        )
        raise HTTPException(status_code=404, detail="Variance not found")

    previous = var.status
    var.status = body.status
    # Resetting back to pending = the variance is no longer signed off.
    # Wipe approval stamps so dashboards / exports don't show a stale
    # approver on a re-opened line.
    if body.status == "pending":
        var.approved_by = None
        var.approved_at = None

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"flux.variance_status_{body.status}",
        entity_type="variance", entity_id=var_id,
        metadata={
            "summary": f"Variance status: {previous} → {body.status}",
            "trial_balance_id": str(tb_id),
            "previous_status": previous,
        },
    )
    await db.commit()
    logger.info(
        "set_variance_status: %s → %s (tb=%s var=%s user=%s)",
        previous, body.status, tb_id, var_id, user.id,
    )
    return {
        "id":     str(var_id),
        "status": body.status,
    }


@router.post("/trial-balances/{tb_id}/agentic/run",
             dependencies=[Depends(enforce_ai_limits), Depends(_require_tb_open)])
async def run_agentic_flux_endpoint(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Auto-generate AI commentary for every material variance on the TB
    that doesn't already have one. Synchronous — caller blocks until
    every variance has been processed (or the user hits Stop). Typical
    TB with 20 material variances takes ~60-120s depending on the LLM.
    """
    from dataclasses import asdict

    from modules.flux.agentic import run_agentic_flux

    logger.info(
        "Agentic flux run start: tenant=%s user=%s tb=%s",
        tenant_id, user.id, tb_id,
    )
    try:
        result = await run_agentic_flux(db, tenant_id, user, tb_id)
        return asdict(result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Agentic flux failed at top level for tenant=%s tb=%s",
            tenant_id, tb_id,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Agentic flux failed: {type(exc).__name__}: {str(exc)[:200]}",
        ) from exc


@router.post("/trial-balances/{tb_id}/agentic/cancel")
async def cancel_agentic_flux_endpoint(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,  # noqa: ARG001
) -> dict:
    """
    Signal an in-flight agentic-flux run to stop. Cooperative — the
    worker finishes its current variance, commits cleanly, then exits
    with everything-so-far in the result.
    """
    from modules.flux.agentic import request_cancel

    request_cancel(tenant_id, tb_id)
    logger.info("Agentic flux cancel requested: tenant=%s tb=%s", tenant_id, tb_id)
    return {"cancelled": True, "tb_id": str(tb_id)}


@router.post("/trial-balances/{tb_id}/variances/{var_id}/agentic/run",
             dependencies=[Depends(enforce_ai_limits), Depends(_require_tb_open)])
async def run_deep_agentic_on_variance(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,  # noqa: ARG001 — used implicitly for tenant scoping
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Run the deeper Agentic analysis on ONE variance.

    Auto-pulls QBO transactions for the change window, asks Claude
    for a structured analysis (narrative + risk_level + justified +
    key_entities + recommendations), and persists the result on
    Variance.ai_commentary. Returns the structured commentary so the
    UI can render it immediately.

    Open to all workspace members (preparers can trigger AI; only
    approve actions are role-gated). Idempotent: clicking again
    re-pulls transactions + reruns the analysis (the cache key
    includes len(txns) so a re-pull breaks the cache).

    ~10-15s typical latency. The frontend shows a per-row spinner.
    """
    # Confirm the variance belongs to this TB (defensive check —
    # tenant filter already gates cross-tenant access).
    row = (await db.execute(
        select(Variance, Account).join(Account, Variance.account_id == Account.id)
        .where(Variance.id == var_id, Account.trial_balance_id == tb_id)
    )).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Variance not found in this analysis.")

    from modules.flux.deep_agentic import run_deep_agentic_for_variance
    try:
        commentary = await run_deep_agentic_for_variance(
            db=db, tenant_id=tenant_id, variance_id=var_id,
            force_refresh_txns=True,
        )
        _var, _acct = row
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="flux.variance_ai_run", entity_type="variance", entity_id=var_id,
            metadata={"summary": f"Ran deep AI analysis on variance for {_acct.account_number} {_acct.account_name}".strip()},
        )
        await db.commit()
    except Exception as e:
        logger.exception("Per-row deep agentic failed for variance %s", var_id)
        raise HTTPException(
            status_code=500,
            detail=f"Agentic run failed: {type(e).__name__}: {str(e)[:200]}",
        ) from e
    return {"variance_id": str(var_id), "ai_commentary": commentary}


@router.post(
    "/trial-balances/{tb_id}/approve",
    response_model=TrialBalanceResponse,
    dependencies=[Depends(require_role("reviewer")), Depends(_require_tb_open)],
)
async def approve_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TrialBalance:
    """
    Sign off on the entire flux analysis. Stamps approved_by + approved_at and
    moves status to 'complete'.

    Reviewer or admin only — preparers can prepare/edit/flag but the
    workspace-level sign-off (which gates the month-end close) has to
    come from a separate role.
    """
    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.id == tb_id)
    )).scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")
    # Maker/checker: whoever created (ran) this analysis can't sign it off — the
    # TB approval gates the month-end close. Admins bypass, mirroring recon.
    if user.role != "admin" and tb.created_by == user.id:
        raise HTTPException(
            status_code=403,
            detail=(
                "You created this flux analysis — sign-off must come from a "
                "different user (maker/checker control). Admins can bypass."
            ),
        )
    tb.approved_by = user.id
    tb.approved_at = datetime.now(UTC)
    tb.status = "complete"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.tb_approved",
        entity_type="trial_balance", entity_id=tb_id,
        metadata={"summary": f"Approved flux analysis '{tb.name}'"},
    )
    await db.commit()
    return tb


# ── Variance transactions (drill-in evidence) ───────────────────────────────

@router.get("/trial-balances/{tb_id}/variances/{var_id}/transactions")
async def list_variance_transactions(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
    refresh: bool = False,
) -> dict:
    """
    Return the stored evidence transactions for this variance.

    Pass ?refresh=true to re-pull from QBO (wipes prior rows). Pulls
    require the TB to have been sourced from QBO (we need the
    qbo_account_id to drill in); Excel-uploaded TBs return 409.

    Materiality is NOT a gate here — every variance, big or small,
    can pull its transactions. The Material concept was removed
    from the UI; this endpoint was the last place that still
    enforced it and was silently 409-ing the Pull button.
    """
    # Fetch variance + account in one query so we can validate + use both
    row = (await db.execute(
        select(Variance, Account).join(Account, Variance.account_id == Account.id)
        .where(Variance.id == var_id)
    )).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Variance not found")
    var, acct = row

    if refresh:
        if not acct.qbo_account_id:
            raise HTTPException(
                status_code=409,
                detail=(
                    "This analysis wasn't sourced from QuickBooks, so we can't "
                    "drill into per-account transactions. Re-run from QBO to enable."
                ),
            )
        tb = (await db.execute(
            select(TrialBalance).where(TrialBalance.id == tb_id)
        )).scalar_one_or_none()
        if tb is None:
            raise HTTPException(status_code=404, detail="Trial balance not found")

        # The variance is GL(period_current) - GL(period_prior), so the
        # transactions that *drove* the variance are everything posted between
        # period_prior_end + 1 day and period_current_end inclusive. Using
        # period_prior + 1 day catches all activity that contributed to the
        # change in balance — no matter the comparison length (month vs month,
        # quarter vs quarter, YTD vs YTD all work).
        # A forced txn refresh is an explicit QBO pull — approved variance
        # data is otherwise frozen in Nordavix (we serve the cached rows
        # without `refresh`). So a refresh on an approved variance re-opens
        # it for review.
        if var.status == "approved":
            var.status = "generated"
            var.approved_by = None
            var.approved_at = None

        from datetime import timedelta
        period_start = tb.period_prior + timedelta(days=1)
        try:
            await pull_transactions_for_variance(
                db, tenant_id, var_id, acct.qbo_account_id,
                period_start, tb.period_current,
            )
            await write_audit_event(
                db, tenant_id=tenant_id, user_id=None,
                action="flux.variance_transactions_pulled",
                entity_type="variance", entity_id=var_id,
                metadata={"summary": f"Pulled QBO transactions for variance on {acct.account_number} {acct.account_name}".strip()},
            )
            await db.commit()
        except RuntimeError:
            logger.exception("QBO transaction pull failed for variance %s", var_id)
            raise HTTPException(
                status_code=502,
                detail="Could not pull transactions from QuickBooks. Try again in a moment.",
            )

    # Return current rows (whether we just pulled them or not)
    txns = list((await db.execute(
        select(VarianceTransaction).where(VarianceTransaction.variance_id == var_id)
        .order_by(VarianceTransaction.txn_date.desc().nullslast())
    )).scalars().all())

    return {
        "variance_id":        str(var_id),
        "qbo_account_id":     acct.qbo_account_id,
        "is_material":        var.is_material,
        "checked_count":      sum(1 for t in txns if t.is_checked),
        "total_count":        len(txns),
        "transactions": [
            {
                "id":          str(t.id),
                "qbo_txn_id":  t.qbo_txn_id,
                "txn_type":    t.txn_type,
                "txn_number":  t.txn_number or "",
                "txn_date":    t.txn_date.isoformat() if t.txn_date else None,
                "amount":      str(t.amount),
                "memo":        t.memo or "",
                "entity_name": t.entity_name or "",
                "is_checked":  t.is_checked,
                "checked_by":  str(t.checked_by) if t.checked_by else None,
                "checked_at":  t.checked_at.isoformat() if t.checked_at else None,
            }
            for t in txns
        ],
    }


@router.post("/trial-balances/{tb_id}/variances/{var_id}/transactions/{txn_id}/check",
             dependencies=[Depends(_require_tb_open)])
async def toggle_variance_transaction_check(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    txn_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Toggle the 'I've checked this transaction' flag and audit-log it."""
    t = (await db.execute(
        select(VarianceTransaction).where(
            VarianceTransaction.id == txn_id,
            VarianceTransaction.variance_id == var_id,
        )
    )).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if t.is_checked:
        t.is_checked = False
        t.checked_by = None
        t.checked_at = None
        action_label = "unchecked"
    else:
        t.is_checked = True
        t.checked_by = user.id
        t.checked_at = datetime.now(UTC)
        action_label = "checked"

    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"flux.variance_txn_{action_label}",
        entity_type="variance_transaction", entity_id=txn_id,
        metadata={
            "summary": f"{action_label.title()} {t.txn_type} {t.txn_number or ''}".strip(),
            "variance_id": str(var_id),
        },
    )
    await db.commit()
    return {
        "id": str(t.id),
        "is_checked": t.is_checked,
        "checked_by": str(t.checked_by) if t.checked_by else None,
        "checked_at": t.checked_at.isoformat() if t.checked_at else None,
    }


@router.post("/trial-balances/{tb_id}/variances/{var_id}/regenerate",
             dependencies=[Depends(enforce_ai_limits), Depends(_require_tb_open)])
async def regenerate_variance(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Clear the existing narrative for a single variance and re-run the AI task.
    Lets the user request a fresh AI explanation for any variance, regardless of
    whether it was previously material/pending.
    """
    # Confirm the variance belongs to the TB
    stmt = (
        select(Variance)
        .join(Account, Variance.account_id == Account.id)
        .where(Variance.id == var_id, Account.trial_balance_id == tb_id)
    )
    var_row = (await db.execute(stmt)).scalar_one_or_none()
    if var_row is None:
        raise HTTPException(status_code=404, detail="Variance not found")

    # Wipe any existing narrative so the new one isn't blocked by the cache check
    await db.execute(delete(Narrative).where(Narrative.variance_id == var_id))

    # Reset status back to pending so the worker picks it up
    var_row.status = "pending"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.variance_regenerated", entity_type="variance", entity_id=var_id,
        metadata={"summary": "Requested a fresh AI explanation for a variance"},
    )
    await db.commit()

    background_tasks.add_task(generate_narrative_async, str(var_id), str(tenant_id))
    return {"id": str(var_id), "status": "queued"}


@router.put("/trial-balances/{tb_id}/variances/{var_id}/narrative",
            dependencies=[Depends(_require_tb_open)])
async def update_narrative(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    body: NarrativeUpdate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Create or update the narrative for a variance (manual edit)."""
    import hashlib
    from datetime import datetime

    var_result = await db.execute(select(Variance).where(Variance.id == var_id))
    var = var_result.scalar_one_or_none()
    if var is None:
        raise HTTPException(status_code=404, detail="Variance not found")

    narr_result = await db.execute(
        select(Narrative).where(Narrative.variance_id == var_id)
    )
    narr = narr_result.scalar_one_or_none()

    cache_key = hashlib.sha256(f"manual-{var_id}-{body.content}".encode()).hexdigest()

    if narr:
        narr.content   = body.content
        narr.edited_by = user.id
        narr.edited_at = datetime.now(UTC)
    else:
        narr = Narrative(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            variance_id=var_id,
            content=body.content,
            cache_key=cache_key,
            confidence_score=Decimal("1.0"),
            input_tokens=0,
            output_tokens=len(body.content.split()),
            edited_by=user.id,
            edited_at=datetime.now(UTC),
        )
        db.add(narr)

    var.status = "edited"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.narrative_edited", entity_type="variance", entity_id=var_id,
        metadata={"summary": "Manually edited the AI narrative for a variance"},
    )
    await db.commit()
    return {"id": str(var_id), "status": "edited", "narrative": body.content}


@router.get("/trial-balances/{tb_id}/variances/{var_id}/pdf")
async def export_variance_pdf(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    Per-variance flux analysis PDF — a working paper for one account's
    period-over-period movement. Bundles the prior/current/change summary,
    the AI variance bridge (drivers + explained/unexplained), the full AI
    assessment (narrative, risk, justification, entities, recommendations),
    the supporting QBO transactions, and the approval sign-off.

    Unapproved variances export as DRAFT (large watermark); approved
    variances produce a clean signed-off file. Mirrors the per-account
    reconciliation PDF so a close binder reads as one document set.
    """
    import io

    row = (await db.execute(
        select(Variance, Account).join(Account, Variance.account_id == Account.id)
        .where(Variance.id == var_id, Account.trial_balance_id == tb_id)
    )).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Variance not found in this analysis.")
    var, acct = row

    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.id == tb_id)
    )).scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    try:
        from modules.financials.router import _company_name
        company = await _company_name(db, tenant_id)

        # Supporting QBO transactions (if the user pulled them)
        txns = list((await db.execute(
            select(VarianceTransaction)
            .where(VarianceTransaction.variance_id == var_id)
            .order_by(VarianceTransaction.txn_date.desc().nullslast())
        )).scalars().all())

        # Legacy prose narrative for rows analyzed before structured commentary
        narr = (await db.execute(
            select(Narrative).where(Narrative.variance_id == var_id)
        )).scalar_one_or_none()

        # Approver display name: Clerk "First Last" → email → short id.
        approved_by_name: str | None = None
        if var.approved_by:
            u = (await db.execute(
                select(User).where(User.id == var.approved_by)
            )).scalar_one_or_none()
            if u:
                approved_by_name = u.email or f"User {str(u.id)[:8]}"
                if u.clerk_user_id:
                    try:
                        from core.auth.clerk_users import _format_display_name, get_clerk_user
                        cu = await get_clerk_user(u.clerk_user_id)
                        if cu:
                            approved_by_name = _format_display_name(cu) or approved_by_name
                    except Exception:
                        logger.debug("clerk lookup failed for approver", exc_info=True)

        is_draft = var.status != "approved"
        data = {
            "company":          company,
            "account_number":   acct.account_number or "",
            "account_name":     acct.account_name,
            "tb_name":          tb.name,
            "period_current":   tb.period_current,
            "period_prior":     tb.period_prior,
            "current_balance":  str(acct.current_balance),
            "prior_balance":    str(acct.prior_balance),
            "dollar_variance":  str(var.dollar_variance),
            "pct_variance":     str(var.pct_variance) if var.pct_variance is not None else None,
            "is_material":      var.is_material,
            "status":           var.status,
            "ai_commentary":    var.ai_commentary,
            "legacy_narrative": narr.content if narr else None,
            "transactions": [
                {
                    "txn_date":    t.txn_date,
                    "txn_type":    t.txn_type,
                    "txn_number":  t.txn_number,
                    "entity_name": t.entity_name,
                    "memo":        t.memo,
                    "amount":      str(t.amount),
                    "is_checked":  t.is_checked,
                }
                for t in txns
            ],
            "approved_by_name": approved_by_name,
            "approved_at":      var.approved_at.isoformat() if var.approved_at else None,
            "exported_by":      user.email or "",
            "is_draft":         is_draft,
        }

        from modules.flux.pdf import build_variance_pdf
        buf = io.BytesIO()
        build_variance_pdf(buf, data=data)
        buf.seek(0)

        safe_name = (
            (acct.account_number + "-" if acct.account_number else "")
            + acct.account_name.replace(" ", "-").replace("/", "-")
        )[:80]
        prefix = "draft-" if is_draft else ""
        fname = f"{prefix}flux-variance-{tb.period_current.isoformat()}-{safe_name}.pdf"
        logger.info("Variance PDF export done: %d bytes for %s", buf.getbuffer().nbytes, var_id)
        return StreamingResponse(
            buf, media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Variance PDF export failed for variance %s", var_id)
        raise HTTPException(
            status_code=500,
            detail="Could not build the variance PDF. Try again in a moment.",
        )


# ── Export ──────────────────────────────────────────────────────────────────────

@router.get("/trial-balances/{tb_id}/export")
async def export_excel(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    Export the variance analysis as an Excel file.
    Delegates to modules.exports.flux_workbook for a consistent
    monochrome look that matches the Period Export and per-account
    reconciliation downloads.
    """
    from io import BytesIO

    from modules.exports.flux_workbook import build_flux_workbook

    # Resolve workspace name for the cover sheet
    company_name = "Workspace"
    try:
        from models.tenant import Tenant
        t = (await db.execute(
            select(Tenant).where(Tenant.id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        if t and getattr(t, "name", None):
            company_name = t.name
    except Exception:
        pass

    generated_by = "Unknown user"
    try:
        if user:
            display = getattr(user, "display_name", None) or getattr(user, "email", None)
            if display:
                generated_by = str(display)
    except Exception:
        pass

    try:
        data, fname = await build_flux_workbook(
            db=db,
            tb_id=tb_id,
            company_name=company_name,
            generated_by_name=generated_by,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Trial balance not found")
    except Exception:
        logger.exception("Flux workbook build failed")
        raise HTTPException(
            status_code=500,
            detail="Could not build the flux export. Check server logs.",
        )

    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )


# ── Reset & Delete ──────────────────────────────────────────────────────────────

async def _wipe_tb_children(
    tb_id: uuid.UUID, db: AsyncSession, tenant_id: uuid.UUID
) -> None:
    """
    Hard-delete every Account/Variance/Narrative belonging to this TB.
    Order: narratives → variances → accounts (FK-safe even without cascades).

    These deletes are scoped by `trial_balance_id` (a foreign key), which the
    session filter does NOT auto-scope to the tenant. So we first ENFORCE that
    the current tenant owns this trial balance — a foreign / nonexistent tb_id
    raises TenantOwnershipError (→ 404) and nothing is deleted. Callers already
    404 on a missing TB; this makes the cascade safe even if a future caller
    forgets that check (write-path isolation by enforcement, not convention).
    """
    await assert_tenant_owns(
        db, TrialBalance, tb_id, tenant_id=tenant_id, label="Trial balance"
    )

    # Subquery: variances for this TB
    var_subq = (
        select(Variance.id)
        .join(Account, Variance.account_id == Account.id)
        .where(Account.trial_balance_id == tb_id)
        .subquery()
    )
    await db.execute(delete(Narrative).where(Narrative.variance_id.in_(select(var_subq))))

    # Variances next
    acct_subq = (
        select(Account.id).where(Account.trial_balance_id == tb_id).subquery()
    )
    await db.execute(delete(Variance).where(Variance.account_id.in_(select(acct_subq))))

    # Then accounts
    await db.execute(delete(Account).where(Account.trial_balance_id == tb_id))


@router.post("/trial-balances/{tb_id}/accounts/{qbo_account_id}/sync",
             dependencies=[Depends(_require_tb_open)])
async def sync_one_account_from_qbo(
    tb_id: uuid.UUID,
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Surgical refresh: re-pull just this one account's current + prior
    balance from QBO and recompute its variance row in place. Same
    convention as the full Flux pull (signed debit-positive), so the
    row updates without touching anything else in the TB.

    Returns the updated balances + recomputed variance fields so the
    frontend can patch the row optimistically.
    """
    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.id == tb_id)
    )).scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found.")

    acct = (await db.execute(
        select(Account).where(
            Account.trial_balance_id == tb_id,
            Account.qbo_account_id == qbo_account_id,
        )
    )).scalar_one_or_none()
    if acct is None:
        raise HTTPException(
            status_code=404,
            detail="Account not found in this analysis — was the TB built from QBO?",
        )

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    from core.qbo_tb import fetch_trial_balance, parse_trial_balance

    # Fetch both period reports — the variance recompute needs both
    # current and prior balances to stay consistent with the rest of
    # the TB. Two API calls per sync; cheap enough for a per-row action.
    try:
        report_current = await fetch_trial_balance(conn, tb.period_current)
        report_prior   = await fetch_trial_balance(conn, tb.period_prior)
    except Exception:
        logger.exception("QBO sync failed for tb %s", tb.id)
        raise HTTPException(
            status_code=502,
            detail="QuickBooks sync failed. Try again, or reconnect QuickBooks if this persists.",
        )

    tb_current = parse_trial_balance(report_current)
    tb_prior   = parse_trial_balance(report_prior)

    # Look up by canonical id first; fall back to name variants so the
    # sync works on older QBO instances that didn't always emit Id rows.
    def _lookup(parsed: dict, name: str, number: str | None) -> Decimal:
        by_id   = parsed["by_id"]
        by_name = parsed["by_name"]
        if qbo_account_id in by_id:
            return by_id[qbo_account_id]
        if number and number in by_name:
            return by_name[number]
        candidates = [
            f"{number} {name}".strip() if number else "",
            name,
            f"{name} ({number})".strip() if number else "",
            name.split(":")[-1].strip() if ":" in name else "",
        ]
        for c in candidates:
            if c and c in by_name:
                return by_name[c]
        return Decimal("0")

    new_current = _lookup(tb_current, acct.account_name, acct.account_number)
    new_prior   = _lookup(tb_prior,   acct.account_name, acct.account_number)

    acct.current_balance = new_current
    acct.prior_balance   = new_prior

    # Recompute the variance row in place — keep the same materiality
    # rule + anomaly flags the rest of the analysis was generated with.
    var = (await db.execute(
        select(Variance).where(Variance.account_id == acct.id)
    )).scalar_one_or_none()
    if var is not None:
        dollar_var = new_current - new_prior
        var.dollar_variance = dollar_var
        if new_prior != 0:
            var.pct_variance = (dollar_var / new_prior).quantize(Decimal("0.0001"))
        else:
            var.pct_variance = None
        var.is_material = abs(dollar_var) >= Decimal(tb.materiality_threshold)
        # Recompute anomaly flags (subset — sign flip + dormant
        # reactivation; new_account stays as originally tagged).
        flags = [f for f in (var.anomaly_flags or []) if f == "new_account"]
        if (new_prior < 0 and new_current > 0) or (new_prior > 0 and new_current < 0):
            flags.append("sign_flip")
        if new_prior == 0 and new_current != 0 and "new_account" not in flags:
            flags.append("dormant_reactivated")
        if new_prior != 0 and abs(dollar_var / new_prior) >= Decimal("0.5"):
            flags.append("large_pct_change")
        # De-dup while preserving order
        seen: set[str] = set()
        var.anomaly_flags = [f for f in flags if not (f in seen or seen.add(f))]

        # Re-syncing an APPROVED variance re-opens it: the balances just
        # changed, so the approval no longer reflects the data. Drop it
        # back to "generated" (keeps any AI commentary; clears the
        # approval stamp) so it returns to the review queue.
        if var.status == "approved":
            var.status = "generated"
            var.approved_by = None
            var.approved_at = None
            reopened = True
        else:
            reopened = False
    else:
        reopened = False

    await db.commit()
    await db.refresh(acct)
    if var is not None:
        await db.refresh(var)

    try:
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="flux.account_synced",
            entity_type="account", entity_id=acct.id,
            metadata={
                "summary": (
                    f"Resynced {acct.account_name} from QBO"
                    + (" (re-opened — was approved)" if reopened else "")
                ),
                "qbo_account_id": qbo_account_id,
                "new_current":  str(new_current),
                "new_prior":    str(new_prior),
                "reopened":     reopened,
            },
        )
        await db.commit()
    except Exception:
        # Audit failures shouldn't block the user — log and continue.
        logger.exception("Audit write failed on flux account sync")

    return {
        "account_id":      str(acct.id),
        "qbo_account_id":  qbo_account_id,
        "account_name":    acct.account_name,
        "current_balance": str(new_current),
        "prior_balance":   str(new_prior),
        "variance": {
            "id":              str(var.id) if var else None,
            "dollar_variance": str(var.dollar_variance) if var else "0",
            "pct_variance":    str(var.pct_variance) if var and var.pct_variance is not None else None,
            "is_material":     bool(var.is_material) if var else False,
            "anomaly_flags":   list(var.anomaly_flags or []) if var else [],
        } if var else None,
        "reopened":  reopened,
        "synced_at": datetime.now(UTC).isoformat(),
    }


@router.post("/trial-balances/{tb_id}/reset", status_code=status.HTTP_200_OK,
             dependencies=[Depends(_require_tb_open)])
async def reset_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Reset an analysis to its just-created state:
      - Wipe all parsed data (accounts, variances, narratives)
      - Clear uploaded file reference + column mapping
      - Reset status to "pending" so the user can re-upload

    Preserves: name, period_current, period_prior, materiality_threshold, created_by.
    """
    tb_result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = tb_result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    await _wipe_tb_children(tb_id, db, tenant_id)

    tb.status = "pending"
    tb.r2_key = None
    tb.column_mapping = {}
    tb.fs_line_mapping = {}
    tb.error_detail = None
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="flux.analysis_reset", entity_type="trial_balance", entity_id=tb.id,
        metadata={"summary": f"Reset flux analysis '{tb.name}' to its just-created state"},
    )
    await db.commit()
    return {"id": str(tb_id), "status": "pending", "message": "Analysis reset — ready for re-upload."}


@router.delete("/trial-balances/{tb_id}", status_code=status.HTTP_204_NO_CONTENT,
               dependencies=[Depends(_require_tb_open)])
async def delete_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    _user: User = Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """
    Hard-delete an entire analysis and all its children.
    Use with care — there is no undo. Admin-only: destroying a whole
    analysis (and its sign-offs) is not a preparer/reviewer action.
    """
    tb_result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = tb_result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    tb_name, tb_period = tb.name, tb.period_current
    await _wipe_tb_children(tb_id, db, tenant_id)
    await db.delete(tb)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=_user.id,
        action="flux.analysis_deleted", entity_type="trial_balance", entity_id=tb_id,
        metadata={"summary": f"Deleted flux analysis '{tb_name}' ({tb_period})"},
    )
    await db.commit()
