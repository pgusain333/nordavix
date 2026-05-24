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
  PUT  /trial-balances/{id}/variances/{v}   /narrative — manual edit
  GET  /trial-balances/{id}/export          Excel download
"""
import io
import uuid
from decimal import Decimal

import pandas as pd
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, status
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from models.account import Account
from models.narrative import Narrative
from models.trial_balance import TrialBalance
from models.variance import Variance
from modules.flux.schemas import (
    ColumnMappingBody,
    FluxRunResponse,
    NarrativeUpdate,
    ParseResult,
    TrialBalanceCreate,
    TrialBalanceResponse,
    UploadPreview,
    VarianceResponse,
)
from modules.flux.service import parse_file_to_preview, parse_accounts_from_file, create_accounts_and_variances
from modules.flux.tasks import generate_narrative_async, generate_narrative_task  # noqa: F401  (kept for celery)

router = APIRouter()


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

    # Required mapping keys
    required = {"account_number", "account_name", "current_balance", "prior_balance"}
    missing = required - set(body.mapping.keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing column mappings: {', '.join(missing)}")

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

    tb.status = "parsed"
    await db.commit()

    # Enqueue AI tasks for material variances
    variance_result = await db.execute(
        select(Variance).join(Account, Variance.account_id == Account.id)
        .where(Account.trial_balance_id == tb_id, Variance.is_material == True)
    )
    material_variances = list(variance_result.scalars().all())

    # Run AI in-process via BackgroundTasks — no separate worker required.
    for var in material_variances:
        background_tasks.add_task(generate_narrative_async, str(var.id), str(tenant_id))

    if material_variances:
        tb.status = "generating"
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


@router.post("/trial-balances/{tb_id}/variances/{var_id}/approve")
async def approve_variance(
    tb_id: uuid.UUID,
    var_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mark a variance as approved."""
    var_result = await db.execute(select(Variance).where(Variance.id == var_id))
    var = var_result.scalar_one_or_none()
    if var is None:
        raise HTTPException(status_code=404, detail="Variance not found")

    var.status = "approved"
    await db.commit()
    return {"id": str(var_id), "status": "approved"}


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
    from datetime import datetime, timezone

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
        narr.edited_at = datetime.now(timezone.utc)
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
            edited_at=datetime.now(timezone.utc),
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
        wb = writer.book
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
