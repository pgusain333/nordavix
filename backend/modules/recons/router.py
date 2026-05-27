"""
Reconciliations API.

  GET    /reconciliations                       list (with optional ?type=AR filter)
  POST   /reconciliations                       create + start QBO sync
  GET    /reconciliations/dashboard             KPIs + activity + insights
  GET    /reconciliations/{id}                  detail (recon + items + txns + notes)
  POST   /reconciliations/{id}/sync             re-pull from QBO + recompute
  POST   /reconciliations/{id}/approve          mark approved
  POST   /reconciliations/{id}/assign           assign to user (or null to clear)
  POST   /reconciliations/{id}/notes            add a note
  PUT    /reconciliations/{id}/items/{itemId}/status   set item status
  POST   /reconciliations/{id}/items/{itemId}/regenerate  rerun AI for one item
  DELETE /reconciliations/{id}                  hard delete
  GET    /reconciliations/{id}/export           Excel support package
"""
import asyncio
import io
import logging
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pandas as pd
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)

from core.config import settings as _settings

logger = logging.getLogger(__name__)
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.clerk_users import _format_display_name, get_clerk_user
from core.auth.dependencies import ROLE_ORDER, CurrentTenantId, CurrentUser, require_role
from core.db.session import get_db
from core.storage import r2 as r2_storage
from models.account_review_status import AccountReviewStatus
from models.closed_period import ClosedPeriod
from models.qbo_connection import QboConnection
from models.reconciliation import (
    Reconciliation,
    ReconciliationItem,
    ReconNote,
    ReconTransaction,
)
from models.subledger_evidence import SubledgerEvidence
from models.tenant import Tenant
from modules.recons.overview import (
    fetch_subledger_detail,
    fetch_variance_detail,
)
from modules.recons.schemas import (
    ActivityFeedEntry,
    AssignBody,
    ItemStatusUpdate,
    NoteCreate,
    ReconciliationCreate,
    ReconciliationDashboard,
    ReconciliationDashboardStats,
    ReconciliationDetail,
    ReconciliationItemResponse,
    ReconciliationResponse,
    ReconNoteResponse,
    ReconTransactionResponse,
)
from modules.recons.service import (
    explain_item,
    explain_recon_summary,
    insights_from,
    run_sync,
)

router = APIRouter()


# ── List + create ────────────────────────────────────────────────────────────

@router.get("", response_model=list[ReconciliationResponse])
async def list_reconciliations(
    tenant_id: CurrentTenantId,
    recon_type: str | None = Query(default=None, alias="type"),
    db: AsyncSession = Depends(get_db),
) -> list[Reconciliation]:
    stmt = select(Reconciliation).order_by(desc(Reconciliation.created_at))
    if recon_type:
        stmt = stmt.where(Reconciliation.recon_type == recon_type.upper())
    return list((await db.execute(stmt)).scalars().all())


@router.post("", response_model=ReconciliationResponse, status_code=status.HTTP_201_CREATED)
async def create_reconciliation(
    body: ReconciliationCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = Reconciliation(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        name=body.name,
        recon_type=body.recon_type,
        period_end=body.period_end,
        status="pending",
        created_by=user.id,
    )
    db.add(recon)
    await db.commit()
    await db.refresh(recon)

    # Sync immediately in the background
    background_tasks.add_task(run_sync, recon.id, tenant_id)
    return recon


# ── Live overview (the main dashboard view) ──────────────────────────────────

@router.get("/overview")
async def get_overview(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end date YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Reconciliation overview for a period. Reads from our snapshot tables
    (`gl_balance_snapshots`, `period_sync`, `account_review_status`) —
    no QBO calls, ~50ms response time. Called on every dashboard mount
    and every time the user changes the focused period.

    Returns `synced: false` when the period has never been synced; the
    UI shows the "Sync from QuickBooks" CTA in that case. The explicit
    POST /sync endpoint is what actually pulls fresh data from QBO and
    populates the snapshot tables.
    """
    from modules.recons.overview import read_overview_from_snapshots

    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    await _enforce_books_floor(db, tenant_id, pe)

    # Confirm the connection exists so the UI knows whether to show
    # the QBO-disconnected banner. We don't actually need it for reads.
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    qbo_connected = conn is not None

    overview = await read_overview_from_snapshots(db, pe)
    overview["qbo_connected"] = qbo_connected

    # Surface lock status so the UI can render the closed-books banner +
    # disable mutations. Resolves the closer's name client-side via the
    # workspace lookup hook.
    cp = await _is_period_closed(db, pe)
    overview["is_closed"] = cp is not None
    overview["closed_by"] = str(cp.closed_by) if cp else None
    overview["closed_at"] = cp.closed_at.isoformat() if cp and cp.closed_at else None
    overview["closed_notes"] = cp.notes if cp else None
    return overview


@router.post("/agentic/reset")
async def reset_agentic_endpoint(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end date YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Reset all Agentic Mode work for the period. Clears the AI-prepared
    subledger total, reconciling items, AI commentary, and resets
    status back to 'pending' on every row where AI commentary exists
    (which is how we detect rows AI touched).

    Doesn't touch human-prepared rows. Doesn't touch closed periods
    (gated by _block_if_closed). Audit-logged with the per-account count.
    """
    from datetime import date as _date

    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    await _block_if_closed(db, pe)

    # Only touch rows that have AI commentary — that's the cleanest
    # signal that AI did the work. Skip rows where ai_commentary IS
    # NULL (those were touched by a human via the inline form).
    rows = list((await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.period_end == pe,
            AccountReviewStatus.ai_commentary.is_not(None),
        )
    )).scalars().all())

    if not rows:
        return {"reset": 0, "period_end": period_end,
                "message": "No AI-prepared rows found for this period."}

    now = datetime.now(UTC)
    for r in rows:
        # Clear AI-set state. Leave notes alone (human might have added
        # text in there; AI commentary lives on the separate JSONB field).
        r.subledger_total = None
        r.subledger_source = None
        r.subledger_entered_by = None
        r.subledger_entered_at = None
        r.reconciling_items = []
        r.ai_commentary = None
        r.status = "pending"
        r.reviewed_by = None
        r.reviewed_at = None
        r.prepared_by = None
        r.prepared_at = None
        r.approved_by = None
        r.approved_at = None
        r.updated_at = now

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.agentic.reset",
        entity_type="account_review_status", entity_id=None,
        metadata={
            "summary": f"Reset AI agentic work on {len(rows)} account(s) for {period_end}",
            "period_end": period_end,
            "count": len(rows),
        },
    )
    await db.commit()
    logger.info("Agentic reset complete: %d row(s) cleared for %s", len(rows), pe)
    return {
        "reset": len(rows),
        "period_end": period_end,
        "message": (
            f"Cleared AI work on {len(rows)} account(s). "
            "Each row is back to pending with opening rolled forward from prior period — "
            "you can now reconcile manually via the inline form."
        ),
    }


@router.post("/agentic/run")
async def run_agentic_endpoint(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end date YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Run the AI agentic preparer on every open account in the period.
    See `modules.recons.agentic.run_agentic_prep` for the full
    behavioral spec. Returns a structured result the UI uses to render
    the post-run banner ("Prepared 5, AI-analyzed 3, skipped 2").

    One-shot per click — the user explicitly triggered this run. No
    background scheduling, no auto-re-run on future syncs.
    """
    from dataclasses import asdict
    from datetime import date as _date

    from modules.recons.agentic import run_agentic_prep

    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    logger.info(
        "Agentic prep run start: tenant=%s user=%s period=%s",
        tenant_id, user.id, pe,
    )
    try:
        result = await run_agentic_prep(db, tenant_id, user, pe)
        # asdict converts the nested dataclasses → plain dict for JSON
        return asdict(result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Agentic prep failed at top level for tenant=%s period=%s",
            tenant_id, pe,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Agentic preparer failed: {type(exc).__name__}: {str(exc)[:200]}",
        ) from exc


@router.post("/agentic/cancel")
async def cancel_agentic_endpoint(
    tenant_id: CurrentTenantId,
    user: CurrentUser,  # noqa: ARG001 — only needed for auth
    period_end: str = Query(..., description="Period end date YYYY-MM-DD"),
) -> dict:
    """
    Signal an in-flight agentic run to stop. Cooperative: the worker
    finishes its current account, commits cleanly, then exits with
    everything-so-far in the result blob. Calling cancel when nothing
    is running is a no-op (sets a flag that's auto-cleared on next run).
    """
    from datetime import date as _date

    from modules.recons.agentic import request_cancel

    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    request_cancel(tenant_id, pe)
    logger.info("Agentic cancel requested: tenant=%s period=%s", tenant_id, pe)
    return {"cancelled": True, "period_end": period_end}


@router.post("/sync")
async def sync_overview_endpoint(
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end date YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Explicit "Sync from QuickBooks" action. Pulls fresh TrialBalance,
    account list, AR/AP aging, and YTD Net Income from QBO and persists
    them to the snapshot tables. Returns the freshly-built overview.

    Heavy — ~3-8s of QBO calls. The UI's Sync button calls this; routine
    navigation goes through GET /overview (instant DB read).
    """
    from modules.recons.overview import sync_overview

    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    await _enforce_books_floor(db, tenant_id, pe)

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(
            status_code=400,
            detail="QuickBooks isn't connected for this workspace. Connect QBO and try again.",
        )

    overview = await sync_overview(conn, db, pe)
    overview["qbo_connected"] = True

    cp = await _is_period_closed(db, pe)
    overview["is_closed"] = cp is not None
    overview["closed_by"] = str(cp.closed_by) if cp else None
    overview["closed_at"] = cp.closed_at.isoformat() if cp and cp.closed_at else None
    overview["closed_notes"] = cp.notes if cp else None
    return overview


@router.get("/account/{qbo_account_id}/subledger")
async def get_account_subledger(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Drill-in for one account's subledger detail.
    For AR/AP — per customer/vendor aging rows.
    For Bank/CC — recent deposits and purchases.
    For others — recent journal entry activity.
    """
    from datetime import date
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected.")
    return await fetch_subledger_detail(conn, db, qbo_account_id, pe)


@router.get("/account/{qbo_account_id}/variance")
async def get_account_variance(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Transactions likely to explain a GL-vs-subledger variance for this account."""
    from datetime import date
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="QuickBooks isn't connected.")
    return await fetch_variance_detail(conn, db, qbo_account_id, pe)


@router.get("/account/{qbo_account_id}/pdf")
async def export_account_pdf(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    Per-account reconciliation PDF — an audit working-paper for one
    account in one period. Bundles GL/Subledger/Variance summary,
    the full reconciling-items build-up, prepared/approved trail,
    notes, and the list of supporting evidence files.

    Unsynced or never-reviewed accounts are exported as DRAFT (large
    watermark + DRAFT label on cover). Approved accounts produce a
    clean signed-off file.

    Wraps everything in explicit error capture so any failure surfaces
    a real detail string to the UI instead of a generic "Network Error".
    """
    import io
    import uuid as _uuid
    from datetime import date as _date

    from models.account_review_status import AccountReviewStatus
    from models.gl_balance_snapshot import GlBalanceSnapshot
    from models.subledger_evidence import SubledgerEvidence
    from models.user import User

    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    logger.info(
        "Account PDF export start: tenant=%s qbo_account=%s period=%s",
        tenant_id, qbo_account_id, pe,
    )

    try:
        # Resolve company name once (uses the workspace name, falls back
        # to the QBO sandbox name only if the workspace was never named).
        from modules.financials.router import _company_name
        company = await _company_name(db, tenant_id)

        # Pull the account's GL snapshot — this is the source of truth
        # for GL balance + account metadata (name/number/type).
        snap = (await db.execute(
            select(GlBalanceSnapshot).where(
                GlBalanceSnapshot.tenant_id == tenant_id,
                GlBalanceSnapshot.qbo_account_id == qbo_account_id,
                GlBalanceSnapshot.period_end == pe,
            )
        )).scalar_one_or_none()
        if snap is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    "No GL snapshot found for this account at this period. "
                    "Click Sync on the Reconciliations dashboard first, "
                    "then re-export."
                ),
            )

        # Current-period review status (status, reconciling_items, notes,
        # actor stamps, subledger_total, evidence).
        review = (await db.execute(
            select(AccountReviewStatus).where(
                AccountReviewStatus.qbo_account_id == qbo_account_id,
                AccountReviewStatus.period_end == pe,
            )
        )).scalar_one_or_none()

        # Opening balance roll-forward chain (same logic as the dashboard
        # overview + AI agentic preparer — kept in sync so what the
        # reviewer sees on screen matches what lands in the PDF):
        #   1. Prior period's reconciled subledger (true rolled-forward)
        #   2. Prior period's GL snapshot (audit-ready fallback when no
        #      reconciled prior exists — GL @ prior period_end is
        #      deterministic and gives first-time recs a sensible start)
        #   3. Zero (no history)
        prior = (await db.execute(
            select(AccountReviewStatus)
            .where(
                AccountReviewStatus.qbo_account_id == qbo_account_id,
                AccountReviewStatus.period_end < pe,
                AccountReviewStatus.subledger_total.is_not(None),
            )
            .order_by(AccountReviewStatus.period_end.desc())
            .limit(1)
        )).scalar_one_or_none()
        # Strict close-and-roll chain — opening = prior reconciled
        # subledger ONLY. No QBO/GL fallback. Same logic as the
        # dashboard overview + agentic preparer so all three views agree.
        from modules.recons.overview import pick_rollforward_opening
        chosen = pick_rollforward_opening(prior)
        if chosen is None:
            opening_balance = Decimal("0")
            opening_source = "No prior reconciled period on file — opening assumed $0"
        else:
            opening_balance = chosen[1]
            opening_source = f"Rolled forward from {chosen[0].isoformat()} closing subledger"

        # Evidence files (one query per period+account)
        ev_rows = list((await db.execute(
            select(SubledgerEvidence).where(
                SubledgerEvidence.qbo_account_id == qbo_account_id,
                SubledgerEvidence.period_end == pe,
            )
            .order_by(SubledgerEvidence.uploaded_at.desc())
        )).scalars().all())

        # Resolve actor user IDs → human names. Single batched lookup.
        actor_ids: list[_uuid.UUID] = []
        for uid in (
            getattr(review, "prepared_by", None) if review else None,
            getattr(review, "approved_by", None) if review else None,
        ):
            if uid:
                actor_ids.append(uid)
        names_by_id: dict[_uuid.UUID, str] = {}
        if actor_ids:
            user_rows = list((await db.execute(
                select(User).where(User.id.in_(actor_ids))
            )).scalars().all())
            backfill_dirty = False
            for u in user_rows:
                # Always prefer "First Last" from Clerk over the local
                # email — the PDF is a controller-grade working paper,
                # so a real human name on Prepared/Approved By reads
                # better than an email handle. Clerk lookups are
                # TTL-cached (~5 min) so this is cheap on hot paths.
                # Fallback chain: Clerk first+last → Clerk email →
                # local email → UUID stub.
                display: str | None = None
                if u.clerk_user_id:
                    cu = await get_clerk_user(u.clerk_user_id)
                    if cu:
                        # _format_display_name returns "First Last",
                        # else Clerk-side email, else clerk id.
                        display = _format_display_name(cu)
                        # Opportunistically backfill the local email
                        # if Clerk has one we don't.
                        if cu.get("email") and not u.email:
                            u.email = cu["email"]
                            backfill_dirty = True
                if not display:
                    display = u.email or None
                names_by_id[u.id] = display or f"User {str(u.id)[:8]}"
            if backfill_dirty:
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()
                    logger.exception("Backfilling User.email from Clerk failed")

        # Determine if credit-natural for sign-flip on reconciling items.
        credit_natural_types = {
            "Accounts Payable", "Credit Card",
            "Other Current Liability", "Long Term Liability", "Equity",
        }
        is_credit_natural = snap.account_type in credit_natural_types

        # The "subledger balance" used in the dashboard. Manual override
        # (set by user) wins; otherwise it's the rolled-forward opening
        # plus the reconciling items the preparer ticked. This mirrors
        # the dashboard's compute logic so the PDF matches what the
        # user signed off on.
        if review and review.subledger_total is not None:
            subledger_balance = Decimal(review.subledger_total)
        else:
            subledger_balance = opening_balance
            for it in (review.reconciling_items if review else []) or []:
                is_manual = str(it.get("txn_id", "")).startswith("manual-")
                raw = Decimal(str(it.get("amount", "0") or "0"))
                signed = raw if is_manual else ((-1 if is_credit_natural else 1) * raw)
                subledger_balance += signed

        status_str = review.status if review else "pending"
        # An account that's "approved" gets a clean PDF; everything else
        # is a draft (watermarked).
        is_draft = status_str != "approved"

        data = {
            "company":            company,
            "account_number":     snap.account_number or "",
            "account_name":       snap.account_name,
            "account_type":       snap.account_type,
            "period_end":         pe,
            "status":             status_str,
            "gl_balance":         str(snap.balance),
            "subledger_balance":  str(subledger_balance),
            "opening_balance":    str(opening_balance),
            "opening_source":     opening_source,
            "is_credit_natural":  is_credit_natural,
            "reconciling_items":  (review.reconciling_items if review else []) or [],
            "notes":              (review.notes if review else None),
            "prepared_by_name":   (
                names_by_id.get(review.prepared_by) if review and review.prepared_by else None
            ),
            "prepared_at":        (
                review.prepared_at.isoformat() if review and review.prepared_at else None
            ),
            "approved_by_name":   (
                names_by_id.get(review.approved_by) if review and review.approved_by else None
            ),
            "approved_at":        (
                review.approved_at.isoformat() if review and review.approved_at else None
            ),
            "evidence_files":     [
                {
                    "file_name":   e.file_name,
                    "uploaded_at": e.uploaded_at.isoformat() if e.uploaded_at else None,
                }
                for e in ev_rows
            ],
            "is_draft":           is_draft,
            "prepared_by":        user.email or "",
            # AI commentary if this row was AI-prepared. The PDF renderer
            # surfaces it as a section before Notes so the reviewer reads
            # AI's checks and recommendation when reviewing the document.
            "ai_commentary":      (review.ai_commentary if review else None),
        }

        logger.info(
            "Account PDF export: rendering for %s (%s) — %d items, %d files, draft=%s",
            snap.account_name, snap.account_type, len(data["reconciling_items"]),
            len(data["evidence_files"]), is_draft,
        )
        from modules.recons.pdf import build_account_pdf
        buf = io.BytesIO()
        build_account_pdf(buf, data=data)
        buf.seek(0)

        # Build a clean filename: AccountReconciliation_2026-04-30_1010-Cash-Operating.pdf
        safe_name = (
            (snap.account_number + "-" if snap.account_number else "")
            + snap.account_name.replace(" ", "-").replace("/", "-")
        )[:80]
        prefix = "draft-" if is_draft else ""
        fname = f"{prefix}account-reconciliation-{pe.isoformat()}-{safe_name}.pdf"
        logger.info("Account PDF export done: %d bytes", buf.getbuffer().nbytes)
        return StreamingResponse(
            buf, media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Account PDF export failed for tenant=%s qbo_account=%s period=%s",
            tenant_id, qbo_account_id, pe,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Reconciliation PDF generation failed: {type(exc).__name__}: {str(exc)[:200]}",
        ) from exc


@router.post("/account/{qbo_account_id}/status")
async def update_account_review_status(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    status_value: str = Query(..., alias="status", description="pending | reviewed | approved | flagged"),
    notes: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Set the review status for one account+period. Upserts on
    (tenant_id, qbo_account_id, period_end). Audit-logged.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    if status_value not in ("pending", "reviewed", "approved", "flagged"):
        raise HTTPException(status_code=400, detail="Invalid status value.")
    await _block_if_closed(db, pe)

    # Role gate: only reviewer+ can flip to reviewed/approved/flagged.
    # Preparers can only reset to pending (un-do their own work).
    if status_value in ("reviewed", "approved", "flagged"):
        if ROLE_ORDER.get(user.role or "preparer", 0) < ROLE_ORDER["reviewer"]:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Only reviewers and admins can mark accounts as {status_value}. "
                    f"Your role is {user.role or 'preparer'}."
                ),
            )

    row = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end == pe,
        )
    )).scalar_one_or_none()

    # Maker/checker: a manual subledger override cannot be approved by
    # the same user who entered it. Self-approval defeats the whole point
    # of the control. Preparer enters → independent reviewer approves.
    # ADMINS BYPASS this rule — they have master access and can override
    # any policy when the workflow demands it (e.g. solo bookkeepers,
    # urgent close at end of period).
    if (
        status_value == "approved"
        and user.role != "admin"
        and row is not None
        and row.subledger_total is not None
        and row.subledger_entered_by is not None
        and row.subledger_entered_by == user.id
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                "You entered the manual subledger for this account — "
                "approval must come from a different user (maker/checker control). "
                "Admins can bypass this rule."
            ),
        )

    if row is None:
        row = AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qbo_account_id,
            period_end=pe,
            status=status_value,
            reviewed_by=user.id if status_value != "pending" else None,
            reviewed_at=datetime.now(UTC) if status_value != "pending" else None,
            notes=notes,
        )
        db.add(row)
    else:
        row.status = status_value
        row.reviewed_by = user.id if status_value != "pending" else None
        row.reviewed_at = datetime.now(UTC) if status_value != "pending" else None
        if notes is not None:
            row.notes = notes

    # Stamp preparer / reviewer separately so the Tasks UI can show
    # both actors. Reset-to-pending IS a clearing action though —
    # it should clear all the work (subledger override, ticked items,
    # actor stamps) so the next preparer starts fresh.
    now = datetime.now(UTC)
    if status_value == "reviewed":
        row.prepared_by = user.id
        row.prepared_at = now
    elif status_value == "approved":
        # Approving promotes through prepared. If no prepared stamp
        # exists yet (admin skipped straight to approved), record this
        # user as the preparer too so the audit trail is complete.
        if not row.prepared_by:
            row.prepared_by = user.id
            row.prepared_at = now
        row.approved_by = user.id
        row.approved_at = now
    elif status_value == "pending":
        # Reset = start over. Drop subledger override + ticked items
        # and wipe actor stamps. Matches the bulk endpoint.
        row.subledger_total = None
        row.subledger_source = None
        row.subledger_entered_by = None
        row.subledger_entered_at = None
        row.reconciling_items = []
        row.prepared_by = None
        row.prepared_at = None
        row.approved_by = None
        row.approved_at = None
        # Freeze the displayed subledger value if one isn't already
        # saved. Without this, an account can be approved with the
        # dashboard's defaulted display value (rolled-forward or
        # GL-match) but no subledger_total stored — which breaks the
        # close-and-roll chain for downstream periods because the
        # picker only looks at rows where subledger_total IS NOT NULL.
        if row.subledger_total is None:
            await _freeze_displayed_subledger(
                db, tenant_id, qbo_account_id, pe, row, user,
            )

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"recon.account_{status_value}",
        entity_type="account_review_status", entity_id=row.id,
        metadata={
            "summary": f"Set account {qbo_account_id} ({period_end}) → {status_value}",
            "qbo_account_id": qbo_account_id,
            "period_end": period_end,
        },
    )
    await db.commit()
    return {
        "qbo_account_id": qbo_account_id,
        "period_end":     period_end,
        "status":         row.status,
        "reviewed_by":    str(row.reviewed_by) if row.reviewed_by else None,
        "reviewed_at":    row.reviewed_at.isoformat() if row.reviewed_at else None,
    }


@router.post("/account/bulk-status")
async def bulk_update_account_review_status(
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Upsert review status for a batch of accounts at the same period.
    Body shape:
      { period_end: "2026-04-30", status: "approved", qbo_account_ids: ["123","124"] }
    Returns the count updated. Audit-logged once for the batch.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(body.get("period_end", ""))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    status_value = body.get("status")
    if status_value not in ("pending", "reviewed", "approved", "flagged"):
        raise HTTPException(status_code=400, detail="Invalid status value.")
    ids: list[str] = list(body.get("qbo_account_ids") or [])
    if not ids:
        raise HTTPException(status_code=400, detail="qbo_account_ids required.")
    await _block_if_closed(db, pe)

    # Role gate — same rules as the per-row endpoint.
    if status_value in ("reviewed", "approved", "flagged"):
        if ROLE_ORDER.get(user.role or "preparer", 0) < ROLE_ORDER["reviewer"]:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Only reviewers and admins can bulk-set {status_value}. "
                    f"Your role is {user.role or 'preparer'}."
                ),
            )

    existing = list((await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.period_end == pe,
            AccountReviewStatus.qbo_account_id.in_(ids),
        )
    )).scalars().all())
    by_id = {r.qbo_account_id: r for r in existing}

    # Maker/checker — block bulk approval of any account whose override the
    # current user entered. Bulk action either fully succeeds or fails as a
    # set, so we surface every conflict in the error message.
    # Admins bypass the rule (master access).
    if status_value == "approved" and user.role != "admin":
        own_overrides = [
            qid for qid, r in by_id.items()
            if r.subledger_total is not None
            and r.subledger_entered_by is not None
            and r.subledger_entered_by == user.id
        ]
        if own_overrides:
            raise HTTPException(
                status_code=403,
                detail=(
                    "You entered the manual subledger for "
                    f"{len(own_overrides)} account(s) in this batch — "
                    "approval must come from a different user (maker/checker). "
                    f"Conflicting account IDs: {', '.join(own_overrides)}."
                ),
            )

    now = datetime.now(UTC)
    is_reviewed = status_value != "pending"
    # Same prep/approve stamping rule as the per-row endpoint:
    # promote-only, never clear, and approve cascades through prepare
    # if prepare hasn't happened yet.
    rows_for_freeze: list[tuple[str, AccountReviewStatus]] = []
    for qid in ids:
        if qid in by_id:
            r = by_id[qid]
            r.status = status_value
            r.reviewed_by = user.id if is_reviewed else None
            r.reviewed_at = now if is_reviewed else None
            if status_value == "reviewed":
                r.prepared_by = user.id
                r.prepared_at = now
            elif status_value == "approved":
                if not r.prepared_by:
                    r.prepared_by = user.id
                    r.prepared_at = now
                r.approved_by = user.id
                r.approved_at = now
                rows_for_freeze.append((qid, r))
            elif status_value == "pending":
                # Reset to pending = start over. Untick reconciling items,
                # drop any saved subledger override, and wipe maker/checker
                # stamps so the next preparer starts from a clean slate.
                r.subledger_total = None
                r.subledger_source = None
                r.subledger_entered_by = None
                r.subledger_entered_at = None
                r.reconciling_items = []
                r.prepared_by = None
                r.prepared_at = None
                r.approved_by = None
                r.approved_at = None
        else:
            r = AccountReviewStatus(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                qbo_account_id=qid,
                period_end=pe,
                status=status_value,
                reviewed_by=user.id if is_reviewed else None,
                reviewed_at=now if is_reviewed else None,
                prepared_by=user.id if status_value in ("reviewed", "approved") else None,
                prepared_at=now      if status_value in ("reviewed", "approved") else None,
                approved_by=user.id if status_value == "approved" else None,
                approved_at=now      if status_value == "approved" else None,
            )
            db.add(r)
            if status_value == "approved":
                rows_for_freeze.append((qid, r))

    # Freeze the dashboard's displayed subledger onto every row being
    # approved that doesn't already have one — same close-and-roll
    # safety net as the per-row endpoint. Without this, bulk-approving
    # a batch of accounts leaves subledger_total NULL and the next
    # period's opening fails to roll forward properly.
    for qid, r in rows_for_freeze:
        if r.subledger_total is None:
            await _freeze_displayed_subledger(
                db, tenant_id, qid, pe, r, user,
            )

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"recon.bulk_{status_value}",
        entity_type="account_review_status", entity_id=None,
        metadata={
            "summary": f"Bulk set {len(ids)} accounts → {status_value} for {body.get('period_end')}",
            "count": len(ids),
            "status": status_value,
        },
    )
    await db.commit()
    return {"updated": len(ids), "status": status_value}


@router.post("/account/{qbo_account_id}/subledger")
async def set_account_subledger_override(
    qbo_account_id: str,
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Set or clear the manual subledger override for one account+period.

    Body shape:
      { period_end: "2026-04-30",
        total: 45000.00 | null,  // null clears the override
        source: "Bank statement 4/30" | null }

    When `total` is set, the live overview uses it as the subledger balance
    for this account+period and recomputes variance accordingly. Useful for
    Bank / Fixed Asset / Prepaid / Loan accounts where QBO has no separate
    subledger to compare against.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(str(body.get("period_end", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    await _block_if_closed(db, pe)

    total_raw = body.get("total")
    source = body.get("source")
    # Optional reconciling items — list of {txn_id, txn_type, txn_number,
    # txn_date, amount, memo}. Sum of selected items is expected to equal
    # the GL−Subledger variance for the account to be "tied out".
    reconciling_items = body.get("reconciling_items") or []
    if not isinstance(reconciling_items, list):
        raise HTTPException(status_code=400, detail="reconciling_items must be a list.")

    if total_raw is not None:
        try:
            total = Decimal(str(total_raw))
        except (ValueError, ArithmeticError):
            raise HTTPException(status_code=400, detail="total must be numeric or null.")
    else:
        total = None

    row = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end == pe,
        )
    )).scalar_one_or_none()

    now = datetime.now(UTC)
    if row is None:
        row = AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qbo_account_id,
            period_end=pe,
            status="pending",
            subledger_total=total,
            subledger_source=source,
            subledger_entered_by=user.id if total is not None else None,
            subledger_entered_at=now if total is not None else None,
            reconciling_items=reconciling_items if total is not None else [],
        )
        db.add(row)
    else:
        row.subledger_total = total
        row.subledger_source = source if total is not None else None
        row.subledger_entered_by = user.id if total is not None else None
        row.subledger_entered_at = now if total is not None else None
        # When the override is cleared we wipe the reconciling items too —
        # they only make sense in the context of a manual subledger.
        row.reconciling_items = reconciling_items if total is not None else []

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.subledger_override_set" if total is not None else "recon.subledger_override_cleared",
        entity_type="account_review_status", entity_id=row.id,
        metadata={
            "summary": (
                f"Set subledger override for account {qbo_account_id} ({pe}) → ${total}"
                if total is not None
                else f"Cleared subledger override for account {qbo_account_id} ({pe})"
            ),
            "qbo_account_id": qbo_account_id,
            "period_end": body.get("period_end"),
            "source": source,
        },
    )
    await db.commit()
    return {
        "qbo_account_id": qbo_account_id,
        "period_end":     body.get("period_end"),
        "subledger_total":  str(total) if total is not None else None,
        "subledger_source": source if total is not None else None,
        "is_manual":      total is not None,
    }


# ── Freeze displayed subledger when approval lands ──────────────────────────

# Account types that carry credit-natural balances. QBO returns their
# transaction amounts positive even though the GL balance is negative —
# we flip the sign so the close-and-roll math reads correctly. Same
# list as overview / agentic / pdf modules.
_CREDIT_NATURAL_ACCOUNT_TYPES = {
    "Accounts Payable", "Credit Card",
    "Other Current Liability", "Long Term Liability", "Equity",
}


async def _freeze_displayed_subledger(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    qbo_account_id: str,
    period_end: date,
    row,                # AccountReviewStatus — mutated in place
    user,               # CurrentUser
) -> None:
    """
    Save the dashboard's currently-displayed subledger value onto the
    review row so the close-and-roll chain has data to roll forward.

    Without this, an account approved against its DEFAULT displayed
    subledger (no manual override entered) keeps subledger_total = NULL
    — which makes the picker for the next period skip this row entirely
    and roll from whatever older period DOES have a subledger_total.
    The "Feb closed but April still rolls from Jan 30" bug.

    Compute logic mirrors the dashboard:
      1. If a manual override exists → already saved, nothing to do
         (caller already checked this — we only get here when
         subledger_total IS NULL).
      2. Else opening = prior reconciled subledger ($0 if none).
      3. Plus signed sum of this period's reconciling items.
      4. If no prior + no items → fall back to GL balance (matches the
         dashboard's default for Bank/Other accounts; AR/AP also OK as a
         starting point, the user can override later if they need to
         break it down via aging).
    """
    from models.gl_balance_snapshot import GlBalanceSnapshot

    # Account meta for sign-flip
    snap = (await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.qbo_account_id == qbo_account_id,
            GlBalanceSnapshot.period_end == period_end,
        )
    )).scalar_one_or_none()
    if snap is None:
        # No snapshot — nothing to freeze. Should be rare since approval
        # implies the account showed up in the overview.
        logger.warning(
            "Freeze subledger: no GL snapshot for account %s @ %s — skipping",
            qbo_account_id, period_end,
        )
        return

    is_credit_natural = snap.account_type in _CREDIT_NATURAL_ACCOUNT_TYPES
    flip = -1 if is_credit_natural else 1

    # Prior reconciled subledger → opening
    prior = (await db.execute(
        select(AccountReviewStatus)
        .where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end < period_end,
            AccountReviewStatus.subledger_total.is_not(None),
        )
        .order_by(AccountReviewStatus.period_end.desc())
        .limit(1)
    )).scalar_one_or_none()

    has_prior = prior is not None and prior.subledger_total is not None
    opening = Decimal(prior.subledger_total) if has_prior else Decimal("0")

    # Signed sum of any existing reconciling items
    items = (row.reconciling_items if row else []) or []
    items_sum = Decimal("0")
    for it in items:
        is_manual = str(it.get("txn_id", "")).startswith("manual-")
        raw = Decimal(str(it.get("amount", "0") or "0"))
        items_sum += raw if is_manual else flip * raw

    # If we have neither a prior NOR items, fall back to GL — keeps
    # the variance = 0 default behavior the dashboard already shows
    # for Bank/Other accounts that are auto-matched to GL.
    if not has_prior and not items:
        frozen = Decimal(snap.balance)
        source = "Auto-saved on approval (matches GL — no prior reconciliation on file)"
    else:
        frozen = opening + items_sum
        if has_prior:
            source = (
                f"Auto-saved on approval: opening {_fmt_money_simple(opening)} "
                f"(rolled from {prior.period_end.isoformat()}) + "
                f"{len(items)} reconciling item{'' if len(items) == 1 else 's'} "
                f"= {_fmt_money_simple(frozen)}"
            )
        else:
            source = (
                f"Auto-saved on approval: {len(items)} reconciling item"
                f"{'' if len(items) == 1 else 's'} totaling "
                f"{_fmt_money_simple(frozen)} (no prior period on file)"
            )

    now = datetime.now(UTC)
    row.subledger_total = frozen.quantize(Decimal("0.01"))
    row.subledger_source = source
    row.subledger_entered_by = user.id
    row.subledger_entered_at = now
    logger.info(
        "Froze subledger on approval: account=%s period=%s value=%s",
        qbo_account_id, period_end, row.subledger_total,
    )


def _fmt_money_simple(v: Decimal) -> str:
    """Compact $-format used in audit-trail source strings."""
    sign = -1 if v < 0 else 1
    n = f"{abs(v).quantize(Decimal('0.01')):,.2f}"
    return f"$({n})" if sign < 0 else f"${n}"


# ── Close / re-open period (lock the books) ─────────────────────────────────

async def _is_period_closed(db: AsyncSession, period_end: date) -> ClosedPeriod | None:
    """Return the ClosedPeriod row if this period is currently locked."""
    return (await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end == period_end)
    )).scalar_one_or_none()


async def _block_if_closed(db: AsyncSession, period_end: date) -> None:
    """
    Raise 423 (Locked) if the given period is closed. Used by every
    mutation endpoint so reviewers/preparers can't edit a closed period.
    Admins also hit this — they must reopen first if they want to edit.
    """
    cp = await _is_period_closed(db, period_end)
    if cp is not None:
        raise HTTPException(
            status_code=423,  # Locked
            detail=(
                f"Books are closed for period {period_end}. "
                "An admin must reopen the period before edits are allowed."
            ),
        )


@router.get("/admin/periods")
async def list_periods_tracker(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Month-end close tracker: returns one entry per month-end date from
    the books start through the current month, with:
      - total accounts that have a review row
      - status counts (pending / reviewed / approved / flagged)
      - closed flag + close date if locked
      - simple progress percentage

    The dashboard renders these as a horizontal timeline so the user can
    see at a glance which months are open, in progress, or closed.
    """
    from calendar import monthrange
    from datetime import date as _date

    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t is None or t.books_start_date is None:
        return {"periods": []}

    # Generate month-end dates from books_start month through the current month.
    today = _date.today()
    cur = _date(t.books_start_date.year, t.books_start_date.month, 1)
    month_ends: list[_date] = []
    while cur <= today.replace(day=1):
        last_day = monthrange(cur.year, cur.month)[1]
        month_ends.append(_date(cur.year, cur.month, last_day))
        # advance one month
        if cur.month == 12:
            cur = _date(cur.year + 1, 1, 1)
        else:
            cur = _date(cur.year, cur.month + 1, 1)

    # Bulk-load all review + closed-period rows in two queries so we don't
    # do N+1 lookups.
    review_rows = list((await db.execute(
        select(AccountReviewStatus).where(AccountReviewStatus.period_end.in_(month_ends))
    )).scalars().all())
    closed_rows = list((await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end.in_(month_ends))
    )).scalars().all())
    closed_by_pe: dict[_date, ClosedPeriod] = {c.period_end: c for c in closed_rows}

    # Index review rows by period_end + status
    by_pe: dict[_date, list[AccountReviewStatus]] = {}
    for r in review_rows:
        by_pe.setdefault(r.period_end, []).append(r)

    out = []
    for pe in month_ends:
        rows = by_pe.get(pe, [])
        # Don't surface the seed-date row as a "real" period
        if pe < t.books_start_date:
            continue
        cnt = {"pending": 0, "reviewed": 0, "approved": 0, "flagged": 0}
        for r in rows:
            cnt[r.status if r.status in cnt else "pending"] += 1
        total = sum(cnt.values())
        closed = closed_by_pe.get(pe)
        # Workflow status:
        #   closed         → books locked
        #   complete       → all accounts approved but not yet closed
        #   in_progress    → some activity
        #   not_started    → no review rows yet
        if closed:
            wf_status = "closed"
        elif total > 0 and cnt["approved"] == total:
            wf_status = "complete"
        elif total > 0:
            wf_status = "in_progress"
        else:
            wf_status = "not_started"

        out.append({
            "period_end": pe.isoformat(),
            "label":      pe.strftime("%b %Y"),
            "status":     wf_status,
            "counts":     cnt,
            "total":      total,
            "approved_pct": (cnt["approved"] / total * 100) if total else 0,
            "closed_by":  str(closed.closed_by) if closed else None,
            "closed_at":  closed.closed_at.isoformat() if closed and closed.closed_at else None,
        })
    return {
        "books_start_date": t.books_start_date.isoformat(),
        "periods":          out,
    }


@router.get("/admin/closed-periods")
async def list_closed_periods(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return every currently-closed period for this workspace."""
    rows = list((await db.execute(
        select(ClosedPeriod).order_by(desc(ClosedPeriod.period_end))
    )).scalars().all())
    return {
        "periods": [
            {
                "period_end": r.period_end.isoformat(),
                "closed_by":  str(r.closed_by),
                "closed_at":  r.closed_at.isoformat() if r.closed_at else None,
                "notes":      r.notes,
            }
            for r in rows
        ],
    }


@router.post("/admin/close-period", dependencies=[Depends(require_role("admin"))])
async def close_period(
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Admin-only: lock a reconciliation period. Requires every visible
    balance-sheet account to be approved first — anything still pending,
    reviewed, or flagged blocks the close (the response lists the offenders).

    Body: { period_end: "YYYY-MM-DD", notes?: string }
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(str(body.get("period_end", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    # Idempotency — already closed
    existing = await _is_period_closed(db, pe)
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Period {pe} is already closed by another admin.",
        )

    # Sequential-close gate — closes must happen in order. If ANY earlier
    # period (after books_start) has open work AND isn't already closed,
    # block this close until those finish first. Prevents skipping a
    # month, which is a common accounting compliance issue.
    blockers = await _find_unclosed_prior_periods(db, tenant_id, pe)
    if blockers:
        # Friendly labels like "Apr 2026, Mar 2026" instead of raw dates.
        labels = ", ".join(
            b["period_end"].strftime("%b %Y") + (
                f" ({b['unapproved']} open)" if b["unapproved"] > 0 else " (no work started)"
            )
            for b in blockers[:5]
        )
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot close {pe.strftime('%b %Y')} — earlier periods are still open. "
                f"Close them in order first: {labels}"
                + ("…" if len(blockers) > 5 else "")
            ),
        )

    # Pull every review row for the period; require ALL to be approved.
    status_rows = list((await db.execute(
        select(AccountReviewStatus).where(AccountReviewStatus.period_end == pe)
    )).scalars().all())
    unapproved = [r for r in status_rows if r.status != "approved"]
    if unapproved:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot close — {len(unapproved)} account(s) are not approved: "
                + ", ".join(r.qbo_account_id for r in unapproved[:10])
                + (" …" if len(unapproved) > 10 else "")
            ),
        )

    # We also require that at least one approved row exists — closing a
    # period with zero reviewed accounts is almost always a mistake.
    if not status_rows:
        raise HTTPException(
            status_code=409,
            detail=(
                f"No accounts have been reviewed for {pe}. "
                "Reconcile and approve every account before closing the books."
            ),
        )

    # Flux gate — every flux analysis whose `period_current` falls in
    # the closing month must be approved. AND there must be at least
    # one flux analysis for the month. Matches the user-side close
    # ceremony: variance analysis is a required part of every month-
    # end close, not an optional add-on. Without this, an admin could
    # lock the books while a P&L variance review was still pending
    # sign-off, defeating the audit trail.
    from models.trial_balance import TrialBalance
    _first = pe.replace(day=1)
    flux_rows = list((await db.execute(
        select(TrialBalance).where(
            TrialBalance.period_current >= _first,
            TrialBalance.period_current <= pe,
        )
    )).scalars().all())
    if not flux_rows:
        raise HTTPException(
            status_code=409,
            detail=(
                f"No flux analysis has been run for {pe.strftime('%b %Y')}. "
                "Open Flux Analysis, generate one for this month, and approve "
                "it before closing the books."
            ),
        )
    unapproved_flux = [tb for tb in flux_rows if tb.approved_by is None]
    if unapproved_flux:
        names = ", ".join((tb.name or f"Analysis {str(tb.id)[:8]}") for tb in unapproved_flux[:5])
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot close — {len(unapproved_flux)} flux analysis"
                f"{'es' if len(unapproved_flux) != 1 else ''} for "
                f"{pe.strftime('%b %Y')} still need approval: {names}"
                + ("…" if len(unapproved_flux) > 5 else "")
            ),
        )

    # Backfill: freeze subledger_total on any approved row that still
    # has NULL. This catches legacy data (rows approved before the
    # auto-save-on-approval landed) and guarantees that every closed
    # period contributes to the close-and-roll chain. Without this,
    # downstream periods could skip a closed prior because its rows
    # have approved status but no saved subledger value.
    backfilled = 0
    for r in status_rows:
        if r.subledger_total is None:
            await _freeze_displayed_subledger(
                db, tenant_id, r.qbo_account_id, pe, r, user,
            )
            backfilled += 1
    if backfilled:
        logger.info(
            "Close-period backfilled subledger_total on %d account(s) for %s",
            backfilled, pe,
        )

    row = ClosedPeriod(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        period_end=pe,
        closed_by=user.id,
        notes=(body.get("notes") or None),
    )
    db.add(row)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.period_closed",
        entity_type="closed_period", entity_id=row.id,
        metadata={
            "summary":    f"Closed period {pe} ({len(status_rows)} accounts, "
                          f"{backfilled} subledger value(s) auto-saved)",
            "period_end": pe.isoformat(),
            "count":      len(status_rows),
            "backfilled": backfilled,
        },
    )
    await db.commit()
    return {
        "period_end": pe.isoformat(),
        "closed_at":  row.closed_at.isoformat() if row.closed_at else None,
        "closed_by":  str(row.closed_by),
    }


@router.post("/admin/reopen-period", dependencies=[Depends(require_role("admin"))])
async def reopen_period(
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Admin-only: unlock a previously closed period so admins/reviewers can
    edit again. Audit-logged so the reopen is visible in the activity feed.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(str(body.get("period_end", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    row = await _is_period_closed(db, pe)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Period {pe} is not closed.")

    await db.delete(row)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.period_reopened",
        entity_type="closed_period", entity_id=row.id,
        metadata={
            "summary":    f"Reopened period {pe}",
            "period_end": pe.isoformat(),
        },
    )
    await db.commit()
    return {"period_end": pe.isoformat(), "status": "reopened"}


# ── Books-start onboarding (one-time seed of opening balances) ───────────────

@router.get("/setup/books-status")
async def get_books_status(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Has this tenant completed the books-start onboarding step? Returns
    `books_start_date` (or null) and a `seeded` flag the frontend gate
    uses to decide whether to redirect to the wizard.
    """
    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    return {
        "books_start_date": t.books_start_date.isoformat() if t.books_start_date else None,
        "seeded":           t.books_seeded_at is not None,
        "seeded_at":        t.books_seeded_at.isoformat() if t.books_seeded_at else None,
    }


@router.get("/setup/seed-preview", dependencies=[Depends(require_role("admin"))])
async def get_seed_preview(
    tenant_id: CurrentTenantId,
    books_start: str = Query(..., description="Books start date YYYY-MM-DD (first period the company reconciles)"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Pull the QBO trial balance as of (books_start - 1 day) and return one
    row per balance-sheet account with the GL balance as the proposed
    opening subledger. The frontend wizard lets the user edit each row
    before committing via POST /seed.

    Admin-only — preview is part of the one-time onboarding flow that
    seeds opening balances for the entire workspace. The corresponding
    commit endpoint (/setup/seed) is already admin-gated; gating the
    preview too keeps the whole wizard behind the admin check.
    """
    from datetime import date as _date
    from datetime import timedelta as _td
    try:
        bs = _date.fromisoformat(books_start)
    except ValueError:
        raise HTTPException(status_code=400, detail="books_start must be YYYY-MM-DD.")

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    # Use the existing overview machinery to enumerate balance-sheet accounts.
    # When QBO calls fail (expired token, network blip), we want the user to
    # see *what* went wrong instead of an empty list with no explanation —
    # so we re-do the calls without their try/except wrappers and propagate
    # any HTTPException up to a 502.
    from modules.recons.overview import (
        ACCOUNT_TYPE_GROUPS,
    )
    from modules.recons.service import _qbo_get
    seed_date = bs - _td(days=1)

    # Direct account list fetch (no swallowed exception)
    types = list(ACCOUNT_TYPE_GROUPS.keys())
    quoted = ", ".join(f"'{t}'" for t in types)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType, CurrentBalance "
        f"FROM Account WHERE AccountType IN ({quoted}) AND Active = true "
        f"MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, db, "/query", params={"query": q, "minorversion": "65"})
    except Exception as e:
        logger.exception("Seed-preview account list failed")
        raise HTTPException(
            status_code=502,
            detail=(
                f"Could not fetch accounts from QuickBooks ({e}). "
                "Try reconnecting QuickBooks from Connections, then come back here."
            ),
        )
    accounts_meta = data.get("QueryResponse", {}).get("Account", []) or []

    if not accounts_meta:
        # Empty list but no error — usually means a brand-new / wiped sandbox.
        return {
            "books_start": bs.isoformat(),
            "seed_date":   seed_date.isoformat(),
            "accounts":    [],
            "warning":     "QuickBooks returned zero active balance-sheet accounts for this company.",
        }

    # Pull + parse via the canonical core.qbo_tb helper so this endpoint
    # uses IDENTICAL fetch parameters and parsing logic as the rest of the
    # app (recons overview, flux analysis). Any future improvement to TB
    # accuracy ripples to every consumer automatically.
    from core.qbo_tb import fetch_trial_balance, parse_trial_balance
    try:
        tb_report = await fetch_trial_balance(conn, seed_date)
    except Exception as e:
        logger.exception("Seed-preview TrialBalance pull failed")
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch trial balance from QuickBooks ({e}).",
        )
    tb = parse_trial_balance(tb_report)
    tb_by_id   = tb["by_id"]
    tb_by_name = tb["by_name"]

    # Count P&L accounts we're skipping so the wizard can explain the
    # difference between QBO's TB account count (BS + PL) and our books-
    # setup count (BS only — P&L accounts always open at $0 each year).
    _PL_TYPES = {"Income", "Other Income", "Expense", "Other Expense", "Cost of Goods Sold"}
    pl_count = sum(1 for a in accounts_meta if a.get("AccountType") in _PL_TYPES)

    rows = []
    misses: list[str] = []
    for a in accounts_meta:
        acct_type = a.get("AccountType", "")
        if acct_type not in ACCOUNT_TYPE_GROUPS:
            continue
        acct_id  = str(a.get("Id") or "")
        name     = str(a.get("Name") or "").strip()
        acct_num = str(a.get("AcctNum") or "").strip()

        # Try id, then several name variants. Prefer NUMBER match when present.
        gl: Decimal | None = None
        if acct_id and acct_id in tb_by_id:
            gl = tb_by_id[acct_id]
        elif acct_num and acct_num in tb_by_name:
            gl = tb_by_name[acct_num]
        else:
            for k in [
                f"{acct_num} {name}".strip(),
                name,
                f"{name} ({acct_num})".strip() if acct_num else "",
                name.split(":")[-1].strip() if ":" in name else "",
            ]:
                if k and k in tb_by_name:
                    gl = tb_by_name[k]
                    break

        if gl is None:
            gl = Decimal("0")
            misses.append(f"{acct_num or '—'} {name}")

        rows.append({
            "qbo_id":           acct_id,
            "account_number":   acct_num,
            "account_name":     name,
            "account_type":     acct_type,
            "group_label":      ACCOUNT_TYPE_GROUPS[acct_type],
            "proposed_opening": str(gl.quantize(Decimal("0.01"))),
            "is_unmatched":     gl == Decimal("0") and any(name.lower() in n.lower() for n in misses),
        })
    rows.sort(key=lambda r: (r["group_label"], r["account_number"]))

    warning_msg = None
    if misses:
        logger.warning("Seed-preview matched 0 for %d accounts: %s", len(misses), misses[:10])
        warning_msg = (
            f"{len(misses)} account(s) did not have a balance in the "
            f"QuickBooks TrialBalance report on {seed_date}: "
            f"{', '.join(misses[:5])}{'…' if len(misses) > 5 else ''}. "
            "Edit those rows manually in the next step."
        )

    return {
        "books_start":     bs.isoformat(),
        "seed_date":       seed_date.isoformat(),
        "accounts":        rows,
        "warning":         warning_msg,
        # P&L accounts in QBO (Income / Expense / COGS) always open at $0
        # at the start of a fiscal year, so we don't seed them. Surface
        # the count so the wizard can explain "you saw N more accounts
        # in your QBO TB" without it looking like a bug.
        "skipped_pl_count": pl_count,
        "diagnostics": {
            "tb_rows":   len(tb_by_id),
            "tb_names":  list(tb_by_name.keys())[:30],
            "misses":    misses[:20],
        },
    }


@router.post("/setup/seed", dependencies=[Depends(require_role("admin"))])
async def seed_books(
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Commit the books-start setup. Writes `books_start_date` on the tenant
    and creates one AccountReviewStatus row per account with
    period_end = books_start - 1 day and the entered opening as the
    subledger_total. Once set, the wizard won't run again (admin re-seed
    is a roadmap item).

    Body shape:
      { "books_start": "2026-04-01",
        "accounts": [
          { "qbo_id": "12", "opening_balance": "10000.00",
            "source_note": "GL on 3/31" }, ... ] }
    """
    from datetime import date as _date
    from datetime import timedelta as _td

    try:
        bs = _date.fromisoformat(str(body.get("books_start", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="books_start must be YYYY-MM-DD.")
    accounts = body.get("accounts") or []
    if not isinstance(accounts, list) or not accounts:
        raise HTTPException(status_code=400, detail="At least one account opening is required.")

    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="Tenant not found.")
    if t.books_seeded_at is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Books already seeded on "
                f"{t.books_seeded_at.date().isoformat()} with start date "
                f"{t.books_start_date.isoformat() if t.books_start_date else 'unknown'}. "
                "Re-seeding requires admin reset (roadmap)."
            ),
        )

    seed_date = bs - _td(days=1)
    now = datetime.now(UTC)

    # Replace any pre-existing review rows at this seed_date for safety —
    # tenant-scoped delete then bulk insert. (Pre-seed values shouldn't
    # exist, but be defensive in case someone manually wrote one.)
    await db.execute(
        delete(AccountReviewStatus).where(AccountReviewStatus.period_end == seed_date)
    )

    count = 0
    for entry in accounts:
        qid = str(entry.get("qbo_id", "")).strip()
        raw = entry.get("opening_balance")
        if not qid or raw is None:
            continue
        try:
            total = Decimal(str(raw))
        except (ValueError, ArithmeticError):
            raise HTTPException(
                status_code=400,
                detail=f"Opening balance for account {qid} is not numeric.",
            )
        note = (entry.get("source_note") or f"Seeded opening on {seed_date}")[:255]
        db.add(AccountReviewStatus(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qid,
            period_end=seed_date,
            status="approved",  # opening balances are committed, not pending
            subledger_total=total,
            subledger_source=note,
            subledger_entered_by=user.id,
            subledger_entered_at=now,
            reviewed_by=user.id,
            reviewed_at=now,
        ))
        count += 1

    t.books_start_date = bs
    t.books_seeded_at = now

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.books_seeded",
        entity_type="tenant", entity_id=tenant_id,
        metadata={
            "summary":     f"Seeded books with start={bs} across {count} accounts",
            "books_start": bs.isoformat(),
            "count":       count,
        },
    )
    await db.commit()
    return {
        "books_start_date": bs.isoformat(),
        "seed_date":        seed_date.isoformat(),
        "accounts_seeded":  count,
    }


# Helper used by every period-scoped endpoint below to enforce the floor.
async def _enforce_books_floor(db: AsyncSession, tenant_id: uuid.UUID, period_end: 'date | None') -> None:
    """Raise 400 if period_end is earlier than the tenant's books_start_date."""
    if period_end is None:
        return
    t = (await db.execute(
        select(Tenant.books_start_date).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t and period_end < t:
        raise HTTPException(
            status_code=400,
            detail=(
                f"period_end {period_end} is before the books start date {t}. "
                "Reconciliations cannot reference periods before books were set up."
            ),
        )


async def _find_unclosed_prior_periods(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    period_end: 'date',
) -> list[dict]:
    """
    Sequential-close gate: returns every month-end between books_start
    and `period_end` (exclusive) that has open work AND isn't already
    closed. Empty list means it's safe to close `period_end`.

    "Open work" = any AccountReviewStatus row in that period whose
    status is not 'approved'. Periods with zero rows AND no close
    record are also flagged (the user skipped the month).
    """
    from calendar import monthrange
    from datetime import date as _date

    t = (await db.execute(
        select(Tenant.books_start_date).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if t is None:
        # No books_start set → nothing to gate against. The wizard will
        # have blocked the user well before this point.
        return []

    # Enumerate month-ends from books_start through the month BEFORE
    # period_end (we're checking PRIOR periods, not the one being closed).
    cur = _date(t.year, t.month, 1)
    prior_month_ends: list[_date] = []
    while cur < _date(period_end.year, period_end.month, 1):
        last_day = monthrange(cur.year, cur.month)[1]
        me = _date(cur.year, cur.month, last_day)
        if me >= t:
            prior_month_ends.append(me)
        if cur.month == 12:
            cur = _date(cur.year + 1, 1, 1)
        else:
            cur = _date(cur.year, cur.month + 1, 1)
    if not prior_month_ends:
        return []

    # Bulk-load review + close rows for those periods.
    review_rows = list((await db.execute(
        select(AccountReviewStatus)
        .where(AccountReviewStatus.period_end.in_(prior_month_ends))
    )).scalars().all())
    closed_rows = list((await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end.in_(prior_month_ends))
    )).scalars().all())
    closed_set = {c.period_end for c in closed_rows}

    by_pe: dict[_date, list[AccountReviewStatus]] = {}
    for r in review_rows:
        by_pe.setdefault(r.period_end, []).append(r)

    blockers: list[dict] = []
    for pe in prior_month_ends:
        if pe in closed_set:
            continue  # Closed periods are settled, never a blocker.
        rows = by_pe.get(pe, [])
        unapproved = [r for r in rows if r.status != "approved"]
        if rows and not unapproved:
            # All approved but not yet closed — that's a "ready to close"
            # not a blocker. Don't list it as a blocker; the admin can
            # close it whenever. Same convention as the tracker's
            # "complete" status.
            continue
        # Either has open work, or has zero rows (skipped month). Either
        # way, it needs attention before the user closes `period_end`.
        blockers.append({"period_end": pe, "unapproved": len(unapproved)})
    return blockers


@router.get("/account/{qbo_account_id}/prior-override")
async def get_prior_period_override(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Current period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Find the most recent prior period (< period_end) where this account had
    a manual subledger value entered. Used to roll forward — the prior
    closing becomes context for the new period: user sees the starting
    point, the delta they're declaring, and can copy-as-starting-point with
    one click.

    Returns the prior row's value, source, period_end and evidence count.
    `null` for `prior` when this is the first period with an override.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    row = (await db.execute(
        select(AccountReviewStatus)
        .where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end < pe,
            AccountReviewStatus.subledger_total.is_not(None),
        )
        .order_by(desc(AccountReviewStatus.period_end))
        .limit(1)
    )).scalar_one_or_none()

    if row is None:
        return {"prior": None}

    ev_count = (await db.execute(
        select(func.count(SubledgerEvidence.id)).where(
            SubledgerEvidence.qbo_account_id == qbo_account_id,
            SubledgerEvidence.period_end == row.period_end,
        )
    )).scalar_one()

    return {
        "prior": {
            "period_end":       row.period_end.isoformat(),
            "subledger_total":  str(row.subledger_total),
            "subledger_source": row.subledger_source,
            "status":           row.status,
            "evidence_count":   int(ev_count or 0),
        }
    }


@router.get("/account/{qbo_account_id}/period-entries")
async def get_account_period_entries(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return every transaction posted to this account WITHIN the closing
    period (the month containing period_end). Used inside the manual
    subledger modal so the user can select which entries explain the
    GL-vs-subledger variance — the classic bank-rec "outstanding items"
    pattern, persisted on the override row.

    Falls through to an empty list (not 404) when QBO isn't connected so
    the modal UI degrades gracefully.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    # Month containing period_end. Most close cycles are monthly so this
    # gives the user the activity they're closing against.
    period_start = pe.replace(day=1)

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        return {"rows": [], "period_start": period_start.isoformat(),
                "period_end": pe.isoformat(), "total": "0"}

    from core.qbo_gl import pull_gl_transactions
    gl_rows = await pull_gl_transactions(conn, db, qbo_account_id, period_start, pe)

    rows = []
    total = Decimal("0")
    for r in gl_rows:
        amount = r["amount"]
        total += amount
        rows.append({
            "txn_id":     r["qbo_txn_id"] or "",
            "txn_type":   r["txn_type"],
            "txn_number": r["txn_number"] or "",
            "txn_date":   r["txn_date"].isoformat() if r["txn_date"] else "",
            "amount":     str(amount),
            "memo":       r["memo"] or "",
            "entity":     r["entity_name"] or "",
        })
    return {
        "rows":         rows,
        "period_start": period_start.isoformat(),
        "period_end":   pe.isoformat(),
        "total":        str(total.quantize(Decimal("0.01"))),
    }


# ── Evidence (attached source documents for manual overrides) ────────────────

_ALLOWED_EVIDENCE_EXTS = {"pdf", "xlsx", "xls", "csv", "png", "jpg", "jpeg"}
_ALLOWED_EVIDENCE_MIMES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "image/png",
    "image/jpeg",
}
_MAX_EVIDENCE_BYTES = 15 * 1024 * 1024  # 15 MB


def _serialize_evidence(e: SubledgerEvidence) -> dict:
    return {
        "id":          str(e.id),
        "file_name":   e.file_name,
        "file_size":   e.file_size,
        "mime_type":   e.mime_type,
        "uploaded_by": str(e.uploaded_by),
        "uploaded_at": e.uploaded_at.isoformat() if e.uploaded_at else None,
        "verification": e.verification,
    }


@router.get("/account/{qbo_account_id}/evidence")
async def list_account_evidence(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return the list of attached evidence files for one account+period."""
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    rows = list((await db.execute(
        select(SubledgerEvidence)
        .where(
            SubledgerEvidence.qbo_account_id == qbo_account_id,
            SubledgerEvidence.period_end == pe,
        )
        .order_by(desc(SubledgerEvidence.uploaded_at))
    )).scalars().all())
    return {"evidence": [_serialize_evidence(r) for r in rows]}


@router.post("/account/{qbo_account_id}/evidence", status_code=status.HTTP_201_CREATED)
async def upload_account_evidence(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Upload a supporting document (bank statement, FA register, etc.) for a
    manual subledger override. Stored in R2, listed alongside the override,
    used by reviewers to verify the entered value.
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

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
    # Don't fully reject on MIME alone — browsers can mis-label — but warn
    # via the audit log if it's unfamiliar.
    safe_name = name.replace("/", "_").replace("\\", "_")
    key = r2_storage.tenant_key(
        tenant_id,
        f"subledger-evidence/{qbo_account_id}/{pe.isoformat()}",
        f"{uuid.uuid4()}_{safe_name}",
    )
    r2_storage.upload_file(key, io.BytesIO(raw), content_type=mime)

    row = SubledgerEvidence(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        qbo_account_id=qbo_account_id,
        period_end=pe,
        file_name=safe_name,
        file_size=len(raw),
        mime_type=mime,
        r2_key=key,
        uploaded_by=user.id,
    )
    db.add(row)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.evidence_uploaded",
        entity_type="subledger_evidence", entity_id=row.id,
        metadata={
            "summary": f"Uploaded {safe_name} ({len(raw)} bytes) for account {qbo_account_id} ({pe})",
            "qbo_account_id": qbo_account_id,
            "period_end": pe.isoformat(),
            "mime_unrecognized": mime not in _ALLOWED_EVIDENCE_MIMES,
        },
    )
    await db.commit()
    await db.refresh(row)
    return _serialize_evidence(row)


@router.get("/evidence/{evidence_id}/download")
async def download_account_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return a short-lived signed URL the browser can hit to download the file.
    Tenant scoping ensures users can only ever fetch their own org's files.
    """
    row = (await db.execute(
        select(SubledgerEvidence).where(SubledgerEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")
    url = r2_storage.generate_presigned_download_url(row.r2_key, expires_in=300)
    return {"download_url": url, "file_name": row.file_name, "mime_type": row.mime_type}


@router.post("/evidence/{evidence_id}/verify")
async def verify_account_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Ask Anthropic to read the attached document and pull out the actual
    balance + statement date + doc type. Compare against the user-entered
    subledger value. Cache the result on the evidence row so subsequent
    requests don't re-spend tokens.

    Returns the merged verification envelope:
      { extracted_balance, statement_date, doc_type, doc_identifier,
        match_status, difference, confidence, summary, model, verified_at }
    """
    ev = (await db.execute(
        select(SubledgerEvidence).where(SubledgerEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if ev is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")

    # Fetch the bytes from R2 via signed URL → download.
    # Avoid pulling the full file through this process if cache exists.
    review = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == ev.qbo_account_id,
            AccountReviewStatus.period_end == ev.period_end,
        )
    )).scalar_one_or_none()

    entered = review.subledger_total if review else None
    account_type_hint: str | None = None  # we'd need a QBO lookup; pass None for now

    # Pull the bytes from R2. The boto3 S3 client is sync — wrap the get +
    # the AI call in a thread so we don't block the event loop.
    try:
        obj = await asyncio.to_thread(
            r2_storage._s3.get_object,  # type: ignore[attr-defined]  # _s3 is a private but stable client
            Bucket=_settings.r2_bucket_name, Key=ev.r2_key,
        )
        raw = obj["Body"].read()
    except Exception as e:
        logger.exception("R2 fetch failed during verify")
        raise HTTPException(status_code=502, detail=f"Could not load file from storage: {e}")

    from modules.recons.ai_verify import compute_match, verify_evidence_document
    try:
        extracted = await asyncio.to_thread(
            verify_evidence_document,
            raw, ev.mime_type, ev.file_name, account_type_hint, ev.period_end.isoformat(),
        )
    except Exception as e:
        logger.exception("AI verify failed")
        raise HTTPException(status_code=502, detail=f"AI verification failed: {e}")

    match_status, diff_str = compute_match(extracted.get("extracted_balance"), entered)
    merged = {
        **extracted,
        "match_status": match_status,
        "difference":   diff_str,
        "verified_at":  datetime.now(UTC).isoformat(),
    }
    ev.verification = merged

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.evidence_verified",
        entity_type="subledger_evidence", entity_id=ev.id,
        metadata={
            "summary":      f"Verified evidence {ev.file_name} — {match_status}",
            "match_status": match_status,
            "confidence":   extracted.get("confidence"),
            "model":        extracted.get("model"),
        },
    )
    await db.commit()
    return merged


@router.delete("/evidence/{evidence_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account_evidence(
    evidence_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Remove an attached evidence file."""
    row = (await db.execute(
        select(SubledgerEvidence).where(SubledgerEvidence.id == evidence_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Evidence not found.")
    await _block_if_closed(db, row.period_end)
    r2_storage.delete_file(row.r2_key)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.evidence_deleted",
        entity_type="subledger_evidence", entity_id=row.id,
        metadata={
            "summary": f"Deleted evidence {row.file_name} for account {row.qbo_account_id} ({row.period_end})",
            "qbo_account_id": row.qbo_account_id,
            "period_end": row.period_end.isoformat(),
        },
    )
    await db.delete(row)
    await db.commit()


# ── Reviewer dashboard: every manual override for the tenant ─────────────────

@router.get("/admin/overrides")
async def list_overrides(
    tenant_id: CurrentTenantId,
    period_end: str | None = Query(default=None, description="Filter by period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Reviewer's one-stop QC list — every manual subledger override across
    every account+period (optionally filtered to one period). Each entry
    carries the entered value, source label, evidence count, and review
    status so the reviewer can triage at a glance and click in to verify.
    """
    from datetime import date as _date
    stmt = (
        select(AccountReviewStatus)
        .where(AccountReviewStatus.subledger_total.is_not(None))
        .order_by(desc(AccountReviewStatus.subledger_entered_at))
    )
    if period_end:
        try:
            pe = _date.fromisoformat(period_end)
        except ValueError:
            raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
        stmt = stmt.where(AccountReviewStatus.period_end == pe)

    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        return {"overrides": []}

    # Bulk-load evidence counts + verification status in one query so the
    # reviewer dashboard can show AI-verified vs unverified at a glance.
    if rows:
        ev_rows_full = list((await db.execute(
            select(SubledgerEvidence)
        )).scalars().all())
    else:
        ev_rows_full = []
    ev_index: dict[tuple[str, Any], list[SubledgerEvidence]] = {}
    for e in ev_rows_full:
        ev_index.setdefault((e.qbo_account_id, e.period_end), []).append(e)

    out = []
    for r in rows:
        files = ev_index.get((r.qbo_account_id, r.period_end), [])
        # Verified status: best-of all attached files.
        match_states = [
            (f.verification or {}).get("match_status") for f in files if f.verification
        ]
        if "match" in match_states:
            verified_state = "match"
        elif "mismatch" in match_states:
            verified_state = "mismatch"
        elif match_states:
            verified_state = "unknown"
        else:
            verified_state = "unverified"

        out.append({
            "qbo_account_id":         r.qbo_account_id,
            "period_end":             r.period_end.isoformat(),
            "subledger_total":        str(r.subledger_total) if r.subledger_total is not None else None,
            "subledger_source":       r.subledger_source,
            "subledger_entered_by":   str(r.subledger_entered_by) if r.subledger_entered_by else None,
            "subledger_entered_at":   r.subledger_entered_at.isoformat() if r.subledger_entered_at else None,
            "status":                 r.status,
            "reviewed_by":            str(r.reviewed_by) if r.reviewed_by else None,
            "reviewed_at":            r.reviewed_at.isoformat() if r.reviewed_at else None,
            "evidence_count":         len(files),
            "verification_state":     verified_state,
        })
    return {"overrides": out}


@router.post("/clear-synced-data", status_code=status.HTTP_200_OK)
async def clear_synced_data(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Wipe all persisted reconciliations / items / transactions / notes for
    this workspace. Useful when the user wants to start fresh (e.g. after
    a QBO re-sync brought in different data, or to clear demo data).
    The QBO connection itself is preserved — only Nordavix-side cached
    reconciliation records are deleted.
    """
    # Delete in FK-safe order: notes → transactions → items → reconciliations
    await db.execute(delete(ReconNote))
    await db.execute(delete(ReconTransaction))
    await db.execute(delete(ReconciliationItem))
    await db.execute(delete(Reconciliation))
    await db.commit()
    return {"status": "ok", "message": "All cached reconciliation data cleared."}


# ── Persistent-reconciliations dashboard (deprecated entry, kept for now) ────

@router.get("/dashboard", response_model=ReconciliationDashboard)
async def get_dashboard(
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationDashboard:
    recons = list((await db.execute(
        select(Reconciliation).order_by(desc(Reconciliation.created_at))
    )).scalars().all())

    item_rows = list((await db.execute(
        select(ReconciliationItem)
    )).scalars().all())

    total = len(recons)
    completed = sum(1 for r in recons if r.status == "approved")
    pending_review = sum(1 for r in recons if r.status in ("in_review", "computing", "syncing"))
    high_risk = sum(1 for i in item_rows if i.risk_level == "high")
    unresolved = sum((abs(r.difference) for r in recons if r.status != "approved"), Decimal("0"))
    overdue = sum((i.aging_61_90 + i.aging_over_90 for i in item_rows), Decimal("0"))

    stats = ReconciliationDashboardStats(
        total=total,
        completed=completed,
        pending_review=pending_review,
        high_risk_accounts=high_risk,
        unresolved_difference=unresolved,
        overdue_aging_total=overdue,
    )

    recent = recons[:6]

    # Build a synthetic activity feed from recon timestamps + notes.
    activity: list[ActivityFeedEntry] = []
    notes = list((await db.execute(
        select(ReconNote).order_by(desc(ReconNote.created_at)).limit(20)
    )).scalars().all())
    name_lookup = {r.id: r.name for r in recons}

    for r in recons[:10]:
        activity.append(ActivityFeedEntry(
            kind="created",
            recon_id=r.id,
            recon_name=r.name,
            happened_at=r.created_at,
            actor_id=r.created_by,
            summary=f"Created {r.recon_type} reconciliation for {r.period_end}",
        ))
        if r.approved_at:
            activity.append(ActivityFeedEntry(
                kind="approved",
                recon_id=r.id,
                recon_name=r.name,
                happened_at=r.approved_at,
                actor_id=r.approved_by,
                summary=f"Approved {r.name}",
            ))
        if r.ai_summary:
            activity.append(ActivityFeedEntry(
                kind="ai_commentary",
                recon_id=r.id,
                recon_name=r.name,
                happened_at=r.updated_at,
                actor_id=None,
                summary="AI commentary generated",
            ))

    for n in notes:
        activity.append(ActivityFeedEntry(
            kind="noted",
            recon_id=n.reconciliation_id,
            recon_name=name_lookup.get(n.reconciliation_id, "Reconciliation"),
            happened_at=n.created_at,
            actor_id=n.author_id,
            summary=(n.body[:80] + "…") if len(n.body) > 80 else n.body,
        ))

    activity.sort(key=lambda e: e.happened_at, reverse=True)
    activity = activity[:15]

    return ReconciliationDashboard(
        stats=stats,
        recent=[ReconciliationResponse.model_validate(r) for r in recent],
        activity=activity,
        ai_insights=insights_from(recons, item_rows),
    )


# ── Get one ────────────────────────────────────────────────────────────────────

@router.get("/{recon_id}", response_model=ReconciliationDetail)
async def get_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationDetail:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    items = list((await db.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon_id)
        .order_by(desc(ReconciliationItem.subledger_balance))
    )).scalars().all())

    item_ids = [i.id for i in items]
    txns: list[ReconTransaction] = []
    if item_ids:
        txns = list((await db.execute(
            select(ReconTransaction).where(ReconTransaction.reconciliation_item_id.in_(item_ids))
        )).scalars().all())

    notes = list((await db.execute(
        select(ReconNote).where(ReconNote.reconciliation_id == recon_id)
        .order_by(desc(ReconNote.created_at))
    )).scalars().all())

    return ReconciliationDetail(
        recon=ReconciliationResponse.model_validate(recon),
        items=[ReconciliationItemResponse.model_validate(i) for i in items],
        transactions=[ReconTransactionResponse.model_validate(t) for t in txns],
        notes=[ReconNoteResponse.model_validate(n) for n in notes],
    )


# ── Sync (re-pull from QBO) ───────────────────────────────────────────────────

@router.post("/{recon_id}/sync", response_model=ReconciliationResponse)
async def sync_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.status = "syncing"
    recon.error_detail = None
    await db.commit()
    background_tasks.add_task(run_sync, recon_id, tenant_id)
    await db.refresh(recon)
    return recon


# ── Approve / assign ──────────────────────────────────────────────────────────

@router.post("/{recon_id}/approve", response_model=ReconciliationResponse)
async def approve_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.approved_by = user.id
    recon.approved_at = datetime.now(UTC)
    recon.status = "approved"
    await db.commit()
    return recon


@router.post("/{recon_id}/assign", response_model=ReconciliationResponse)
async def assign_reconciliation(
    recon_id: uuid.UUID,
    body: AssignBody,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    recon.assigned_to = body.user_id
    await db.commit()
    return recon


# ── Notes ─────────────────────────────────────────────────────────────────────

@router.post("/{recon_id}/notes", response_model=ReconNoteResponse, status_code=status.HTTP_201_CREATED)
async def add_note(
    recon_id: uuid.UUID,
    body: NoteCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ReconNote:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    note = ReconNote(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        reconciliation_id=recon_id,
        reconciliation_item_id=body.reconciliation_item_id,
        author_id=user.id,
        body=body.body,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


# ── Item-level actions ────────────────────────────────────────────────────────

@router.put("/{recon_id}/items/{item_id}/status", response_model=ReconciliationItemResponse)
async def set_item_status(
    recon_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ItemStatusUpdate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationItem:
    item = (await db.execute(
        select(ReconciliationItem).where(
            ReconciliationItem.id == item_id,
            ReconciliationItem.reconciliation_id == recon_id,
        )
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    item.status = body.status
    if body.status == "approved":
        item.approved_by = user.id
        item.approved_at = datetime.now(UTC)
    await db.commit()
    return item


@router.post("/{recon_id}/items/{item_id}/explain", response_model=ReconciliationItemResponse)
async def explain_item_endpoint(
    recon_id: uuid.UUID,
    item_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> ReconciliationItem:
    """
    Generate (or regenerate) AI commentary for a single reconciliation item.
    Synchronous from the caller's perspective so the UI can show the new
    commentary the moment the request returns — no background polling.
    """
    item = (await db.execute(
        select(ReconciliationItem).where(
            ReconciliationItem.id == item_id,
            ReconciliationItem.reconciliation_id == recon_id,
        )
    )).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    commentary = await explain_item(db, recon, item)
    if commentary:
        item.ai_commentary = commentary
        await db.commit()
        await db.refresh(item)
    return item


@router.post("/{recon_id}/explain", response_model=ReconciliationResponse)
async def explain_recon_endpoint(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    """
    Generate the AI executive summary for the whole reconciliation.
    On-demand only — never auto-runs during sync.
    """
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    summary = await explain_recon_summary(db, recon)
    if summary:
        recon.ai_summary = summary
        await db.commit()
        await db.refresh(recon)
    return recon


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{recon_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> None:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    await db.delete(recon)
    await db.commit()


# ── Export support package (Excel) ────────────────────────────────────────────

@router.get("/{recon_id}/export")
async def export_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")

    items = list((await db.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon_id)
        .order_by(desc(ReconciliationItem.subledger_balance))
    )).scalars().all())
    item_ids = [i.id for i in items]

    txns: list[ReconTransaction] = []
    if item_ids:
        txns = list((await db.execute(
            select(ReconTransaction).where(ReconTransaction.reconciliation_item_id.in_(item_ids))
        )).scalars().all())

    notes = list((await db.execute(
        select(ReconNote).where(ReconNote.reconciliation_id == recon_id)
        .order_by(ReconNote.created_at)
    )).scalars().all())

    name_by_item = {i.id: i.entity_name for i in items}

    summary_df = pd.DataFrame({
        "Field": ["Reconciliation", "Type", "Period End", "GL Total",
                  "Subledger Total", "Difference", "Status", "AI Summary"],
        "Value": [recon.name, recon.recon_type, str(recon.period_end),
                  f"${float(recon.gl_total):,.2f}",
                  f"${float(recon.subledger_total):,.2f}",
                  f"${float(recon.difference):,.2f}",
                  recon.status, recon.ai_summary or ""],
    })
    items_df = pd.DataFrame([{
        "Entity": i.entity_name,
        "GL Balance": float(i.gl_balance),
        "Subledger Balance": float(i.subledger_balance),
        "Difference": float(i.difference),
        "Current": float(i.aging_current),
        "1-30": float(i.aging_1_30),
        "31-60": float(i.aging_31_60),
        "61-90": float(i.aging_61_90),
        "Over 90": float(i.aging_over_90),
        "Risk": i.risk_level,
        "Status": i.status,
        "AI Commentary": i.ai_commentary or "",
    } for i in items])
    txns_df = pd.DataFrame([{
        "Entity": name_by_item.get(t.reconciliation_item_id, ""),
        "Category": t.category,
        "Type": t.txn_type,
        "Number": t.txn_number or "",
        "Date": str(t.txn_date) if t.txn_date else "",
        "Amount": float(t.amount),
        "Memo": t.memo or "",
    } for t in txns])
    notes_df = pd.DataFrame([{
        "When": n.created_at.isoformat(),
        "Body": n.body,
    } for n in notes])

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        summary_df.to_excel(writer, sheet_name="Summary", index=False)
        items_df.to_excel(writer, sheet_name="Items", index=False)
        if not txns_df.empty:
            txns_df.to_excel(writer, sheet_name="Evidence", index=False)
        if not notes_df.empty:
            notes_df.to_excel(writer, sheet_name="Notes", index=False)
        for sheet in writer.sheets.values():
            for col in sheet.columns:
                max_len = max((len(str(c.value or "")) for c in col), default=10)
                sheet.column_dimensions[col[0].column_letter].width = min(max_len + 2, 60)

    buf.seek(0)
    safe = recon.name.replace(" ", "_").replace("/", "-")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{safe}_reconciliation.xlsx"'},
    )
