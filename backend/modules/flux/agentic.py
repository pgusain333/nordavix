"""
Agentic preparer for Flux Analysis.

Iterates every material variance on a TB that doesn't yet have AI
commentary and runs `generate_narrative_async` inline for each one.
Cooperative-cancellable so the user can stop mid-run from the UI.

Returns a structured result the UI uses to render the post-run banner
("Wrote commentary on 12, skipped 3 (already done), 1 failed").
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.account import Account
from models.trial_balance import TrialBalance
from models.user import User
from models.variance import Variance
from modules.flux.deep_agentic import run_deep_agentic_for_variance

logger = logging.getLogger(__name__)


# ── Cooperative cancellation ────────────────────────────────────────────────
# Per-process registry keyed by (tenant_id, tb_id). Same pattern as the
# recons agentic flow — works for single-machine deploys; would need Redis
# for cross-process coordination.

_CANCEL_FLAGS: set[tuple[str, str]] = set()


def request_cancel(tenant_id: uuid.UUID, tb_id: uuid.UUID) -> None:
    _CANCEL_FLAGS.add((str(tenant_id), str(tb_id)))


def _is_cancelled(tenant_id: uuid.UUID, tb_id: uuid.UUID) -> bool:
    return (str(tenant_id), str(tb_id)) in _CANCEL_FLAGS


def _clear_cancel(tenant_id: uuid.UUID, tb_id: uuid.UUID) -> None:
    _CANCEL_FLAGS.discard((str(tenant_id), str(tb_id)))


# ── Result shape ────────────────────────────────────────────────────────────

@dataclass
class VarianceResult:
    variance_id:    str
    account_name:   str
    account_number: str
    action:         str  # "generated" | "skipped" | "failed"
    reason:         str = ""


@dataclass
class AgenticFluxResult:
    tb_id:          str
    started_at:     str
    finished_at:    str
    processed:      int = 0   # narratives generated this run
    skipped:        int = 0   # already had narratives, or non-material
    failed:         int = 0
    variances:      list[VarianceResult] = field(default_factory=list)


# ── Main entry point ────────────────────────────────────────────────────────

async def run_agentic_flux(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    user: User,  # noqa: ARG001 — reserved for audit trail later
    tb_id: uuid.UUID,
) -> AgenticFluxResult:
    """
    Iterate every MATERIAL variance on the TB whose narrative isn't done
    yet (status in pending / generating / flagged) and run the same AI
    commentary generator the per-row "Regenerate" button uses.

    Already-approved variances are skipped (the user signed off on those).
    Already-generated variances are skipped (no re-write unless the user
    explicitly hits Regenerate on a single row).
    """
    start_dt = datetime.now(UTC)
    result = AgenticFluxResult(
        tb_id=str(tb_id),
        started_at=start_dt.isoformat(),
        finished_at=start_dt.isoformat(),  # updated at the end
    )

    # Clear stale cancel from a previous run.
    _clear_cancel(tenant_id, tb_id)

    # Sanity-check the TB exists for this tenant.
    tb = (await db.execute(
        select(TrialBalance).where(TrialBalance.id == tb_id)
    )).scalar_one_or_none()
    if tb is None:
        result.skipped = 1
        result.variances.append(VarianceResult(
            variance_id="*", account_name="(not found)", account_number="",
            action="skipped",
            reason="Trial balance not found for this tenant.",
        ))
        result.finished_at = datetime.now(UTC).isoformat()
        return result

    # Load every material variance still awaiting commentary. Variance
    # doesn't carry trial_balance_id directly — it's on Account — so we
    # JOIN and filter through Account.trial_balance_id. Fetching Account
    # in the same query also gives us account_name / account_number for
    # the per-variance result entries (those fields live on Account,
    # not Variance). Order by absolute variance descending so the
    # most-impactful rows get commentary first — if the user cancels
    # mid-run they at least got the biggest movers explained.
    rows = (await db.execute(
        select(Variance, Account)
        .join(Account, Variance.account_id == Account.id)
        .where(
            Account.trial_balance_id == tb_id,
            Variance.is_material.is_(True),
            Variance.status.in_(("pending", "generating", "flagged")),
        )
    )).all()
    candidates: list[tuple[Variance, Account]] = list(rows)

    # Sort by |dollar_variance| descending in Python (Decimal-friendly).
    candidates.sort(key=lambda pair: abs(pair[0].dollar_variance or 0), reverse=True)

    if not candidates:
        result.skipped = 1
        result.variances.append(VarianceResult(
            variance_id="*",
            account_name="(nothing to do)",
            account_number="",
            action="skipped",
            reason=(
                "No material variances awaiting commentary. Every "
                "material row already has a narrative — use the per-row "
                "Regenerate button to refresh a specific one."
            ),
        ))
        result.finished_at = datetime.now(UTC).isoformat()
        return result

    # Inline generation — sequential so each one commits cleanly before
    # we check the cancel flag again.
    for v, acct in candidates:
        if _is_cancelled(tenant_id, tb_id):
            _clear_cancel(tenant_id, tb_id)
            result.variances.append(VarianceResult(
                variance_id="*",
                account_name="(stopped by user)",
                account_number="",
                action="skipped",
                reason=(
                    "Stopped before processing this variance. Narratives "
                    "already written above were saved; the rest are "
                    "untouched. Click Run AI again to resume."
                ),
            ))
            result.skipped += 1
            break
        try:
            # Deeper agentic — auto-pulls QBO transactions, runs the
            # structured-output prompt, persists both ai_commentary
            # (structured) and Narrative.content (legacy prose).
            commentary = await run_deep_agentic_for_variance(
                db=db, tenant_id=tenant_id, variance_id=v.id,
            )
            await db.commit()  # commit per variance so cancel mid-run preserves work
            risk = commentary.get("risk_level", "medium")
            justified = commentary.get("justified", "needs_review")
            result.processed += 1
            result.variances.append(VarianceResult(
                variance_id=str(v.id),
                account_name=acct.account_name or "",
                account_number=acct.account_number or "",
                action="generated",
                reason=f"Risk {risk}; justified: {justified}.",
            ))
        except Exception as exc:
            logger.exception(
                "Agentic flux failed on variance %s (%s)",
                v.id, acct.account_name,
            )
            result.failed += 1
            result.variances.append(VarianceResult(
                variance_id=str(v.id),
                account_name=acct.account_name or "",
                account_number=acct.account_number or "",
                action="failed",
                reason=f"Internal error: {type(exc).__name__}: {str(exc)[:120]}",
            ))

    result.finished_at = datetime.now(UTC).isoformat()
    return result
