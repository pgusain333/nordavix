"""
Close Binder endpoint — one paginated, audit-ready PDF per closed period.

Gated to a CLOSED period so the binder is byte-stable: every section reads the
committed snapshot, never a fresh QBO pull, so a binder a reviewer signs today
regenerates identically tomorrow.
"""
from __future__ import annotations

import io
import logging
import uuid
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.db.session import get_db
from core.storage import r2 as r2_storage
from models.closed_period import ClosedPeriod
from models.workpaper_evidence import WorkpaperEvidence
from modules.workpapers.binder import build_close_binder

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/binder")
async def download_close_binder(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="YYYY-MM-DD — must be a closed period"),
    db: AsyncSession = Depends(get_db),
):
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(400, "period_end must be YYYY-MM-DD.")

    closed = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == pe)
    )).scalar_one_or_none()
    if closed is None:
        raise HTTPException(
            409,
            "The books for this period aren't closed yet. Close them in "
            "Reconciliations to generate the signed close binder.",
        )

    from modules.financials.router import _company_name
    company = await _company_name(db, tenant_id)
    generated_by = user.email or "Nordavix"

    logger.info("Close binder: building tenant=%s period=%s", tenant_id, pe)
    try:
        pdf = await build_close_binder(
            db=db, tenant_id=tenant_id, period_end=pe,
            company=company, generated_by_name=generated_by, closed=closed)
    except Exception as exc:
        logger.exception("Close binder build failed tenant=%s period=%s", tenant_id, pe)
        raise HTTPException(
            500,
            f"Close binder generation failed: {type(exc).__name__}: {str(exc)[:200]}",
        ) from exc

    try:
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="workpapers.binder_exported", entity_type="closed_period",
            entity_id=closed.id, metadata={"summary": f"Close binder exported for {pe.isoformat()}"})
        await db.commit()
    except Exception:
        await db.rollback()
        logger.debug("Close binder: audit write failed (non-fatal)", exc_info=True)

    logger.info("Close binder done: tenant=%s period=%s bytes=%d", tenant_id, pe, len(pdf))
    fname = f"close-binder-{pe.isoformat()}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf), media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )


# ── Workpaper evidence — supporting documents attached to any workpaper ──────
#
# Generalizes the per-account recon evidence (SubledgerEvidence) to the whole
# close: a file in R2 tied to (period, ref_type, ref_id). The Workpapers
# workspace lists these per binder row; the Close Binder folds them in as a
# referenced appendix. Read-only QBO — these are user-uploaded support only.

_ALLOWED_EVIDENCE_EXTS = {"pdf", "xlsx", "xls", "csv", "png", "jpg", "jpeg", "docx", "txt"}
_MAX_EVIDENCE_BYTES = 15 * 1024 * 1024  # 15 MB
_REF_TYPES = {"account", "schedule", "adjustment", "flux", "financials", "general"}


def _parse_period(period_end: str) -> date:
    try:
        return date.fromisoformat(period_end)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")


async def _block_if_closed(db: AsyncSession, pe: date) -> None:
    """Workpapers for a closed period are locked — the binder reflects exactly
    what was signed. Reopen the period (Reconciliations) to change them."""
    closed = (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == pe)
    )).scalar_one_or_none()
    if closed is not None:
        raise HTTPException(
            status_code=409,
            detail="This period is closed — reopen it to add or remove workpaper evidence.",
        )


def _serialize_evidence(e: WorkpaperEvidence) -> dict:
    return {
        "id": str(e.id),
        "period_end": e.period_end.isoformat(),
        "ref_type": e.ref_type,
        "ref_id": e.ref_id,
        "file_name": e.file_name,
        "file_size": e.file_size,
        "mime_type": e.mime_type,
        "note": e.note,
        "uploaded_by": str(e.uploaded_by),
        "uploaded_at": e.uploaded_at.isoformat() if e.uploaded_at else None,
        "verification": e.verification,
    }


@router.post("/evidence")
async def upload_workpaper_evidence(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    ref_type: str = Query(..., description="account | schedule | adjustment | flux | financials | general"),
    ref_id: str | None = Query(default=None, description="The workpaper id; omit for general docs"),
    note: str | None = Query(default=None, description="Optional short caption"),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Attach a supporting document to a workpaper (or the general bucket). Stored
    in R2; this row is metadata. Mirrors the recon evidence upload."""
    pe = _parse_period(period_end)
    if ref_type not in _REF_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid ref_type. Use: {', '.join(sorted(_REF_TYPES))}.")
    if ref_type != "general" and not ref_id:
        raise HTTPException(status_code=400, detail="ref_id is required unless ref_type is 'general'.")
    await _block_if_closed(db, pe)

    name = file.filename or "evidence"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in _ALLOWED_EVIDENCE_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"File type .{ext} not allowed. Use: {', '.join(sorted(_ALLOWED_EVIDENCE_EXTS))}.",
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > _MAX_EVIDENCE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large (max {_MAX_EVIDENCE_BYTES // (1024 * 1024)} MB).",
        )

    mime = file.content_type or "application/octet-stream"
    safe_name = name.replace("/", "_").replace("\\", "_")
    key = r2_storage.tenant_key(
        tenant_id,
        f"workpaper-evidence/{ref_type}/{ref_id or 'general'}/{pe.isoformat()}",
        f"{uuid.uuid4()}_{safe_name}",
    )
    r2_storage.upload_file(key, io.BytesIO(raw), content_type=mime)

    row = WorkpaperEvidence(
        id=uuid.uuid4(), tenant_id=tenant_id, period_end=pe,
        ref_type=ref_type, ref_id=ref_id,
        file_name=safe_name, file_size=len(raw), mime_type=mime, r2_key=key,
        note=(note or None), uploaded_by=user.id,
    )
    db.add(row)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="workpapers.evidence_uploaded",
        entity_type="workpaper_evidence", entity_id=row.id,
        metadata={"summary": f"Attached {safe_name} to {ref_type} workpaper for {pe}",
                  "ref_type": ref_type, "ref_id": ref_id, "period_end": pe.isoformat()},
    )
    await db.commit()
    await db.refresh(row)
    return _serialize_evidence(row)


@router.get("/evidence")
async def list_workpaper_evidence(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    ref_type: str | None = Query(default=None),
    ref_id: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Evidence for the period, optionally filtered to one workpaper. SELECT is
    tenant-auto-filtered, so it's scoped to the caller's workspace."""
    pe = _parse_period(period_end)
    q = select(WorkpaperEvidence).where(WorkpaperEvidence.period_end == pe)
    if ref_type:
        q = q.where(WorkpaperEvidence.ref_type == ref_type)
    if ref_id:
        q = q.where(WorkpaperEvidence.ref_id == ref_id)
    rows = (await db.execute(q.order_by(desc(WorkpaperEvidence.uploaded_at)))).scalars().all()
    return {"items": [_serialize_evidence(e) for e in rows]}


@router.get("/evidence/summary")
async def workpaper_evidence_summary(
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Evidence counts per workpaper for the period, keyed "ref_type:ref_id" — the
    badge data the Workpapers index renders. Composed client-side with the
    module APIs, so this stays a cheap single grouped query."""
    pe = _parse_period(period_end)
    rows = (await db.execute(
        select(WorkpaperEvidence.ref_type, WorkpaperEvidence.ref_id, func.count(WorkpaperEvidence.id))
        .where(WorkpaperEvidence.period_end == pe)
        .group_by(WorkpaperEvidence.ref_type, WorkpaperEvidence.ref_id)
    )).all()
    counts = {f"{rt}:{rid or ''}": int(n) for rt, rid, n in rows}
    return {"counts": counts, "total": sum(counts.values())}


@router.get("/evidence/{evidence_id}/download")
async def download_workpaper_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Short-lived signed URL for the browser to fetch the file. Tenant-scoped
    SELECT means a user can only ever reach their own org's files."""
    row = (await db.execute(
        select(WorkpaperEvidence).where(WorkpaperEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")
    url = r2_storage.generate_presigned_download_url(row.r2_key, expires_in=300)
    return {"url": url, "file_name": row.file_name}


@router.delete("/evidence/{evidence_id}")
async def delete_workpaper_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Remove an attachment (R2 object + row). Blocked once the period is closed."""
    row = (await db.execute(
        select(WorkpaperEvidence).where(WorkpaperEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")
    await _block_if_closed(db, row.period_end)
    r2_storage.delete_file(row.r2_key)
    await db.delete(row)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="workpapers.evidence_deleted",
        entity_type="workpaper_evidence", entity_id=evidence_id,
        metadata={"summary": f"Removed {row.file_name} from {row.ref_type} workpaper for {row.period_end}",
                  "ref_type": row.ref_type, "ref_id": row.ref_id},
    )
    await db.commit()
    return {"deleted": True}
