"""
Per-account reconciliation PDF data — the gather the Close Binder reuses.

This mirrors the data assembly inside modules/recons/router.py's
export_account_pdf endpoint: the strict roll-forward opening
(pick_rollforward_opening), the credit-natural subledger build-up, and the
Clerk-resolved prepared/approved names. It is kept here so the binder renders
packets IDENTICAL to the per-account download. When that endpoint is next
touched it should delegate here so there is a single source of truth.

Read-only: unlike the endpoint, this never opportunistically backfills
User.email from Clerk — a binder export must not write.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.clerk_users import _format_display_name, get_clerk_user
from models.account_review_status import AccountReviewStatus
from models.gl_balance_snapshot import GlBalanceSnapshot
from models.subledger_evidence import SubledgerEvidence
from models.user import User
from modules.recons.overview import pick_rollforward_opening

logger = logging.getLogger(__name__)

# Accounts whose natural balance is a credit — reconciling items flip sign so
# the build-up lands on the same signed basis as the GL snapshot. Mirrors the
# set in modules/recons/router.py::export_account_pdf.
_CREDIT_NATURAL = {
    "Accounts Payable", "Credit Card",
    "Other Current Liability", "Long Term Liability", "Equity",
}


async def gather_account_pdf_data(
    db: AsyncSession, *, tenant_id: uuid.UUID, qbo_account_id: str,
    period_end: date, company: str, user_email: str = "",
) -> dict | None:
    """Build the `data` dict consumed by modules.recons.pdf.build_account_pdf.
    Returns None when there's no GL snapshot for (account, period)."""
    snap = (await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.qbo_account_id == qbo_account_id,
            GlBalanceSnapshot.period_end == period_end,
        )
    )).scalar_one_or_none()
    if snap is None:
        return None

    review = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end == period_end,
        )
    )).scalar_one_or_none()

    # Opening balance — strict close-and-roll chain (prior reconciled
    # subledger only; no GL fallback), same as the dashboard + endpoint.
    prior = (await db.execute(
        select(AccountReviewStatus).where(
            AccountReviewStatus.qbo_account_id == qbo_account_id,
            AccountReviewStatus.period_end < period_end,
            AccountReviewStatus.subledger_total.is_not(None),
        ).order_by(AccountReviewStatus.period_end.desc()).limit(1)
    )).scalar_one_or_none()
    chosen = pick_rollforward_opening(prior)
    if chosen is None:
        opening_balance = Decimal("0")
        opening_source = "No prior reconciled period on file — opening assumed $0"
    else:
        opening_balance = chosen[1]
        opening_source = f"Rolled forward from {chosen[0].isoformat()} closing subledger"

    ev_rows = list((await db.execute(
        select(SubledgerEvidence).where(
            SubledgerEvidence.qbo_account_id == qbo_account_id,
            SubledgerEvidence.period_end == period_end,
        ).order_by(SubledgerEvidence.uploaded_at.desc())
    )).scalars().all())

    # Resolve actor names (Clerk "First Last" → email → stub). No backfill.
    actor_ids: list[uuid.UUID] = [
        uid for uid in (
            getattr(review, "prepared_by", None) if review else None,
            getattr(review, "approved_by", None) if review else None,
        ) if uid
    ]
    names_by_id: dict[uuid.UUID, str] = {}
    if actor_ids:
        for u in list((await db.execute(
            select(User).where(User.id.in_(actor_ids))
        )).scalars().all()):
            display: str | None = None
            if u.clerk_user_id:
                cu = await get_clerk_user(u.clerk_user_id)
                if cu:
                    display = _format_display_name(cu)
            if not display:
                display = u.email or None
            names_by_id[u.id] = display or f"User {str(u.id)[:8]}"

    is_credit_natural = snap.account_type in _CREDIT_NATURAL

    # Items rendered in the build-up. Default = the saved reconciling items.
    # Schedule-backed accounts replace this with the schedule's own roll-forward
    # (opening + activity) so the PRINTED build-up foots to the LIVE Nordavix
    # schedule — the same authoritative subledger the dashboard shows — instead
    # of a possibly-stale stored subledger_total.
    reconciling_items_out = (review.reconciling_items if review else []) or []

    sched = None
    try:
        from modules.recons.agentic import _schedule_backed_subledger
        sched = await _schedule_backed_subledger(db, tenant_id, qbo_account_id, period_end)
    except Exception:
        logger.warning(
            "pdf: schedule subledger calc failed for %s @ %s — using stored subledger",
            qbo_account_id, period_end, exc_info=True,
        )
        sched = None

    if sched is not None:
        from modules.recons.overview import _SCHEDULE_SL_LABEL
        sl_signed = Decimal(str(sched.get("sl_signed") or "0"))
        sl_entries = sched.get("sl_entries") or []
        # sl_entries[0] is the opening (roll-forward anchor); the rest are this
        # period's activity (amortization / depreciation / accretion / …) and,
        # by construction, opening + Σ activity == sl_signed.
        opening_balance = Decimal(str(sl_entries[0].get("amount") or "0")) if sl_entries else Decimal("0")
        label = _SCHEDULE_SL_LABEL.get(str(sched.get("schedule_type") or ""), "schedule")
        opening_source = f"Per Nordavix {label} schedule — balance at prior period end"
        # Activity lines → build-up items carrying the schedule's signed
        # (debit-positive) amount. The "schedule-" prefix tells pdf._buildup NOT
        # to re-flip them for credit-natural accounts.
        schedule_items = [
            {
                "txn_id":     f"schedule-{i}",
                "txn_type":   "Schedule",
                "txn_number": "",
                "txn_date":   e.get("date") or period_end.isoformat(),
                "amount":     str(e.get("amount") or "0"),
                "memo":       e.get("label") or "Schedule activity",
                "cleared":    True,
            }
            for i, e in enumerate(sl_entries[1:], start=1)
        ]
        # The schedule is the COMPLETE subledger — its closing already includes
        # the period's amortization / depreciation / accretion, so nothing is
        # added on top (matching the dashboard). The build-up IS the schedule's
        # own roll-forward (opening + activity); only explicitly-open
        # (cleared=False) saved items still flow through, for the separate "open
        # items" section.
        subledger_balance = sl_signed
        open_items = [
            it for it in ((review.reconciling_items if review else []) or [])
            if it.get("cleared") is False
        ]
        reconciling_items_out = schedule_items + open_items
    elif review and review.subledger_total is not None:
        subledger_balance = Decimal(review.subledger_total)
    else:
        subledger_balance = opening_balance
        for it in (review.reconciling_items if review else []) or []:
            if it.get("cleared") is False:
                continue
            is_manual = str(it.get("txn_id", "")).startswith("manual-")
            raw = Decimal(str(it.get("amount", "0") or "0"))
            signed = raw if is_manual else ((-1 if is_credit_natural else 1) * raw)
            subledger_balance += signed

    status_str = review.status if review else "pending"
    is_draft = status_str != "approved"

    return {
        "company":            company,
        "account_number":     snap.account_number or "",
        "account_name":       snap.account_name,
        "account_type":       snap.account_type,
        "period_end":         period_end,
        "status":             status_str,
        "gl_balance":         str(snap.balance),
        "subledger_balance":  str(subledger_balance),
        "opening_balance":    str(opening_balance),
        "opening_source":     opening_source,
        "is_credit_natural":  is_credit_natural,
        "reconciling_items":  reconciling_items_out,
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
        "prepared_by":        user_email or "",
        "ai_commentary":      (review.ai_commentary if review else None),
    }
