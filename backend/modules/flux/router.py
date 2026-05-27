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
import io
import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pandas as pd
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser, require_role
from core.config import settings
from core.db.session import get_db
from models.account import Account
from models.narrative import Narrative
from models.qbo_connection import QboConnection
from models.trial_balance import TrialBalance
from models.variance import Variance
from models.variance_transaction import VarianceTransaction
from modules.flux.schemas import (
    ColumnMappingBody,
    FluxRunResponse,
    NarrativeUpdate,
    ParseResult,
    TrialBalanceCreate,
    TrialBalanceResponse,
    UploadPreview,
    VarianceResponse,
    VarianceStatusUpdate,
)
from modules.flux.service import (
    create_accounts_and_variances,
    parse_accounts_from_file,
    parse_file_to_preview,
    parse_qbo_trial_balance_report,
)
from modules.flux.tasks import (  # noqa: F401  (kept for celery)
    generate_narrative_async,
    generate_narrative_task,
)
from modules.flux.variance_txns import pull_transactions_for_variance
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
        raise HTTPException(status_code=502, detail=str(exc))

    # 3b) Pull the Account list so we can use the proper AcctNum from QBO
    # instead of relying on whatever the TrialBalance report shows as the row
    # label (which is often just the account name, no number).
    # IMPORTANT: pass `query` via httpx `params=` so it's URL-encoded properly
    # — the previous f-string approach turned spaces into URL breaks and the
    # whole query silently returned 0 results.
    qbo_acct_lookup: dict[str, dict] = {}
    try:
        token = await _get_valid_token(conn, db)
        url = f"{settings.qbo_base_url}/v3/company/{conn.realm_id}/query"
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                url,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                params={
                    "query": "SELECT Id, Name, AcctNum, AccountType FROM Account WHERE Active = true MAXRESULTS 1000",
                    "minorversion": "65",
                },
            )
        if resp.status_code == 200:
            for a in resp.json().get("QueryResponse", {}).get("Account", []) or []:
                qbo_acct_lookup[str(a.get("Id"))] = a
    except Exception:
        # Best-effort: parser falls back to text-prefix parsing if lookup is empty
        qbo_acct_lookup = {}

    # 4) Parse into account dicts and persist accounts + variances
    try:
        account_dicts = parse_qbo_trial_balance_report(
            report_current, report_prior, tb.fs_line_mapping or {},
            qbo_acct_lookup=qbo_acct_lookup,
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


# ── Upload & Parse ──────────────────────────────────────────────────────────────

@router.post("/trial-balances/{tb_id}/upload", response_model=UploadPreview)
async def upload_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
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
    tb.column_mapping = {
        "_file_b64": base64.b64encode(file_bytes).decode("ascii"),
        "_filename": file.filename or "file.xlsx",
    }
    tb.status = "pending"
    await db.commit()

    return UploadPreview(
        headers=headers,
        sample_rows=sample_rows,
        detected_mapping=detected,
    )


@router.post("/trial-balances/{tb_id}/parse", response_model=ParseResult)
async def parse_trial_balance(
    tb_id: uuid.UUID,
    body: ColumnMappingBody,
    tenant_id: CurrentTenantId,
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
    await db.commit()

    return ParseResult(
        accounts_created=accts,
        variances_created=vars_,
        material_count=material,
    )


# ── Run ─────────────────────────────────────────────────────────────────────────

@router.post("/trial-balances/{tb_id}/run", response_model=FluxRunResponse)
async def run_flux(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
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
                account_number=acct.account_number,
                account_name=acct.account_name,
                current_balance=acct.current_balance,
                prior_balance=acct.prior_balance,
                dollar_variance=var.dollar_variance,
                pct_variance=var.pct_variance,
                is_material=var.is_material,
                anomaly_flags=var.anomaly_flags or [],
                status=var.status,
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
    dependencies=[Depends(require_role("reviewer"))],
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


# Status values the /status endpoint accepts. We intentionally exclude
# "approved" from this list — Approve has its own endpoint that also
# stamps approved_by + approved_at and writes a distinct audit event.
# Likewise "generating" is set by the AI runner, not by humans.
_ALLOWED_STATUS_FLIPS = {"pending", "generated", "edited", "flagged"}


@router.post("/trial-balances/{tb_id}/variances/{var_id}/status")
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


@router.post("/trial-balances/{tb_id}/agentic/run")
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


@router.post("/trial-balances/{tb_id}/variances/{var_id}/agentic/run")
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
    dependencies=[Depends(require_role("reviewer"))],
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
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

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


@router.post("/trial-balances/{tb_id}/variances/{var_id}/transactions/{txn_id}/check")
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


@router.post("/trial-balances/{tb_id}/variances/{var_id}/regenerate")
async def regenerate_variance(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    tenant_id: CurrentTenantId,
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
    await db.commit()

    background_tasks.add_task(generate_narrative_async, str(var_id), str(tenant_id))
    return {"id": str(var_id), "status": "queued"}


@router.put("/trial-balances/{tb_id}/variances/{var_id}/narrative")
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
    await db.commit()
    return {"id": str(var_id), "status": "edited", "narrative": body.content}


# ── Export ──────────────────────────────────────────────────────────────────────

@router.get("/trial-balances/{tb_id}/export")
async def export_excel(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    Export the variance analysis as an Excel file.
    Includes: TB metadata, account variances, AI narratives.
    """
    tb_result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = tb_result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    # Load all variance + account + narrative rows
    stmt = (
        select(Variance, Account, Narrative)
        .join(Account, Variance.account_id == Account.id)
        .outerjoin(Narrative, Narrative.variance_id == Variance.id)
        .where(Account.trial_balance_id == tb_id)
        .order_by(Variance.is_material.desc(), Variance.dollar_variance.desc())
    )
    rows = (await db.execute(stmt)).all()

    # Build DataFrame
    data = []
    for var, acct, narr in rows:
        data.append({
            "Account Number":   acct.account_number,
            "Account Name":     acct.account_name,
            "FS Category":      acct.fs_category or "",
            "FS Line":          acct.fs_line or "",
            "Current Balance":  float(acct.current_balance),
            "Prior Balance":    float(acct.prior_balance),
            "Dollar Variance":  float(var.dollar_variance),
            "% Variance":       float(var.pct_variance) if var.pct_variance else None,
            "Material":         "Yes" if var.is_material else "No",
            "Status":           var.status,
            "Anomaly Flags":    ", ".join(var.anomaly_flags or []),
            "AI Commentary":    narr.content if narr else "",
            "Confidence Score": float(narr.confidence_score) if narr and narr.confidence_score else None,
        })

    df = pd.DataFrame(data)

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        # Summary sheet
        summary = pd.DataFrame({
            "Field": ["Analysis Name", "Current Period", "Prior Period", "Materiality Threshold", "Status"],
            "Value": [
                tb.name,
                str(tb.period_current),
                str(tb.period_prior),
                f"${float(tb.materiality_threshold):,.0f}",
                tb.status,
            ],
        })
        summary.to_excel(writer, sheet_name="Summary", index=False)
        df.to_excel(writer, sheet_name="Variance Analysis", index=False)

        # Basic formatting
        for sheet_name in writer.sheets:
            ws = writer.sheets[sheet_name]
            for col in ws.columns:
                max_len = max((len(str(cell.value or "")) for cell in col), default=10)
                ws.column_dimensions[col[0].column_letter].width = min(max_len + 2, 60)

    buf.seek(0)
    safe_name = tb.name.replace(" ", "_").replace("/", "-")

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}_flux.xlsx"'
        },
    )


# ── Reset & Delete ──────────────────────────────────────────────────────────────

async def _wipe_tb_children(tb_id: uuid.UUID, db: AsyncSession) -> None:
    """
    Hard-delete every Account/Variance/Narrative belonging to this TB.
    Order: narratives → variances → accounts (FK-safe even without cascades).
    """
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


@router.post("/trial-balances/{tb_id}/reset", status_code=status.HTTP_200_OK)
async def reset_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
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

    await _wipe_tb_children(tb_id, db)

    tb.status = "pending"
    tb.r2_key = None
    tb.column_mapping = {}
    tb.fs_line_mapping = {}
    tb.error_detail = None
    await db.commit()
    return {"id": str(tb_id), "status": "pending", "message": "Analysis reset — ready for re-upload."}


@router.delete("/trial-balances/{tb_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_trial_balance(
    tb_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> None:
    """
    Hard-delete an entire analysis and all its children.
    Use with care — there is no undo.
    """
    tb_result = await db.execute(select(TrialBalance).where(TrialBalance.id == tb_id))
    tb = tb_result.scalar_one_or_none()
    if tb is None:
        raise HTTPException(status_code=404, detail="Trial balance not found")

    await _wipe_tb_children(tb_id, db)
    await db.delete(tb)
    await db.commit()
