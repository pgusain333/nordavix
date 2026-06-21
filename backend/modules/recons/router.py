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

from core.ai.guard import enforce_ai_limits
from core.audit.log import write_audit_event
from core.auth.clerk_users import _format_display_name, get_clerk_user
from core.auth.dependencies import (
    ROLE_ORDER,
    CurrentTenantId,
    CurrentUser,
    require_capability,
    require_role,
)
from core.db.base import current_request_readonly
from core.db.session import get_db
from core.storage import r2 as r2_storage
from models.account_review_status import AccountReviewStatus
from models.bank_statement_txn import BankStatementTxn
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
from models.workpaper_evidence import WorkpaperEvidence
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
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.created", entity_type="reconciliation", entity_id=recon.id,
        metadata={"summary": f"Created reconciliation '{body.name}' ({body.recon_type}, {body.period_end})"},
    )
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


@router.post("/agentic/run", dependencies=[Depends(enforce_ai_limits)])
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
    await _block_if_closed(db, pe)  # don't let AI re-prepare a locked period

    logger.info(
        "Agentic prep run start: tenant=%s user=%s period=%s",
        tenant_id, user.id, pe,
    )
    try:
        result = await run_agentic_prep(db, tenant_id, user, pe)
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="recon.agentic_run", entity_type="period", entity_id=None,
            metadata={"summary": f"Ran the agentic preparer on all open accounts for {pe}"},
        )
        await db.commit()
        # Ping the person who kicked off the run — agentic prep is a walk-away
        # action, so the bell tells them it's done + what it touched. In-app,
        # best-effort; never affects the run result.
        try:
            from modules.notifications.service import notify_user
            parts = []
            if result.prepared:
                parts.append(f"{result.prepared} prepared")
            if result.analyzed:
                parts.append(f"{result.analyzed} AI-analyzed")
            summary_txt = ", ".join(parts) if parts else "no accounts changed"
            await notify_user(
                db, tenant_id=tenant_id, recipient_user_id=user.id,
                type="agentic_done", title="AI preparer finished",
                body=f"Agentic run on {pe.isoformat()}: {summary_txt}.",
                link="/app/reconciliations", entity_type="period", entity_id=pe.isoformat(),
            )
        except Exception:
            logger.warning("agentic-done notification failed", exc_info=True)
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


@router.post("/agentic/run-one", dependencies=[Depends(enforce_ai_limits)])
async def run_agentic_on_one_account_endpoint(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    qbo_account_id: str = Query(..., description="QBO Account.Id of the row to analyze"),
    period_end: str = Query(..., description="Period end date YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Run the AI agentic preparer on ONE account row.

    Same engine as the bulk runner — it just filters the candidate set
    to a single account. Open to all workspace members (preparers can
    trigger AI generation; only approve actions are role-gated).

    Use case: user clicked the per-row "Run AI" button on a single
    account in the recons table. Clicking is idempotent — re-running
    re-pulls QBO transactions + regenerates the AI commentary.

    ~5-15s typical latency. The frontend shows a per-row spinner.
    """
    from dataclasses import asdict
    from datetime import date as _date

    from modules.recons.agentic import run_agentic_prep_for_account

    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    await _block_if_closed(db, pe)  # don't let AI re-prepare a locked period

    logger.info(
        "Per-account agentic start: tenant=%s user=%s period=%s qbo_account=%s",
        tenant_id, user.id, pe, qbo_account_id,
    )
    try:
        result = await run_agentic_prep_for_account(
            db, tenant_id, user, pe, qbo_account_id,
        )
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=user.id,
            action="recon.agentic_run", entity_type="account", entity_id=None,
            metadata={"summary": f"Ran the agentic preparer on one account (QBO id {qbo_account_id}) for {pe}"},
        )
        await db.commit()
        return asdict(result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Per-account agentic failed at top level for tenant=%s period=%s qbo=%s",
            tenant_id, pe, qbo_account_id,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Per-row agentic failed: {type(exc).__name__}: {str(exc)[:200]}",
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
    user: CurrentUser,
    background_tasks: BackgroundTasks,
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
    # Re-pulling QBO into a closed period would overwrite its locked balances.
    # An admin must reopen first.
    await _block_if_closed(db, pe)

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

    # Stale-approval guard: a re-sync that left an approved account no longer
    # reconciled flips it back to needs-review + notifies its approver. Open
    # periods only — closed periods are locked.
    overview["reflagged"] = (
        0 if cp is not None
        else await _reflag_stale_approvals(db, tenant_id, pe, overview, user, background_tasks)
    )
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.period_synced", entity_type="period", entity_id=None,
        metadata={"summary": f"Synced {pe} from QuickBooks ({len(overview.get('accounts', []))} accounts)"},
    )
    await db.commit()

    # Tell the person who ran the sync that it finished — Sync is a walk-away
    # action (several seconds of QBO calls), so the bell is how they learn it's
    # done and whether anything needs another look. In-app ping to the actor;
    # best-effort, never affects the sync result.
    try:
        from modules.notifications.service import notify_user
        n_acct = len(overview.get("accounts", []))
        reflagged = overview.get("reflagged") or 0
        body = f"{n_acct} account{'' if n_acct == 1 else 's'} refreshed from QuickBooks."
        if reflagged:
            body += (
                f" {reflagged} approved reconciliation"
                f"{'' if reflagged == 1 else 's'} no longer tie out and were reopened."
            )
        await notify_user(
            db, tenant_id=tenant_id, recipient_user_id=user.id,
            type="sync_complete", title="QuickBooks sync complete", body=body,
            link="/app/reconciliations", entity_type="period", entity_id=pe.isoformat(),
        )
    except Exception:
        logger.warning("sync-complete notification failed", exc_info=True)

    # A second pair of eyes runs on its own right after the sync: the GL-accuracy
    # watchdog re-checks this period's vendor coding in the background, so flags
    # are waiting without anyone clicking "Scan". It owns its session + errors —
    # a scan failure can never affect this sync (see service.run_auto_scan). It
    # also pings the actor in-app if it turns up anything worth reviewing.
    from modules.gl_accuracy.service import run_auto_scan
    background_tasks.add_task(run_auto_scan, tenant_id, pe, user.id)

    return overview


@router.post("/account/{qbo_account_id}/sync")
async def sync_one_account_from_qbo(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Surgical refresh: re-pull one account's GL balance from QBO and
    upsert the snapshot in place. Doesn't touch AR/AP aging or any
    other account — fast (~1-2s) for the row-level refresh.

    Used by the recon dashboard's per-row "sync" button so the user
    can iterate on one row without re-pulling the whole TB.
    """
    try:
        pe = date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    await _block_if_closed(db, pe)  # locked period — reopen before re-pulling QBO

    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        raise HTTPException(status_code=409, detail="Connect QuickBooks first.")

    # Look up the existing snapshot row so we can re-use account_number
    # / account_name / account_type — they don't change per sync, but
    # we need them to upsert with the same metadata.
    from models.gl_balance_snapshot import GlBalanceSnapshot
    snap = (await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.qbo_account_id == qbo_account_id,
            GlBalanceSnapshot.period_end == pe,
        )
    )).scalar_one_or_none()

    # Pull fresh TB for that period + lookup the account by canonical id.
    from core.qbo_tb import fetch_trial_balance, parse_trial_balance
    try:
        report = await fetch_trial_balance(conn, pe)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"QBO sync failed: {exc}")
    parsed = parse_trial_balance(report)
    by_id = parsed["by_id"]
    new_balance: Decimal | None = None
    if qbo_account_id in by_id:
        new_balance = by_id[qbo_account_id]
    elif snap is not None and snap.account_number and snap.account_number in parsed["by_name"]:
        new_balance = parsed["by_name"][snap.account_number]
    elif snap is not None:
        # Final fallback: try the display name + variants.
        for k in (snap.account_name, f"{snap.account_number} {snap.account_name}".strip() if snap.account_number else ""):
            if k and k in parsed["by_name"]:
                new_balance = parsed["by_name"][k]
                break
    if new_balance is None:
        raise HTTPException(
            status_code=404,
            detail="QBO returned no balance for that account on the period end date.",
        )

    if snap is None:
        # First-time sync for this (account, period) — need the account
        # metadata from QBO's chart. Pull the Account record so we
        # populate name/number/type alongside the balance.
        from modules.recons.service import _qbo_get
        try:
            data = await _qbo_get(
                conn, db, f"/account/{qbo_account_id}",
                params={"minorversion": "65"},
            )
        except Exception:
            data = {}
        a = data.get("Account") or {}
        snap = GlBalanceSnapshot(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qbo_account_id,
            period_end=pe,
            account_number=(a.get("AcctNum") or "") or None,
            account_name=(a.get("Name") or qbo_account_id),
            account_type=(a.get("AccountType") or ""),
            balance=new_balance,
        )
        db.add(snap)
    else:
        snap.balance = new_balance
        snap.captured_at = datetime.now(UTC)

    # Re-syncing an APPROVED account re-opens it: the QBO numbers may now
    # differ from what was signed off, so the approval can no longer stand.
    # Drop it back to "reviewed" (preparer can re-review + re-approve).
    # This is the only path that pulls QBO for an approved account, and it
    # always un-approves — so an approval always reflects the exact data
    # that existed when it was signed off.
    reopened = False
    review = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end == pe,
        )
    )).scalar_one_or_none()
    if review is not None and review.status == "approved":
        review.status = "reviewed"
        review.approved_by = None
        review.approved_at = None
        reopened = True

    await db.commit()
    await db.refresh(snap)

    try:
        from core.audit.log import write_audit_event as _audit
        await _audit(
            db, tenant_id=tenant_id, user_id=user.id,
            action="recon.account_synced",
            entity_type="account_snapshot", entity_id=snap.id,
            metadata={
                "summary": (
                    f"Resynced {snap.account_name} from QBO"
                    + (" (re-opened — was approved)" if reopened else "")
                ),
                "qbo_account_id": qbo_account_id,
                "period_end":   pe.isoformat(),
                "new_balance":  str(new_balance),
                "reopened":     reopened,
            },
        )
        await db.commit()
    except Exception:
        logger.exception("Audit write failed on recon account sync")

    return {
        "qbo_account_id": qbo_account_id,
        "period_end":     pe.isoformat(),
        "account_name":   snap.account_name,
        "account_number": snap.account_number,
        "account_type":   snap.account_type,
        "gl_balance":     str(new_balance.quantize(Decimal("0.01"))),
        "captured_at":    snap.captured_at.isoformat() if snap.captured_at else None,
        "reopened":       reopened,
    }


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
            # Never write during a read-only (demo) request — the DB layer would
            # 403 the commit anyway; skip the opportunistic backfill cleanly so
            # the PDF still renders against the demo tenant.
            read_only = current_request_readonly.get()
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
                        if cu.get("email") and not u.email and not read_only:
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
                if it.get("cleared") is False:
                    continue  # open/un-ticked item — the unreconciled gap, not in the SL
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
    background_tasks: BackgroundTasks,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    status_value: str = Query(..., alias="status", description="pending | reviewed | approved | flagged"),
    notes: str | None = Query(default=None),
    preserve: bool = Query(
        default=False,
        description=(
            "Only meaningful when status=pending. False (default) = full reset: "
            "drop the subledger override + ticked items so the next preparer starts "
            "fresh. True = a preparer unlocking their own Prepared work to edit — "
            "keep the subledger + ticked items, clear only the prepared/approved stamps."
        ),
    ),
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

    # Role gate. Preparers' workflow IS marking accounts prepared —
    # that's the maker side of maker/checker — so "reviewed" is open
    # to everyone with workspace access. Only the reviewer-side
    # actions ("approved", "flagged") stay gated to reviewer+.
    # "pending" is open to everyone (preparers reset their own work,
    # reviewers reset anything).
    if status_value in ("approved", "flagged"):
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

    # Filled at the approval gate below (while the row is still editable, so a
    # schedule-backed account is read from its live schedule) and frozen onto the
    # row in the 'approved' branch.
    approved_subledger: Decimal | None = None

    # Reopen gate: un-approving an approved reconciliation (back to pending or
    # reviewed) is a reviewer/admin action. Preparers can still reset their own
    # not-yet-approved work.
    if (
        row is not None
        and row.status == "approved"
        and status_value in ("pending", "reviewed")
        and ROLE_ORDER.get(user.role or "preparer", 0) < ROLE_ORDER["reviewer"]
    ):
        raise HTTPException(
            status_code=403,
            detail="Only reviewers and admins can reopen an approved reconciliation.",
        )

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

    # Bank/Credit-Card accounts: require a statement (or evidence) before
    # approval — a bank rec can't be signed off with nothing attached.
    if status_value == "approved" and await _bank_acct_missing_statement(
        db, tenant_id, qbo_account_id, pe
    ):
        raise HTTPException(status_code=422, detail=_STATEMENT_REQUIRED_MSG)

    # Reconciliation gate: an account can't be approved while GL and subledger
    # disagree beyond the materiality floor. The reconciling-items build-up
    # feeds the subledger, so an explained gap collapses to ~0 and passes.
    if status_value == "approved":
        # Build the overview ONCE and reuse it for both the tie-out gate and the
        # freeze capture below — both read the same pre-flip snapshot, so this
        # avoids constructing the (schedule-heavy) overview twice per approve.
        from modules.recons.overview import read_overview_from_snapshots
        _approve_ov = await read_overview_from_snapshots(db, pe)
        unrec = await _unreconciled_accounts(db, pe, [qbo_account_id], ov=_approve_ov)
        if qbo_account_id in unrec:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Can't approve — this account isn't reconciled ({unrec[qbo_account_id]}). "
                    "Tick the reconciling items that explain the difference, or fix the "
                    "subledger, then approve."
                ),
            )
        # Tie-out passed. Capture the EXACT subledger the dashboard shows right
        # now — while the row is still 'reviewed', so a schedule-backed account is
        # computed from its LIVE schedule, not its (possibly stale) stored
        # subledger_total. Frozen onto the row in the 'approved' branch so the
        # sign-off holds this reconciled balance and can never gain a variance.
        approved_subledger = (await _overview_subledgers(db, pe, ov=_approve_ov)).get(qbo_account_id)

    # NOTE: "Mark prepared" (reviewed) deliberately has NO tie-out gate — a
    # preparer can mark an account prepared with a documented variance / open
    # items, and (for schedule-backed accounts) the subledger auto-pulls the
    # schedule balance so a zero variance is markable immediately, without
    # racing the debounced subledger save. Tie-out is enforced where it must
    # be: the Approve gate above (status == "approved") and the close-period
    # gate both block any account that doesn't reconcile, so nothing un-tied
    # ever reaches sign-off.

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
        # Freeze the displayed (gate-checked) subledger captured above so the
        # sign-off holds exactly the reconciled balance shown at approval and can
        # never drift — for schedule-backed accounts this corrects a stale stored
        # value that would otherwise surface as a phantom variance on approval.
        _apply_approval_freeze(row, approved_subledger)
    elif status_value == "pending":
        # Re-opening for editing always clears the actor stamps.
        row.prepared_by = None
        row.prepared_at = None
        row.approved_by = None
        row.approved_at = None
        if preserve:
            # "Reset to open" — a preparer unlocking their OWN Prepared work to
            # tweak it before a reviewer approves. KEEP the subledger override +
            # ticked items so they don't have to redo everything; the row simply
            # returns to the editable in-progress state. (Re-opening an APPROVED
            # row is gated to reviewer/admin above, so this only fires from a
            # Prepared row.)
            pass
        else:
            # "Reset to pending" — full start-over. Drop the subledger override +
            # ticked items so the next preparer begins from a clean slate.
            # Matches the bulk endpoint.
            row.subledger_total = None
            row.subledger_source = None
            row.subledger_entered_by = None
            row.subledger_entered_at = None
            row.reconciling_items = []
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
    review_row_id = str(row.id)
    preparer_id = row.prepared_by
    await db.commit()

    # Preparer marked it prepared → tell the approvers it's ready for review.
    # Best-effort; never block or fail the status change on a notification.
    if status_value == "reviewed":
        try:
            from modules.notifications.emails import notify_and_email_users
            from modules.notifications.service import workspace_user_ids_by_role
            reviewers = await workspace_user_ids_by_role(
                db, ("admin", "reviewer"), exclude_user_id=user.id,
            )
            await notify_and_email_users(
                db, background_tasks, tenant_id=tenant_id, recipient_ids=reviewers,
                type="review_ready",
                title="A reconciliation is ready for review",
                body=f"{user.email} marked account {qbo_account_id} ({period_end}) prepared.",
                link="/app/reconciliations",
                entity_type="account_review_status", entity_id=review_row_id,
            )
        except Exception:
            logger.warning("recon review-ready notifications failed", exc_info=True)

    # Reviewer approved it → tell the preparer their work was signed off.
    elif status_value == "approved" and preparer_id and preparer_id != user.id:
        try:
            from modules.notifications.emails import notify_and_email_users
            await notify_and_email_users(
                db, background_tasks, tenant_id=tenant_id, recipient_ids=[preparer_id],
                type="recon_approved",
                title="Your reconciliation was approved",
                body=f"{user.email} approved account {qbo_account_id} ({period_end}).",
                link="/app/reconciliations",
                entity_type="account_review_status", entity_id=review_row_id,
                actor_name=user.email,
            )
        except Exception:
            logger.warning("recon approved notifications failed", exc_info=True)

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
    background_tasks: BackgroundTasks,
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

    # Role gate — same rules as the per-row endpoint. Preparers
    # can bulk-mark prepared (their workflow); only Approve + Flag
    # remain reviewer/admin only.
    if status_value in ("approved", "flagged"):
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

    # Reopen gate (bulk): downgrading any approved row (→ pending/reviewed) is
    # a reviewer/admin action. Preparers can still reset their own un-approved
    # work, so only block when the batch actually touches an approved row.
    if (
        status_value in ("pending", "reviewed")
        and ROLE_ORDER.get(user.role or "preparer", 0) < ROLE_ORDER["reviewer"]
    ):
        approved_ids = [qid for qid, r in by_id.items() if r.status == "approved"]
        if approved_ids:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Only reviewers and admins can reopen an approved "
                    "reconciliation. Approved in this batch: "
                    + ", ".join(approved_ids) + "."
                ),
            )

    # Approve gates, per account. Unlike a single approve (which 422s the one
    # account), the BULK action approves every account that passes and SKIPS the
    # ones that don't — reporting each skip + reason — so one un-reconciled or
    # statement-less account can't sink the whole batch. Non-approve statuses
    # (reviewed / pending / flagged) act on every selected account.
    skipped: list[dict[str, str]] = []
    approvable_ids: list[str] = ids
    displayed_subs: dict[str, Decimal] = {}
    if status_value == "approved":
        # 1. Maker/checker: a non-admin can't approve an account whose manual
        #    subledger they entered themselves. Admins bypass (master access).
        own_overrides: set[str] = set()
        if user.role != "admin":
            own_overrides = {
                qid for qid, r in by_id.items()
                if r.subledger_total is not None
                and r.subledger_entered_by is not None
                and r.subledger_entered_by == user.id
            }
        # 2. Bank/Credit-Card accounts need a statement (or evidence) attached.
        missing_statement: set[str] = set()
        for qid in ids:
            if await _bank_acct_missing_statement(db, tenant_id, qid, pe):
                missing_statement.add(qid)
        # 3. GL must tie to the subledger within the materiality floor. Build the
        # overview ONCE and reuse it for both the tie-out gate and the displayed-
        # subledger capture below (both read the same pre-flip snapshot).
        from modules.recons.overview import read_overview_from_snapshots
        _bulk_ov = await read_overview_from_snapshots(db, pe)
        unrec = await _unreconciled_accounts(db, pe, ids, ov=_bulk_ov)
        # Capture every account's displayed subledger NOW — before any row flips
        # to 'approved' below — so schedule-backed accounts are still read from
        # their live schedule. Frozen onto each approved row further down.
        displayed_subs = await _overview_subledgers(db, pe, ov=_bulk_ov)

        reasons: dict[str, str] = {}
        for qid in ids:
            if qid in own_overrides:
                reasons[qid] = "you entered the subledger — a different user must approve (maker/checker)"
            elif qid in missing_statement:
                reasons[qid] = "attach the bank statement (or supporting evidence)"
            elif qid in unrec:
                reasons[qid] = f"isn't reconciled ({unrec[qid]})"
        skipped = [{"qbo_account_id": qid, "reason": reason} for qid, reason in reasons.items()]
        approvable_ids = [qid for qid in ids if qid not in reasons]

    now = datetime.now(UTC)
    is_reviewed = status_value != "pending"
    # Same prep/approve stamping rule as the per-row endpoint:
    # promote-only, never clear, and approve cascades through prepare
    # if prepare hasn't happened yet.
    rows_for_freeze: list[tuple[str, AccountReviewStatus]] = []
    approved_preparer_ids: set[uuid.UUID] = set()
    for qid in approvable_ids:
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
                if r.prepared_by and r.prepared_by != user.id:
                    approved_preparer_ids.add(r.prepared_by)
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

    # Freeze the displayed (gate-checked) subledger onto every approved row so the
    # sign-off holds exactly the reconciled balance shown at approval and can never
    # drift. Overwrites only when it diverges from the stored value — schedule-
    # backed accounts show the live schedule, not subledger_total, so without this
    # the freeze surfaces a stale value and manufactures a variance. Also still
    # freezes the default when a row had no stored subledger (the close-and-roll
    # safety net the per-row path now shares).
    for qid, r in rows_for_freeze:
        _apply_approval_freeze(r, displayed_subs.get(qid))

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action=f"recon.bulk_{status_value}",
        entity_type="account_review_status", entity_id=None,
        metadata={
            "summary": f"Bulk set {len(approvable_ids)} accounts → {status_value} for {body.get('period_end')}"
                       + (f" ({len(skipped)} skipped)" if skipped else ""),
            "count": len(approvable_ids),
            "skipped": len(skipped),
            "status": status_value,
        },
    )
    await db.commit()

    # Coalesce a bulk "mark prepared" into ONE review-ready notification per
    # approver (not one per account) so reviewers aren't flooded. Best-effort.
    if status_value == "reviewed":
        try:
            from modules.notifications.emails import notify_and_email_users
            from modules.notifications.service import workspace_user_ids_by_role
            reviewers = await workspace_user_ids_by_role(
                db, ("admin", "reviewer"), exclude_user_id=user.id,
            )
            n = len(ids)
            plural = "s" if n != 1 else ""
            await notify_and_email_users(
                db, background_tasks, tenant_id=tenant_id, recipient_ids=reviewers,
                type="review_ready",
                title=f"{n} reconciliation{plural} ready for review",
                body=f"{user.email} marked {n} account{plural} prepared for {body.get('period_end')}.",
                link="/app/reconciliations",
            )
        except Exception:
            logger.warning("recon bulk review-ready notifications failed", exc_info=True)

    # Bulk approve → tell each preparer (other than the approver) their work was
    # signed off. One batched email to the distinct preparers. Best-effort.
    elif status_value == "approved" and approved_preparer_ids:
        try:
            from modules.notifications.emails import notify_and_email_users
            pe_txt = body.get("period_end")
            await notify_and_email_users(
                db, background_tasks, tenant_id=tenant_id,
                recipient_ids=list(approved_preparer_ids),
                type="recon_approved",
                title="Your reconciliation work was approved",
                body=f"{user.email} approved reconciliations for {pe_txt}.",
                link="/app/reconciliations",
                actor_name=user.email,
            )
        except Exception:
            logger.warning("recon bulk approved notifications failed", exc_info=True)

    return {"updated": len(approvable_ids), "status": status_value, "skipped": skipped}


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


@router.post("/account/{qbo_account_id}/reconciling-items/save-recurring")
async def save_recurring_reconciling_item(
    qbo_account_id: str,
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Capture a reconciling item as RECURRING — a confirm-first Client Memory
    fact (Slice C). Creates a SUGGESTED fact only; a reviewer confirms it in
    Settings → Memory, after which next period's recon SUGGESTS it. Memory never
    auto-adds a reconciling item — the preparer still toggles it on and confirms
    the amount — because items reduce the GL↔subledger difference. Any member may
    suggest (preparers reconcile; reviewers confirm).

    Body: { period_end, label, txn_type?, amount?, entity?, account_name? }
    """
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(str(body.get("period_end", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    await _block_if_closed(db, pe)
    label = str(body.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="A label is required to learn a recurring item.")
    qid = (qbo_account_id or "").strip()
    if not qid:
        raise HTTPException(status_code=400, detail="This account has no stable identifier to learn from.")

    expected_amount: str | None = None
    amount_raw = body.get("amount")
    if amount_raw not in (None, ""):
        try:
            expected_amount = str(Decimal(str(amount_raw)))
        except (ValueError, ArithmeticError):
            raise HTTPException(status_code=400, detail="amount must be numeric.")

    account_name = str(body.get("account_name") or "").strip() or None
    value = {
        "qbo_account_id": qid,
        "account_name": account_name,
        "label": label[:120],
        "txn_type": str(body.get("txn_type") or "").strip() or "Reconciling item",
        "expected_amount": expected_amount,
        "entity": str(body.get("entity") or "").strip() or None,
        "captured_period": pe.isoformat(),
    }
    from modules.memory.service import (
        record_recurring_item_signal,
        recurring_item_title,
        serialize_fact,
        upsert_recurring_item_fact,
    )
    title = recurring_item_title(label, account_name, expected_amount)
    await record_recurring_item_signal(
        db, tenant_id=tenant_id, qbo_account_id=qid, period_end=pe, value=value, created_by=user.id,
    )
    fact = await upsert_recurring_item_fact(
        db, tenant_id=tenant_id, qbo_account_id=qid, label=label, value=value, title=title,
    )
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="memory.recurring_item_captured",
        entity_type="client_memory_fact", entity_id=fact.id,
        metadata={"summary": f"Captured recurring reconciling item — {title}",
                  "qbo_account_id": qid, "period_end": pe.isoformat()},
    )
    await db.commit()
    return serialize_fact(fact)


@router.post("/account/{qbo_account_id}/save-expectation")
async def save_account_expectation(
    qbo_account_id: str,
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Capture this account's reconciliation balance as a recurring expectation
    (Client Memory) — the recon-side twin of the flux 'Teach NDVX' chip. Creates a
    SUGGESTED fact only (confirm-first); a reviewer confirms it in Settings → Memory,
    after which NDVX pre-explains this account next period when it lands within the
    band — on BOTH flux and recon, since both teach the SAME per-account fact. Any
    member may suggest (preparers reconcile; reviewers confirm).

    Body: { period_end, recurrence, explanation, expected_amount?, tolerance_mode?,
            tolerance_pct?, tolerance_abs?, account_name?, account_number? }
    """
    from datetime import date as _date

    from modules.memory.service import (
        build_expectation_value,
        expectation_title,
        record_expectation_signal,
        serialize_fact,
        upsert_expectation_fact,
    )

    try:
        pe = _date.fromisoformat(str(body.get("period_end", "")))
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    await _block_if_closed(db, pe)

    recurrence = str(body.get("recurrence") or "").strip()
    if recurrence not in ("monthly", "quarterly", "annual", "one_off"):
        raise HTTPException(
            status_code=400,
            detail="recurrence must be 'monthly', 'quarterly', 'annual', or 'one_off'.",
        )
    explanation = str(body.get("explanation") or "").strip()
    if not explanation:
        raise HTTPException(
            status_code=400,
            detail="A reason is required — a recurring expectation needs an explanation.",
        )

    qid = (qbo_account_id or "").strip()
    account_number = str(body.get("account_number") or "").strip()
    # Same cross-period key as flux (_account_key): QBO id if present, else the
    # account number — so flux + recon teach/reinforce the ONE per-account fact.
    account_key = qid or account_number
    if not account_key:
        raise HTTPException(status_code=400, detail="This account has no stable identifier to learn from.")

    # Expected balance defaults to the value the drawer prefilled (the account's GL
    # balance); the user can edit it before saving.
    default_balance: Any = Decimal("0")
    raw_expected = body.get("expected_amount")
    if raw_expected not in (None, ""):
        try:
            default_balance = Decimal(str(raw_expected))
        except (ValueError, ArithmeticError):
            raise HTTPException(status_code=400, detail="expected_amount must be numeric.")

    value = build_expectation_value(
        account_number=account_number or None,
        account_name=str(body.get("account_name") or "").strip() or None,
        qbo_account_id=qid or None,
        default_balance=default_balance,
        period_current=pe,
        recurrence=recurrence,
        explanation=explanation,
        expected_amount=None,  # already folded into default_balance above
        tolerance_mode=body.get("tolerance_mode"),
        tolerance_pct=body.get("tolerance_pct"),
        tolerance_abs=body.get("tolerance_abs"),
    )
    title = expectation_title(
        value["account_name"], recurrence, value["month"], value["expected_balance"], explanation,
    )

    await record_expectation_signal(
        db, tenant_id=tenant_id, account_key=account_key, period_end=pe,
        value=value, variance_id=None, created_by=user.id, source="recon",
    )
    fact = await upsert_expectation_fact(
        db, tenant_id=tenant_id, account_key=account_key, value=value, title=title,
    )
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="memory.expectation_captured",
        entity_type="client_memory_fact", entity_id=fact.id,
        metadata={"summary": f"Captured recurring expectation — {title}",
                  "qbo_account_id": qid, "period_end": pe.isoformat()},
    )
    await db.commit()
    return serialize_fact(fact)


@router.get("/account/{qbo_account_id}/recurring-suggestions")
async def recurring_reconciling_suggestions(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Confirmed recurring reconciling items for this account — surfaced as
    suggestions in the recon 'Recurring (from memory)' panel. Read-only; only
    `active` facts; the preparer toggles each on and confirms the amount before it
    becomes a real reconciling item. (period_end is accepted for symmetry with the
    other suggestion endpoints; recurring items apply every period.)"""
    from modules.memory.service import active_recurring_items
    items = await active_recurring_items(db, qbo_account_id)
    return {"items": items}


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
    # This period's snapshot is normally present (approval implies the account
    # showed up in the overview). When it's missing — a partial/failed sync — we
    # must NOT silently skip: that leaves subledger_total NULL, and the next
    # period's roll-forward chain then skips this row and silently rolls its
    # opening from an older period (the "Feb closed but April rolls from Jan"
    # bug). Fall back to the most-recent snapshot for this account purely to read
    # its (stable) account_type, so opening + items still freezes correctly. Only
    # when there is genuinely nothing to compute from do we leave it unfrozen —
    # and then loudly, not silently (see the GL-fallback branch below).
    meta_snap = snap
    if meta_snap is None:
        meta_snap = (await db.execute(
            select(GlBalanceSnapshot)
            .where(
                GlBalanceSnapshot.tenant_id == tenant_id,
                GlBalanceSnapshot.qbo_account_id == qbo_account_id,
                GlBalanceSnapshot.period_end <= period_end,
            )
            .order_by(GlBalanceSnapshot.period_end.desc())
            .limit(1)
        )).scalar_one_or_none()

    acct_type = meta_snap.account_type if meta_snap is not None else ""
    is_credit_natural = acct_type in _CREDIT_NATURAL_ACCOUNT_TYPES
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

    # Signed sum of any existing reconciling items. Only reconciled (ticked)
    # items roll into the subledger — open/un-ticked items (cleared=False) are
    # the unreconciled gap, recorded for the PDF but never part of the balance.
    items = [it for it in ((row.reconciling_items if row else []) or [])
             if it.get("cleared") is not False]
    items_sum = Decimal("0")
    for it in items:
        is_manual = str(it.get("txn_id", "")).startswith("manual-")
        raw = Decimal(str(it.get("amount", "0") or "0"))
        items_sum += raw if is_manual else flip * raw

    # If we have neither a prior NOR items, fall back to GL — keeps
    # the variance = 0 default behavior the dashboard already shows
    # for Bank/Other accounts that are auto-matched to GL.
    if not has_prior and not items:
        if snap is None:
            # No prior, no reconciling items, and no snapshot for THIS period —
            # there's genuinely no basis to freeze a value (we won't fabricate one
            # from a stale period). Leave it unfrozen, but loudly: this is the only
            # remaining case that can't roll forward until a re-sync + re-approval.
            logger.error(
                "Freeze subledger: no GL snapshot, no prior, no items for account "
                "%s @ %s — cannot freeze; next period's opening will not roll from "
                "this period until it is re-synced and re-approved.",
                qbo_account_id, period_end,
            )
            return
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


async def _overview_subledgers(
    db: AsyncSession, period_end, ov: dict | None = None,
) -> dict[str, Decimal]:
    """{qbo_account_id: subledger_balance} the dashboard currently shows for the
    period — the SAME snapshot-backed builder the approval/close gates read.

    For schedule-backed accounts (prepaid / accrual / FA / lease / loan) this is
    the LIVE schedule balance, NOT the stored subledger_total. Capturing it at the
    moment of approval — while the row is still editable, so the builder computes
    it live — and freezing it onto the row lets an approved reconciliation hold
    exactly the reconciled balance shown at sign-off. Without it, the freeze later
    surfaces a stale stored value and manufactures a variance on a clean approval.

    Pass a pre-built `ov` (read_overview_from_snapshots result) to reuse the
    caller's overview instead of rebuilding it; omitted, it builds its own.
    """
    from modules.recons.overview import read_overview_from_snapshots
    if ov is None:
        ov = await read_overview_from_snapshots(db, period_end)
    out: dict[str, Decimal] = {}
    for a in ov.get("accounts", []):
        try:
            out[a["qbo_id"]] = Decimal(str(a["subledger_balance"]))
        except (KeyError, TypeError, ValueError, ArithmeticError):
            continue
    return out


def _apply_approval_freeze(row, displayed: Decimal | None) -> None:
    """Freeze the gate-checked displayed subledger onto an account being approved
    so the sign-off can't drift afterward.

    Overwrites subledger_total ONLY when it diverges from the displayed value:
    schedule-backed accounts show the live schedule (not subledger_total), so this
    corrects a stale stored value that would otherwise surface as a phantom
    variance the instant the account is approved. A stored value that already
    matches (e.g. a manual override entered by the preparer) is left untouched so
    its provenance / maker-checker stamp survives. `displayed` is None only for an
    account absent from the overview, which can't pass the tie-out gate anyway."""
    if displayed is None:
        return
    stored = Decimal(row.subledger_total) if row.subledger_total is not None else None
    if stored is not None and (displayed - stored).copy_abs() <= Decimal("0.005"):
        return  # already matches — keep the existing value + its provenance
    row.subledger_total = displayed.quantize(Decimal("0.01"))
    row.subledger_source = "Auto-frozen on approval — the reconciled balance shown at sign-off"
    row.subledger_entered_by = None  # system-computed at approval, not a manual override
    row.subledger_entered_at = datetime.now(UTC)


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

    # Bulk-load review-row COUNTS grouped by (period_end, status) + the
    # closed-period rows in two queries. Grouping in SQL avoids hydrating every
    # account row across all months just to tally per-period status counts; the
    # counts (and everything downstream) are byte-identical.
    from sqlalchemy import func
    count_rows = (await db.execute(
        select(
            AccountReviewStatus.period_end,
            AccountReviewStatus.status,
            func.count().label("n"),
        )
        .where(AccountReviewStatus.period_end.in_(month_ends))
        .group_by(AccountReviewStatus.period_end, AccountReviewStatus.status)
    )).all()
    closed_rows = list((await db.execute(
        select(ClosedPeriod).where(ClosedPeriod.period_end.in_(month_ends))
    )).scalars().all())
    closed_by_pe: dict[_date, ClosedPeriod] = {c.period_end: c for c in closed_rows}

    # Index the grouped counts by period_end → {status: n} (status may be NULL).
    counts_by_pe: dict[_date, dict] = {}
    for pe_val, status_val, n in count_rows:
        counts_by_pe.setdefault(pe_val, {})[status_val] = n

    out = []
    for pe in month_ends:
        # Don't surface the seed-date row as a "real" period
        if pe < t.books_start_date:
            continue
        cnt = {"pending": 0, "reviewed": 0, "approved": 0, "flagged": 0}
        for status_val, n in counts_by_pe.get(pe, {}).items():
            cnt[status_val if status_val in cnt else "pending"] += n
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


@router.post("/admin/close-period", dependencies=[Depends(require_capability("period_lock"))])
async def close_period(
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
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

    # Every account must also still tie out. Defense in depth: with the approval
    # gate + stale re-flag this should already hold, but it also catches an
    # account whose GL moved after approval. Guarantees close ⇒ every account ties.
    unrec = await _unreconciled_accounts(db, pe, [r.qbo_account_id for r in status_rows])
    if unrec:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot close — {len(unrec)} account(s) no longer tie out: "
                + "; ".join(f"{qid} ({reason})" for qid, reason in list(unrec.items())[:10])
                + (" …" if len(unrec) > 10 else "")
            ),
        )

    # Ingest-integrity gate: the last sync's trial balance must have tied out.
    # tb_balanced is False only when our parse of QBO's data didn't balance —
    # closing on questionable inputs would lock the books over bad data. (None =
    # legacy/never-checked → don't block.)
    from models.period_sync import PeriodSync as _PeriodSync
    _ps = (await db.execute(
        select(_PeriodSync).where(_PeriodSync.period_end == pe)
    )).scalar_one_or_none()
    if _ps is not None and _ps.tb_balanced is False:
        _amt = f"${abs(_ps.tb_diff)}" if _ps.tb_diff is not None else "an unknown amount"
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot close — QuickBooks data for {pe.strftime('%b %Y')} didn't tie "
                f"out on the last sync (off by {_amt}). Re-sync from QuickBooks before closing."
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
    closed_id = str(row.id)
    await db.commit()

    # Best-effort: tell the rest of the workspace the books moved. A failure
    # here must never undo a successful close, so it runs after the main commit
    # in its own try/except with its own commit.
    try:
        from modules.notifications.emails import schedule_notification_emails
        from modules.notifications.service import broadcast_workspace, resolve_email_targets
        title = f"Books closed for {pe.isoformat()}"
        cbody = f"{user.email} closed the {pe.isoformat()} period. It's now locked."
        recipients = await broadcast_workspace(
            db, tenant_id=tenant_id,
            type="period_closed",
            title=title,
            body=cbody,
            link="/app",
            exclude_user_id=user.id,
            entity_type="closed_period", entity_id=closed_id,
        )
        await db.commit()
        targets = await resolve_email_targets(db, recipients)
        schedule_notification_emails(
            background_tasks, targets=targets, title=title, body=cbody, link="/app",
        )
    except Exception:
        logger.warning("period-closed notifications failed for %s", pe, exc_info=True)

    # Best-effort: snapshot this month's Insights so the Advisory KPI trend gets
    # a point for the closed month automatically — no separate Insights run
    # needed. Mirrors Insights "Month mode" exactly (period_start = 1st of the
    # month, period_end = the close date) so advisory.kpi_overview reads it as a
    # full-calendar-month point. Runs after the close commit in its own
    # try/except + commit; a QBO/compute failure here must never undo the close.
    try:
        from datetime import UTC as _UTC
        from datetime import datetime as _dt

        from models.insights_snapshot import InsightsSnapshot
        from modules.insights.service import compute_overview

        _month_start = pe.replace(day=1)
        _payload = await compute_overview(db, tenant_id, pe, period_start=_month_start)
        _existing = (await db.execute(
            select(InsightsSnapshot).where(
                InsightsSnapshot.period_end == pe,
                InsightsSnapshot.period_start == _month_start,
            )
        )).scalar_one_or_none()
        _now = _dt.now(_UTC)
        if _existing is not None:
            _existing.payload = _payload
            _existing.computed_at = _now
        else:
            db.add(InsightsSnapshot(
                tenant_id=tenant_id,
                period_end=pe,
                period_start=_month_start,
                payload=_payload,
                computed_at=_now,
            ))
        await db.commit()
    except Exception:
        logger.warning("close-period insights snapshot failed for %s", pe, exc_info=True)

    return {
        "period_end": pe.isoformat(),
        "closed_at":  row.closed_at.isoformat() if row.closed_at else None,
        "closed_by":  str(row.closed_by),
    }


@router.post("/admin/reopen-period", dependencies=[Depends(require_capability("period_lock"))])
async def reopen_period(
    body: dict,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    background_tasks: BackgroundTasks,
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

    closed_id = str(row.id)
    await db.delete(row)

    from core.audit.log import write_audit_event
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.period_reopened",
        entity_type="closed_period", entity_id=closed_id,
        metadata={
            "summary":    f"Reopened period {pe}",
            "period_end": pe.isoformat(),
        },
    )
    await db.commit()

    # Best-effort: let the workspace know the period was unlocked again.
    try:
        from modules.notifications.emails import schedule_notification_emails
        from modules.notifications.service import broadcast_workspace, resolve_email_targets
        title = f"Books reopened for {pe.isoformat()}"
        rbody = f"{user.email} reopened the {pe.isoformat()} period for edits."
        recipients = await broadcast_workspace(
            db, tenant_id=tenant_id,
            type="period_reopened",
            title=title,
            body=rbody,
            link="/app",
            exclude_user_id=user.id,
            entity_type="closed_period", entity_id=closed_id,
        )
        await db.commit()
        targets = await resolve_email_targets(db, recipients)
        schedule_notification_emails(
            background_tasks, targets=targets, title=title, body=rbody, link="/app",
        )
    except Exception:
        logger.warning("period-reopened notifications failed for %s", pe, exc_info=True)

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

    # ── Retained Earnings: combine GL balance + YTD net income ────
    #
    # QBO's TrialBalance shows RE at its prior-year-end carrying
    # value — it does NOT include the current YTD profit (which sits
    # on the P&L until closing entries roll it in at fiscal year-end).
    #
    # For an opening-balance seed dated mid-year, the "true" RE that
    # the user thinks of is RE-per-TB + YTD-NI-from-PL. Seeding just
    # the TB value would understate equity and create a phantom
    # variance on the very first reconciliation against post-seed
    # GL (which DOES start absorbing NI as the year progresses).
    #
    # So: detect RE rows, pull YTD NI for [Jan 1 of seed year, seed_date],
    # and adjust the proposed opening accordingly. We also surface the
    # breakdown (original GL + YTD NI = combined) so the wizard can
    # render the explanation, not just the number.
    #
    # Sign convention: RE is credit-natural so its GL shows negative.
    # YTD NI from P&L is positive when profit. Profit increases the
    # credit balance, i.e. makes RE more negative → combined = gl − ytd_ni.
    from modules.recons.overview import _extract_net_income, _is_retained_earnings

    ytd_ni: Decimal | None = None
    ytd_ni_error: str | None = None
    re_accounts_adjusted: list[str] = []

    re_indexes = [
        i for i, r in enumerate(rows)
        if _is_retained_earnings(r["account_name"], r["account_type"])
    ]

    if re_indexes:
        try:
            ytd_start = seed_date.replace(month=1, day=1)
            pl_report = await _qbo_get(
                conn, db,
                "/reports/ProfitAndLoss",
                params={
                    "start_date":        ytd_start.isoformat(),
                    "end_date":          seed_date.isoformat(),
                    "accounting_method": "Accrual",
                    "minorversion":      "65",
                },
            )
            ytd_ni = _extract_net_income(pl_report)
            if ytd_ni is None:
                ytd_ni_error = "Could not find Net Income row in the YTD P&L."
        except Exception:
            logger.exception("Seed-preview YTD NI pull failed")
            ytd_ni_error = "Could not pull YTD P&L from QuickBooks."

        if ytd_ni is not None:
            ytd_ni_q = ytd_ni.quantize(Decimal("0.01"))
            for i in re_indexes:
                row = rows[i]
                original = Decimal(row["proposed_opening"])
                combined = (original - ytd_ni_q).quantize(Decimal("0.01"))
                row["proposed_opening"]    = str(combined)
                row["original_gl_balance"] = str(original)
                row["ytd_ni_added"]        = str(ytd_ni_q)
                row["combined_with_ytd_ni"] = True
                re_accounts_adjusted.append(row["account_name"])

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
        # Per-account RE adjustment context — frontend uses these to
        # render the "RE balance + YTD NI = combined" breakdown.
        "ytd_ni":               str(ytd_ni.quantize(Decimal("0.01"))) if ytd_ni is not None else None,
        "ytd_ni_period":        [seed_date.replace(month=1, day=1).isoformat(), seed_date.isoformat()] if re_indexes else None,
        "ytd_ni_error":         ytd_ni_error,
        "re_accounts_adjusted": re_accounts_adjusted,
        # P&L accounts in QBO (Income / Expense / COGS) always open at $0
        # at the start of a fiscal year, so we don't seed them. Surface
        # the count so the wizard can explain "you saw N more accounts
        # in your QBO TB" without it looking like a bug.
        "skipped_pl_count": pl_count,
        # Surface WHICH QBO realm + company we're actually pulling from.
        # Critical for debugging "always 36 accounts" reports — without
        # this the user can't tell whether Intuit's picker quietly
        # reused the same sandbox across workspaces. Now it's visible
        # right at the top of the wizard.
        "qbo_source": {
            "realm_id":     conn.realm_id,
            "company_name": conn.company_name,
        },
        "diagnostics": {
            "tb_rows":              len(tb_by_id),
            "tb_names":             list(tb_by_name.keys())[:30],
            "misses":               misses[:20],
            # Raw account count BEFORE we filter to ACCOUNT_TYPE_GROUPS
            # — if this is 36 too, the filter isn't dropping anything
            # and the realm legitimately has 36 of these account types.
            "raw_qbo_account_count":   len(accounts_meta),
            "balance_sheet_kept":      len(rows),
            "balance_sheet_skipped":   pl_count,
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
    # The session tenant filter does NOT scope DELETEs, so the tenant_id
    # predicate is required here — without it this clears rows for this
    # period_end across every tenant, not just the caller's workspace.
    await db.execute(
        delete(AccountReviewStatus).where(
            AccountReviewStatus.tenant_id == tenant_id,
            AccountReviewStatus.period_end == seed_date,
        )
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


@router.get("/account/{qbo_account_id}/schedule-subledger")
async def get_schedule_subledger(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """If this account's subledger IS a Nordavix Schedule (prepaid / accrual /
    fixed asset / lease / loan), return the schedule's AUTHORITATIVE computed
    balance for the period (signed, debit-positive) plus its type. The recon
    form shows this as the build-up's base line — the subledger auto-pulls the
    schedule balance — instead of listing the individual schedule entries. The
    user reconciles GL differences on top by ticking real GL entries.

    Returns is_schedule_backed=false (balance null) for accounts with no
    schedule mapped — those fall back to the rolled-forward opening."""
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    from modules.recons.agentic import _schedule_backed_subledger
    try:
        sched = await _schedule_backed_subledger(db, tenant_id, qbo_account_id, pe)
    except Exception:
        # Degrade gracefully: a schedule-calc error must not 500 this endpoint,
        # or the recon form (which gates its save on this response) would be
        # unable to save. Treat as not-schedule-backed → falls back to the
        # rolled-forward opening, like any other account.
        logger.warning("schedule-subledger calc failed for %s @ %s", qbo_account_id, pe, exc_info=True)
        sched = None
    if sched is None:
        return {"is_schedule_backed": False, "schedule_type": None, "subledger_balance": None, "entries": []}
    return {
        "is_schedule_backed": True,
        "schedule_type":      sched["schedule_type"],
        "subledger_balance":  str(sched["sl_signed"]),
        "item_count":         int(sched.get("item_count") or 0),
        # Per-item balance components (signed) that sum to subledger_balance —
        # the LEFT ("Per Nordavix schedule") column of the recon match view.
        "entries":            sched.get("sl_entries") or [],
    }


@router.get("/account/{qbo_account_id}/period-entries")
async def get_account_period_entries(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    include_ytd_ni: bool = Query(
        False,
        description=(
            "When true (frontend sets this for Retained Earnings accounts), "
            "prepends a synthetic checkable row representing the current "
            "period's YTD net income from the P&L. Ticking it closes the "
            "GL-vs-SL variance for RE accounts that absorb period profit."
        ),
    ),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Return every transaction posted to this account WITHIN the closing
    period (the month containing period_end). Used inside the manual
    subledger modal so the user can select which entries explain the
    GL-vs-subledger variance — the classic bank-rec "outstanding items"
    pattern, persisted on the override row.

    For Retained Earnings accounts (caller sets include_ytd_ni=true),
    we prepend one synthetic row that represents the YTD net income
    auto-rolled from the P&L into RE. Ticking it adds to the subledger
    side so the row ties out without a manual journal entry.

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

    # ── Synthetic YTD net-income row for Retained Earnings ────────
    # Prepended (so it sits at the top of the reconciling-items table)
    # when the caller flags this as an RE account. Pulled from the
    # already-synced PeriodSync.actual_net_income — no QBO call here.
    #
    # Sign convention: actual_net_income is the raw P&L net income
    # (positive when profit, negative when loss). RE is credit-natural,
    # so a closing JE for profit posts as DR Income Summary / CR
    # Retained Earnings — i.e. amount on the RE side is a credit,
    # which in QBO's debit-positive GL convention is -actual_ni.
    # That signed amount, when summed into the subledger by the
    # frontend, closes the GL-vs-SL gap exactly.
    if include_ytd_ni:
        from models.period_sync import PeriodSync
        ps = (await db.execute(
            select(PeriodSync).where(PeriodSync.period_end == pe)
        )).scalar_one_or_none()
        if ps is not None and ps.actual_net_income is not None:
            ytd_ni = Decimal(ps.actual_net_income)
            synthetic_amount = (-ytd_ni).quantize(Decimal("0.01"))
            rows.append({
                "txn_id":     f"system:ytd_ni:{pe.isoformat()}",
                "txn_type":   "System",
                "txn_number": "YTD-NI",
                "txn_date":   pe.isoformat(),
                "amount":     str(synthetic_amount),
                "memo":       (
                    f"Current period net income from P&L ($"
                    f"{ytd_ni:,.2f}) — tick to absorb into Retained Earnings."
                ),
                "entity":     "Income Statement",
            })
            total += synthetic_amount

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
        "source":      "recon",
    }


def _serialize_workpaper_as_evidence(e: WorkpaperEvidence) -> dict:
    """A binder (Workpapers) attachment on this account, shaped like recon
    evidence so it lists in the recon drawer alongside native files. Marked
    source="binder": read-only here (download only) — managed in Workpapers."""
    return {
        "id":          str(e.id),
        "file_name":   e.file_name,
        "file_size":   e.file_size,
        "mime_type":   e.mime_type,
        "uploaded_by": str(e.uploaded_by),
        "uploaded_at": e.uploaded_at.isoformat() if e.uploaded_at else None,
        "verification": e.verification,
        "source":      "binder",
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
    items = [_serialize_evidence(r) for r in rows]

    # Union binder (Workpapers) attachments tied to this account so evidence is
    # symmetric across both surfaces. Read-only here; sorted with native files.
    wp_rows = list((await db.execute(
        select(WorkpaperEvidence).where(
            WorkpaperEvidence.ref_type == "account",
            WorkpaperEvidence.ref_id == qbo_account_id,
            WorkpaperEvidence.period_end == pe,
        ).order_by(desc(WorkpaperEvidence.uploaded_at))
    )).scalars().all())
    items.extend(_serialize_workpaper_as_evidence(e) for e in wp_rows)
    items.sort(key=lambda d: d.get("uploaded_at") or "", reverse=True)
    return {"evidence": items}


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

    # Knowledge graph: this uploaded file supports the account's reconciliation.
    try:
        from core.db.base import tenant_scope
        from core.graph import Node, link
        with tenant_scope(tenant_id):
            await link(
                db, Node("evidence", str(row.id)), "supports",
                Node("reconciliation", f"{qbo_account_id}:{pe.isoformat()}"),
                origin="system", created_by=user.id,
            )
    except Exception:
        import logging
        logging.getLogger(__name__).exception("graph link failed for evidence upload (non-fatal)")

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
    r2_key = row.r2_key if row else None
    file_name = row.file_name if row else None
    mime_type = row.mime_type if row else None
    if row is None:
        # Binder (Workpapers) attachment merged into this account's list —
        # resolve it here so one endpoint serves both stores. Tenant-scoped.
        wp = (await db.execute(
            select(WorkpaperEvidence).where(WorkpaperEvidence.id == evidence_id)
        )).scalar_one_or_none()
        if wp is None:
            raise HTTPException(status_code=404, detail="Evidence not found.")
        r2_key, file_name, mime_type = wp.r2_key, wp.file_name, wp.mime_type
    # Serve inline only for known-safe, non-scriptable types (keyed by file
    # extension, never the stored/client MIME). Anything else is forced to
    # download, so a file uploaded with a spoofed text/html MIME can never be
    # rendered as live HTML from the storage origin. Mirrors the workpapers
    # download hardening via the shared INLINE_SAFE_TYPES allowlist.
    ext = file_name.rsplit(".", 1)[-1].lower() if file_name and "." in file_name else ""
    safe_ctype = r2_storage.INLINE_SAFE_TYPES.get(ext)
    if safe_ctype is not None:
        disposition, content_type = "inline", safe_ctype
    else:
        disposition, content_type = "attachment", mime_type
    url = r2_storage.generate_presigned_download_url(
        r2_key, expires_in=300,
        disposition=disposition, filename=file_name, content_type=content_type,
    )
    return {"download_url": url, "file_name": file_name, "mime_type": mime_type}


@router.post("/evidence/{evidence_id}/verify", dependencies=[Depends(enforce_ai_limits)])
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
    await _block_if_closed(db, ev.period_end)  # locked period — reopen to re-verify

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


@router.post(
    "/clear-synced-data",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_role("admin"))],
)
async def clear_synced_data(
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Wipe all persisted reconciliations / items / transactions / notes for
    this workspace. Useful when the user wants to start fresh (e.g. after
    a QBO re-sync brought in different data, or to clear demo data).
    The QBO connection itself is preserved — only Nordavix-side cached
    reconciliation records are deleted.
    """
    # Delete in FK-safe order: notes → transactions → items → reconciliations.
    # CRITICAL: every DELETE must be scoped to the caller's tenant. The session
    # tenant filter (core/db/session.py) only rewrites SELECTs — it returns early
    # for INSERT/UPDATE/DELETE — and the backend connects as the table owner, so
    # Postgres RLS does NOT scope it either. Without these explicit .where()s an
    # unscoped delete() would wipe EVERY tenant's reconciliation data.
    await db.execute(delete(ReconNote).where(ReconNote.tenant_id == tenant_id))
    await db.execute(delete(ReconTransaction).where(ReconTransaction.tenant_id == tenant_id))
    await db.execute(delete(ReconciliationItem).where(ReconciliationItem.tenant_id == tenant_id))
    await db.execute(delete(Reconciliation).where(Reconciliation.tenant_id == tenant_id))
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.synced_data_cleared", entity_type="reconciliation", entity_id=None,
        metadata={"summary": "Cleared all cached reconciliation data for the workspace"},
    )
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
    await _block_if_closed(db, recon.period_end)
    recon.status = "syncing"
    recon.error_detail = None
    await db.commit()
    background_tasks.add_task(run_sync, recon_id, tenant_id)
    await db.refresh(recon)
    return recon


# ── Approve / assign ──────────────────────────────────────────────────────────

@router.post(
    "/{recon_id}/approve",
    response_model=ReconciliationResponse,
    dependencies=[Depends(require_role("reviewer"))],
)
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
    await _block_if_closed(db, recon.period_end)
    recon.approved_by = user.id
    recon.approved_at = datetime.now(UTC)
    recon.status = "approved"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.approved", entity_type="reconciliation", entity_id=recon.id,
        metadata={"summary": f"Approved reconciliation '{recon.name}'"},
    )
    await db.commit()
    return recon


@router.post("/{recon_id}/assign", response_model=ReconciliationResponse)
async def assign_reconciliation(
    recon_id: uuid.UUID,
    body: AssignBody,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> Reconciliation:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    await _block_if_closed(db, recon.period_end)
    recon.assigned_to = body.user_id
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.assigned", entity_type="reconciliation", entity_id=recon.id,
        metadata={"summary": f"Assigned reconciliation '{recon.name}'"},
    )
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
    await _block_if_closed(db, recon.period_end)
    note = ReconNote(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        reconciliation_id=recon_id,
        reconciliation_item_id=body.reconciliation_item_id,
        author_id=user.id,
        body=body.body,
    )
    db.add(note)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.note_added", entity_type="reconciliation", entity_id=recon_id,
        metadata={"summary": f"Added a note on reconciliation '{recon.name}'"},
    )
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
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is not None:
        await _block_if_closed(db, recon.period_end)
    # Maker/checker: signing off (approving) an item is a reviewer/admin action.
    # A preparer can move items through other statuses but cannot self-approve.
    if body.status == "approved" and user.role == "preparer":
        raise HTTPException(
            status_code=403,
            detail="Only a reviewer or admin can approve a reconciliation item.",
        )
    item.status = body.status
    if body.status == "approved":
        item.approved_by = user.id
        item.approved_at = datetime.now(UTC)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.item_status_changed", entity_type="reconciliation", entity_id=recon_id,
        metadata={"summary": f"Set a reconciliation item to '{body.status}'"},
    )
    await db.commit()
    return item


@router.post("/{recon_id}/items/{item_id}/explain", response_model=ReconciliationItemResponse,
             dependencies=[Depends(enforce_ai_limits)])
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
    await _block_if_closed(db, recon.period_end)

    commentary = await explain_item(db, recon, item)
    if commentary:
        item.ai_commentary = commentary
        await db.commit()
        await db.refresh(item)
    return item


@router.post("/{recon_id}/explain", response_model=ReconciliationResponse,
             dependencies=[Depends(enforce_ai_limits)])
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
    await _block_if_closed(db, recon.period_end)
    summary = await explain_recon_summary(db, recon)
    if summary:
        recon.ai_summary = summary
        await db.commit()
        await db.refresh(recon)
    return recon


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete(
    "/{recon_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_role("reviewer"))],
)
async def delete_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    recon = (await db.execute(
        select(Reconciliation).where(Reconciliation.id == recon_id)
    )).scalar_one_or_none()
    if recon is None:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    await _block_if_closed(db, recon.period_end)
    recon_name = recon.name
    await db.delete(recon)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.deleted", entity_type="reconciliation", entity_id=recon_id,
        metadata={"summary": f"Deleted reconciliation '{recon_name}'"},
    )
    await db.commit()


# ── Export support package (Excel) ────────────────────────────────────────────

@router.get("/{recon_id}/export")
async def export_reconciliation(
    recon_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    Build a per-reconciliation support package (.xlsx). Delegates to
    modules.exports.recon_workbook for a consistent monochrome look
    that matches Period Export, flux variance, and per-schedule
    downloads.
    """
    from io import BytesIO

    from modules.exports.recon_workbook import build_recon_workbook

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
        data, fname = await build_recon_workbook(
            db=db,
            recon_id=recon_id,
            company_name=company_name,
            generated_by_name=generated_by,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Reconciliation not found")
    except Exception:
        logger.exception("Recon workbook build failed")
        raise HTTPException(
            status_code=500,
            detail="Could not build the reconciliation export. Check server logs.",
        )

    return StreamingResponse(
        BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
        },
    )


# ── Bank reconciliation worksheet ─────────────────────────────────────
#
# Bank-type accounts get a dedicated upload + auto-match flow on top
# of the generic recon drawer. The user uploads their statement (CSV
# in v1; PDF via Claude OCR in v2), we parse + persist the lines, run
# the auto-matcher against the period's GL, and surface three buckets:
#
#   cleared    — matched bank ↔ GL → no action
#   bank_only  — on bank, not in GL → user posts a JE in QBO (fees,
#                interest, NSF). The variance gate stays locked
#                until the user posts + re-syncs.
#   gl_only    — in GL, not on bank → outstanding checks / deposits
#                in transit. These auto-flow as reconciling items so
#                the worksheet ties to the bank balance.
#
# Re-uploading wipes prior rows for (account, period) before inserting
# the new batch. Idempotent.

_BANK_CSV_EXTS = {"csv", "txt"}
_BANK_PDF_EXTS = {"pdf"}
_BANK_FILE_EXTS = _BANK_CSV_EXTS | _BANK_PDF_EXTS
_BANK_CSV_MAX_BYTES = 5 * 1024 * 1024   # 5 MB — typical CSV is <500 KB
_BANK_PDF_MAX_BYTES = 15 * 1024 * 1024  # 15 MB — multi-page color statements can be larger


def _serialize_bank_txn(row: BankStatementTxn) -> dict:
    return {
        "id":                str(row.id),
        "txn_date":          row.txn_date.isoformat(),
        "amount":            str(row.amount),
        "description":       row.description,
        "bank_ref":          row.bank_ref,
        "match_status":      row.match_status,
        "matched_gl_txn_id": row.matched_gl_txn_id,
        "match_confidence":  str(row.match_confidence) if row.match_confidence is not None else None,
    }


@router.post("/account/{qbo_account_id}/bank-statement/upload",
             dependencies=[Depends(require_role("preparer"))])
async def upload_bank_statement(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Parse a CSV bank statement, persist the lines, and auto-match
    against the period's GL. Returns the worksheet buckets."""
    from datetime import date as _d
    try:
        pe = _d.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    await _block_if_closed(db, pe)

    name = file.filename or "statement.csv"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in _BANK_FILE_EXTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"File type .{ext} not allowed. Upload a CSV or PDF bank statement."
            ),
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    max_bytes = _BANK_PDF_MAX_BYTES if ext in _BANK_PDF_EXTS else _BANK_CSV_MAX_BYTES
    if len(raw) > max_bytes:
        raise HTTPException(
            status_code=400,
            detail=f"File too large ({len(raw):,} bytes). Max {max_bytes // (1024*1024)} MB.",
        )

    # Dispatch to the right parser by extension. Both return the same
    # shape ([{txn_date, amount, description, bank_ref}, ...]) so the
    # persist + auto-match path below is identical.
    if ext in _BANK_PDF_EXTS:
        from modules.recons.bank_pdf import is_likely_scanned_pdf, parse_bank_pdf
        try:
            parsed, stmt_totals = parse_bank_pdf(raw, filename=name)
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not parsed:
            # Tell the user WHY — scanned vs unfamiliar layout matters.
            if is_likely_scanned_pdf(raw):
                detail = (
                    "This PDF appears to be a scanned image (no extractable text). "
                    "Use your bank's CSV export instead, or convert via a "
                    "text-based PDF tool."
                )
            else:
                detail = (
                    "Couldn't find any transaction rows in the PDF. The layout "
                    "may be unfamiliar — try your bank's CSV export instead, or "
                    "share the PDF with support so we can add this bank's layout."
                )
            raise HTTPException(status_code=400, detail=detail)
    else:
        from modules.recons.bank_csv import parse_bank_csv
        parsed, stmt_totals = parse_bank_csv(raw, filename=name)
        if not parsed:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Couldn't find any transaction rows in the CSV. Expected a header "
                    "row with Date + Amount (or Debit/Credit) + Description columns."
                ),
            )

    # Wipe prior rows for this (account, period) — re-uploads replace.
    await db.execute(
        delete(BankStatementTxn).where(
            BankStatementTxn.tenant_id == tenant_id,
            BankStatementTxn.qbo_account_id == qbo_account_id,
            BankStatementTxn.period_end == pe,
        )
    )

    # Insert fresh rows
    user_uuid = uuid.UUID(str(user.id)) if user else None
    for p in parsed:
        db.add(BankStatementTxn(
            tenant_id=tenant_id,
            qbo_account_id=qbo_account_id,
            period_end=pe,
            txn_date=p["txn_date"],
            amount=p["amount"],
            description=p.get("description"),
            bank_ref=p.get("bank_ref"),
            statement_filename=name,
            uploaded_by=user_uuid,
            match_status="unmatched",
        ))

    # Upsert the statement header: control totals + cross-foot tie-out. This
    # is what lets the worksheet flag a parse that dropped a line (opening +
    # activity won't equal ending) instead of silently under-reporting.
    from models.bank_statement import BankStatement
    line_sum = sum((p["amount"] for p in parsed), Decimal("0"))
    opening = stmt_totals.get("opening_balance")
    ending = stmt_totals.get("ending_balance")
    tie_ok, tie_diff = _compute_tie_out(opening, ending, line_sum)
    header = (await db.execute(
        select(BankStatement).where(
            BankStatement.tenant_id == tenant_id,
            BankStatement.qbo_account_id == qbo_account_id,
            BankStatement.period_end == pe,
        )
    )).scalar_one_or_none()
    if header is None:
        header = BankStatement(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            qbo_account_id=qbo_account_id,
            period_end=pe,
        )
        db.add(header)
    header.statement_filename = name
    header.opening_balance = opening
    header.ending_balance = ending
    header.line_sum = line_sum
    header.tie_out_ok = tie_ok
    header.tie_out_diff = tie_diff
    header.uploaded_by = user_uuid
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.bank_statement_uploaded", entity_type="bank_statement", entity_id=header.id,
        metadata={"summary": f"Uploaded bank statement '{name}' for account {qbo_account_id} ({pe})"},
    )
    await db.commit()

    # Run match (fresh GL pull → cached on the header) + return worksheet.
    return await _run_bank_match(db, tenant_id, qbo_account_id, pe, refresh=True)


@router.get("/account/{qbo_account_id}/bank-statement")
async def get_bank_statement_worksheet(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    refresh: bool = Query(False, description="Force a fresh GL pull from QBO"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return the current bank-rec worksheet for (account, period). If
    nothing has been uploaded yet, returns an empty-state payload. GL is
    served from the cache unless refresh=1 (or the cache is empty)."""
    from datetime import date as _d
    try:
        pe = _d.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    return await _run_bank_match(db, tenant_id, qbo_account_id, pe, refresh=refresh)


@router.delete("/account/{qbo_account_id}/bank-statement",
               dependencies=[Depends(require_role("preparer"))])
async def clear_bank_statement(
    qbo_account_id: str,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    period_end: str = Query(..., description="Period end YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Wipe all uploaded bank statement rows for (account, period).
    Used when the user uploaded the wrong statement and wants to start
    fresh without re-uploading."""
    from datetime import date as _d
    try:
        pe = _d.fromisoformat(period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")

    await _block_if_closed(db, pe)

    result = await db.execute(
        delete(BankStatementTxn).where(
            BankStatementTxn.tenant_id == tenant_id,
            BankStatementTxn.qbo_account_id == qbo_account_id,
            BankStatementTxn.period_end == pe,
        )
    )
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="recon.bank_statement_deleted", entity_type="bank_statement", entity_id=None,
        metadata={"summary": f"Deleted the uploaded bank statement for account {qbo_account_id} ({pe})"},
    )
    await db.commit()
    return {"deleted": result.rowcount or 0}


# ── Bank statement: control totals, GL cache + approval-gate helpers ─────

_TIE_OUT_TOLERANCE = Decimal("0.01")
_STATEMENT_REQUIRED_MSG = (
    "Attach the bank statement (or supporting evidence) before approving "
    "this bank reconciliation."
)


def _compute_tie_out(
    opening: Decimal | None,
    ending: Decimal | None,
    line_sum: Decimal,
) -> tuple[bool | None, Decimal | None]:
    """Cross-foot: opening + Σ line activity should equal ending. Returns
    (ok, diff). (None, None) when opening/ending weren't parsed — the caller
    surfaces 'couldn't verify totals', not a tie-out failure."""
    if opening is None or ending is None:
        return None, None
    diff = (opening + line_sum) - ending
    return (abs(diff) < _TIE_OUT_TOLERANCE), diff


def _gl_to_cache(gl_txns: list[dict]) -> list[dict]:
    """JSON-safe form of the pulled GL txns for storage on the header."""
    out: list[dict] = []
    for g in gl_txns:
        td = g.get("txn_date")
        out.append({
            "qbo_txn_id":  g.get("qbo_txn_id"),
            "txn_type":    g.get("txn_type"),
            "txn_number":  g.get("txn_number"),
            "txn_date":    td.isoformat() if td else None,
            "amount":      str(g.get("amount") or "0"),
            "memo":        g.get("memo"),
            "entity_name": g.get("entity_name"),
        })
    return out


def _gl_from_cache(cached: list[dict]) -> list[dict]:
    """Rehydrate cached GL txns (str→Decimal, ISO→date) for the matcher."""
    from datetime import date as _d
    out: list[dict] = []
    for g in (cached or []):
        td = g.get("txn_date")
        out.append({
            "qbo_txn_id":  g.get("qbo_txn_id"),
            "txn_type":    g.get("txn_type"),
            "txn_number":  g.get("txn_number"),
            "txn_date":    _d.fromisoformat(td) if td else None,
            "amount":      Decimal(str(g.get("amount") or "0")),
            "memo":        g.get("memo"),
            "entity_name": g.get("entity_name"),
        })
    return out


def _serialize_statement_totals(header) -> dict:
    """Statement control-total block for the worksheet payload."""
    if header is None:
        return {
            "opening_balance": None, "ending_balance": None,
            "line_sum": None, "tie_out_ok": None, "tie_out_diff": None,
        }
    def _s(v):
        return str(v) if v is not None else None
    return {
        "opening_balance": _s(header.opening_balance),
        "ending_balance":  _s(header.ending_balance),
        "line_sum":        _s(header.line_sum),
        "tie_out_ok":      header.tie_out_ok,
        "tie_out_diff":    _s(header.tie_out_diff),
    }


async def _account_type_for(
    db: AsyncSession, tenant_id: uuid.UUID, qbo_account_id: str,
) -> str | None:
    """QBO AccountType (e.g. 'Bank', 'Credit Card') for an account, read from
    the latest GL balance snapshot. None when the account isn't synced — the
    caller then skips type-specific gating (fail-open for unknown accounts)."""
    from models.gl_balance_snapshot import GlBalanceSnapshot
    return (await db.execute(
        select(GlBalanceSnapshot.account_type).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.qbo_account_id == qbo_account_id,
        ).order_by(GlBalanceSnapshot.period_end.desc()).limit(1)
    )).scalar_one_or_none()


async def _bank_acct_missing_statement(
    db: AsyncSession, tenant_id: uuid.UUID, qbo_account_id: str, period_end,
) -> bool:
    """True when this is a Bank/Credit-Card account with neither a parsed bank
    statement nor an attached evidence file for the period — i.e. approval
    should be blocked. Returns False for any non-bank account."""
    acct_type = await _account_type_for(db, tenant_id, qbo_account_id)
    if acct_type not in ("Bank", "Credit Card"):
        return False
    has_statement = (await db.execute(
        select(BankStatementTxn.id).where(
            BankStatementTxn.tenant_id == tenant_id,
            BankStatementTxn.qbo_account_id == qbo_account_id,
            BankStatementTxn.period_end == period_end,
        ).limit(1)
    )).first() is not None
    if has_statement:
        return False
    has_evidence = (await db.execute(
        select(SubledgerEvidence.id).where(
            SubledgerEvidence.tenant_id == tenant_id,
            SubledgerEvidence.qbo_account_id == qbo_account_id,
            SubledgerEvidence.period_end == period_end,
        ).limit(1)
    )).first() is not None
    return not has_evidence


async def _unreconciled_accounts(
    db: AsyncSession, period_end, qbo_ids: list[str], ov: dict | None = None,
) -> dict[str, str]:
    """Of the given accounts, return {qbo_account_id: reason} for those NOT
    reconciled for the period — reason is a short human string ('off by $X' or
    'not synced for this period'). Uses the same snapshot-backed builder the
    dashboard renders from, so the gate's variance matches the UI exactly. An
    account with no synced balance counts as unreconciled (you can't sign off an
    account the period was never synced for).

    Pass a pre-built `ov` (read_overview_from_snapshots result) to reuse the
    caller's overview instead of rebuilding it; omitted, it builds its own."""
    from modules.recons.overview import is_reconciled, read_overview_from_snapshots
    if ov is None:
        ov = await read_overview_from_snapshots(db, period_end)
    by_id = {a["qbo_id"]: a for a in ov.get("accounts", [])}
    out: dict[str, str] = {}
    for qid in set(qbo_ids):
        a = by_id.get(qid)
        if a is None:
            out[qid] = "not synced for this period"
            continue
        gl = Decimal(a["gl_balance"])
        sub = Decimal(a["subledger_balance"])
        if not is_reconciled(gl, sub):
            out[qid] = f"off by ${abs(gl - sub).quantize(Decimal('0.01'))}"
    return out


async def _reflag_stale_approvals(
    db: AsyncSession, tenant_id, period_end, overview: dict, user, background_tasks,
) -> int:
    """After a re-sync, revert any approved account that no longer ties out back
    to 'reviewed' (clearing the approval) and notify its approver — a sign-off
    must always match the live books. Returns the count reverted. Mirrors the
    per-account sync's revert behavior, scoped to genuinely-stale rows."""
    from modules.recons.overview import is_reconciled
    stale_ids = {
        a["qbo_id"] for a in overview.get("accounts", [])
        if a.get("review_status") == "approved"
        and not is_reconciled(Decimal(a["gl_balance"]), Decimal(a["subledger_balance"]))
    }
    if not stale_ids:
        return 0
    rows = list((await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.period_end == period_end,
            AccountReviewStatus.qbo_account_id.in_(stale_ids),
            AccountReviewStatus.status == "approved",
        )
    )).scalars().all())
    if not rows:
        return 0
    approvers: set[uuid.UUID] = set()
    for r in rows:
        if r.approved_by:
            approvers.add(r.approved_by)
        r.status = "reviewed"
        r.approved_by = None
        r.approved_at = None
    await db.commit()
    # Reflect the revert in the overview payload we're about to return (it was
    # built before the revert) so the client cache shows the corrected status
    # immediately rather than on the next GET.
    reverted = {r.qbo_account_id for r in rows}
    for a in overview.get("accounts", []):
        if a["qbo_id"] in reverted:
            a["review_status"] = "reviewed"
    # Tell the approver(s) their sign-off was cleared by the re-sync.
    try:
        from modules.notifications.emails import notify_and_email_users
        recipients = [a for a in approvers if a != user.id]
        if recipients:
            await notify_and_email_users(
                db, background_tasks, tenant_id=tenant_id, recipient_ids=recipients,
                type="recon_reopened",
                title=f"{len(rows)} reconciliation(s) need re-review",
                body=(
                    f"{user.email} re-synced {period_end.isoformat()} and "
                    f"{len(rows)} approved account(s) no longer tie out — "
                    "they were moved back to review."
                ),
                link="/app/reconciliations",
            )
    except Exception:
        logger.warning("recon stale re-flag notifications failed", exc_info=True)
    return len(rows)


async def _run_bank_match(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    qbo_account_id: str,
    period_end,
    refresh: bool = False,
) -> dict:
    """Shared core: load bank txns + GL txns, run matcher, return worksheet
    payload.

    The GL pull is cached on the bank_statements header, so opening the
    worksheet is a DB read — we only hit QBO on upload or an explicit refresh
    (or the very first view, when the cache is empty). A cached read is
    side-effect-free; only a fresh pull writes match results back."""
    from datetime import date as _d

    from models.bank_statement import BankStatement
    from modules.recons.bank_match import match_bank_to_gl, summarize

    bank_rows = list((await db.execute(
        select(BankStatementTxn).where(
            BankStatementTxn.tenant_id == tenant_id,
            BankStatementTxn.qbo_account_id == qbo_account_id,
            BankStatementTxn.period_end == period_end,
        ).order_by(BankStatementTxn.txn_date)
    )).scalars().all())

    header = (await db.execute(
        select(BankStatement).where(
            BankStatement.tenant_id == tenant_id,
            BankStatement.qbo_account_id == qbo_account_id,
            BankStatement.period_end == period_end,
        )
    )).scalar_one_or_none()

    if not bank_rows:
        return {
            "uploaded":  False,
            "filename":  None,
            "uploaded_at": None,
            "cleared":   [],
            "bank_only": [],
            "gl_only":   [],
            "summary":   {
                "cleared_count": 0, "bank_only_count": 0, "gl_only_count": 0,
                "cleared_total": "0", "bank_only_total": "0", "gl_only_total": "0",
            },
            "statement_totals": _serialize_statement_totals(header),
        }

    # GL transactions — serve from cache unless asked to refresh or the cache
    # is empty (first view). Only this branch touches QBO.
    need_pull = refresh or header is None or not header.gl_txns_cache
    gl_txns: list[dict] = []
    if need_pull:
        period_start = _d(period_end.year, period_end.month, 1)
        conn = (await db.execute(
            select(QboConnection).where(QboConnection.tenant_id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        if conn is not None:
            from core.qbo_gl import pull_gl_transactions
            try:
                gl_txns = await pull_gl_transactions(
                    conn, db, qbo_account_id, period_start, period_end,
                )
            except Exception:
                logger.exception("Bank match: GL pull failed for acct=%s", qbo_account_id)
        # Cache the fresh pull on the header (create it if missing).
        if header is None:
            header = BankStatement(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                qbo_account_id=qbo_account_id,
                period_end=period_end,
                statement_filename=bank_rows[0].statement_filename,
            )
            db.add(header)
        header.gl_txns_cache = _gl_to_cache(gl_txns)
        header.gl_refreshed_at = datetime.now(UTC)
    else:
        gl_txns = _gl_from_cache(header.gl_txns_cache)

    bank_dicts = [
        {
            "id":          str(b.id),
            "txn_date":    b.txn_date,
            "amount":      b.amount,
            "description": b.description,
            "bank_ref":    b.bank_ref,
        }
        for b in bank_rows
    ]

    cleared, bank_only, gl_only = match_bank_to_gl(bank_dicts, gl_txns)

    # Persist match results onto the bank rows only when we pulled fresh GL —
    # a cached read stays a side-effect-free GET.
    if need_pull:
        cleared_by_bank_id = {c["bank"]["id"]: c for c in cleared}
        for row in bank_rows:
            m = cleared_by_bank_id.get(str(row.id))
            if m:
                row.match_status      = "cleared"
                row.matched_gl_txn_id = m["gl"].get("qbo_txn_id")
                row.match_confidence  = Decimal(str(m["score"]))
            else:
                row.match_status      = "bank_only"
                row.matched_gl_txn_id = None
                row.match_confidence  = None
        # Draft adjusting entries for the bank-only items (fees, interest,
        # NSF) so the user can review + copy a JE into QBO instead of
        # re-deriving it. Best-effort + idempotent (replaces only OPEN bank
        # proposals for this account+period); part of the same fresh-pull
        # transaction so a cached read stays side-effect-free.
        try:
            from modules.adjustments.service import generate_bank_proposals
            await generate_bank_proposals(
                db,
                tenant_id=tenant_id,
                qbo_account_id=qbo_account_id,
                period_end=period_end,
                bank_only=bank_only,
            )
        except Exception:
            logger.exception("Bank proposed-entry generation failed for acct=%s", qbo_account_id)
        await db.commit()

    def _ser_bank(bd: dict, status: str, matched: str | None = None, conf=None) -> dict:
        return {
            "id":                bd["id"],
            "txn_date":          bd["txn_date"].isoformat(),
            "amount":            str(bd["amount"]),
            "description":       bd["description"],
            "bank_ref":          bd["bank_ref"],
            "match_status":      status,
            "matched_gl_txn_id": matched,
            "match_confidence":  str(conf) if conf is not None else None,
        }

    def _serialize_gl(g: dict) -> dict:
        td = g.get("txn_date")
        return {
            "qbo_txn_id":  g.get("qbo_txn_id"),
            "txn_date":    td.isoformat() if td else None,
            "txn_type":    g.get("txn_type"),
            "txn_number":  g.get("txn_number"),
            "amount":      str(g.get("amount") or 0),
            "memo":        g.get("memo"),
            "entity_name": g.get("entity_name"),
        }

    return {
        "uploaded":    True,
        "filename":    bank_rows[0].statement_filename,
        "uploaded_at": bank_rows[0].uploaded_at.isoformat() if bank_rows[0].uploaded_at else None,
        "cleared":     [
            {
                "bank":  _ser_bank(c["bank"], "cleared", c["gl"].get("qbo_txn_id"), c["score"]),
                "gl":    _serialize_gl(c["gl"]),
                "score": c["score"],
            }
            for c in cleared
        ],
        "bank_only":   [_ser_bank(b, "bank_only") for b in bank_only],
        "gl_only":     [_serialize_gl(g) for g in gl_only],
        "summary":     summarize(cleared, bank_only, gl_only),
        "statement_totals": _serialize_statement_totals(header),
    }
