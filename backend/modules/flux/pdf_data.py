"""
Per-variance flux PDF data — the gather the Close Binder reuses.

Mirrors the data assembly inside modules/flux/router.py's export_variance_pdf
endpoint so binder packets are identical to the per-variance download. Reads
the STORED VarianceTransaction rows (not a live QBO pull), so the binder stays
byte-stable for a closed period. When that endpoint is next touched it should
delegate here.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account import Account
from models.narrative import Narrative
from models.trial_balance import TrialBalance
from models.user import User
from models.variance import Variance
from models.variance_transaction import VarianceTransaction

logger = logging.getLogger(__name__)


async def gather_variance_pdf_data(
    db: AsyncSession, *, tb: TrialBalance, acct: Account, var: Variance,
    company: str, user_email: str = "",
) -> dict:
    """Build the `data` dict consumed by modules.flux.pdf.build_variance_pdf."""
    txns = list((await db.execute(
        select(VarianceTransaction)
        .where(VarianceTransaction.variance_id == var.id)
        .order_by(VarianceTransaction.txn_date.desc().nullslast())
    )).scalars().all())

    narr = (await db.execute(
        select(Narrative).where(Narrative.variance_id == var.id)
    )).scalar_one_or_none()

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
                    logger.debug("binder: flux approver clerk lookup failed", exc_info=True)

    return {
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
        "exported_by":      user_email or "",
        "is_draft":         var.status != "approved",
    }
