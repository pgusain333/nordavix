"""
Celery tasks for async AI narrative generation.

Each task:
1. Sets current_tenant_id for ORM tenant scoping.
2. Loads Variance + Account from DB.
3. Checks narrative cache (SHA-256 hash of inputs).
4. If cache miss: calls Anthropic API to generate commentary.
5. Persists Narrative + updates Variance.status.
6. Marks TB as ready_for_review when all material variances have narratives.
"""
import asyncio
import hashlib
import re
import uuid
from decimal import Decimal

import anthropic

from celery_app import celery_app
from core.config import settings
from core.db.base import current_tenant_id


def _strip_markdown(text: str) -> str:
    """Belt-and-suspenders cleanup of any markdown the model leaks despite the prompt rules."""
    cleaned = text
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*",     r"\1", cleaned)
    cleaned = re.sub(r"__([^_]+)__",     r"\1", cleaned)
    cleaned = re.sub(r"^#{1,6}\s+",      "",    cleaned, flags=re.M)
    cleaned = re.sub(r"`([^`]+)`",       r"\1", cleaned)
    cleaned = cleaned.replace("—", "-").replace("–", "-")
    cleaned = re.sub(r"^[ \t]*-{2,}[ \t]*$", "", cleaned, flags=re.M)
    return cleaned.strip()


@celery_app.task(
    bind=True,
    name="flux.generate_narrative",
    max_retries=3,
    default_retry_delay=10,
)
def generate_narrative_task(self: object, variance_id: str, tenant_id: str) -> dict[str, str]:
    """
    Generate an AI narrative for one variance row.
    Runs the async implementation via asyncio.run().

    NOTE: This Celery path is kept for environments that run a worker.
    On Fly.io (no separate worker process today), the API routes use
    `generate_narrative_async` directly via FastAPI BackgroundTasks instead.
    """
    # Set tenant context before any DB operation
    tid = uuid.UUID(tenant_id)
    current_tenant_id.set(tid)

    try:
        result = asyncio.run(_generate(variance_id, tenant_id))
        return result
    except Exception as exc:
        # Retry on transient errors
        raise self.retry(exc=exc)  # type: ignore[attr-defined]


async def generate_narrative_async(variance_id: str, tenant_id: str) -> dict[str, str]:
    """
    Background-task entrypoint used by FastAPI when no Celery worker is running.

    Sets the tenant context (because background tasks run outside the request)
    and never raises — failures are logged but must not crash the worker pool.
    """
    import logging
    logger = logging.getLogger(__name__)

    try:
        tid = uuid.UUID(tenant_id)
        current_tenant_id.set(tid)
        return await _generate(variance_id, tenant_id)
    except Exception:
        logger.exception("Variance narrative generation failed (variance=%s)", variance_id)
        # Best-effort: mark the variance as flagged so the UI doesn't poll forever
        try:
            from sqlalchemy import select
            from core.db.session import get_async_session_context
            from models.variance import Variance

            async with get_async_session_context() as session:
                var = (
                    await session.execute(select(Variance).where(Variance.id == uuid.UUID(variance_id)))
                ).scalar_one_or_none()
                if var is not None:
                    var.status = "flagged"
                    await session.commit()
        except Exception:
            logger.exception("Could not mark variance flagged after failure")
        return {"status": "error", "variance_id": variance_id}


async def _generate(variance_id: str, tenant_id: str) -> dict[str, str]:
    """Async implementation: load data, call Anthropic, save result."""
    from sqlalchemy import select
    from core.db.session import get_async_session_context
    from models.account import Account
    from models.narrative import Narrative
    from models.trial_balance import TrialBalance
    from models.variance import Variance

    var_uuid = uuid.UUID(variance_id)
    tid      = uuid.UUID(tenant_id)
    current_tenant_id.set(tid)

    async with get_async_session_context() as session:
        # Load Variance + Account
        stmt = (
            select(Variance, Account)
            .join(Account, Variance.account_id == Account.id)
            .where(Variance.id == var_uuid)
        )
        row = (await session.execute(stmt)).one_or_none()
        if row is None:
            return {"status": "not_found", "variance_id": variance_id}

        var, acct = row

        # Cache key: hash of inputs + model
        cache_input = "|".join([
            acct.account_number,
            str(acct.current_balance),
            str(acct.prior_balance),
            settings.anthropic_model,
        ])
        cache_key = hashlib.sha256(cache_input.encode()).hexdigest()

        # Check existing narrative
        existing_result = await session.execute(
            select(Narrative).where(Narrative.cache_key == cache_key)
        )
        existing = existing_result.scalar_one_or_none()
        if existing:
            var.status = "generated"
            await session.commit()
            return {"status": "cached", "variance_id": variance_id}

        # Build prompt
        pct_str = (
            f"{float(var.pct_variance):.1f}%"
            if var.pct_variance
            else "N/M (prior balance is zero)"
        )

        anomaly_desc = ""
        if var.anomaly_flags:
            flag_labels = {
                # "new_account" doesn't mean a freshly-created QBO account; it
                # means the account had a zero balance in the prior period and
                # has activity now. Common when an account was opened mid-period
                # or simply wasn't used in the comparison period.
                "new_account":        "this account had no balance in the prior period and now does",
                "sign_flip":          "the balance has flipped sign from prior period",
                "large_pct_change":   "there is an unusually large percentage change",
                "dormant_reactivated":"this account was previously dormant",
            }
            anomaly_desc = " Note: " + "; ".join(
                flag_labels.get(f, f) for f in var.anomaly_flags
            ) + "."

        prompt = (
            f"You are a senior CPA writing month-end flux commentary for a client. "
            f"Write 2 to 3 sentences explaining the variance for:\n\n"
            f"Account: {acct.account_number} - {acct.account_name}\n"
            f"Category: {acct.fs_category or 'Unknown'} / {acct.fs_line or 'Unknown'}\n"
            f"Current period: ${float(acct.current_balance):,.2f}\n"
            f"Prior period:   ${float(acct.prior_balance):,.2f}\n"
            f"Dollar change:  ${float(var.dollar_variance):,.2f}\n"
            f"Percent change: {pct_str}{anomaly_desc}\n\n"
            f"Formatting rules - these are strict:\n"
            f"- Plain prose only. No headers, no bullet lists, no tables.\n"
            f"- Never use markdown. No **, no __, no ##, no ---, no backticks.\n"
            f"- If you must separate clauses, use a normal hyphen-minus (-) or a period.\n"
            f"- Do not restate the numbers verbatim - interpret them.\n"
            f"- Professional tone, suitable for a controller's workpaper."
        )

        # Call Anthropic (sync client — acceptable inside asyncio.run in Celery)
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        response = client.messages.create(
            model=settings.anthropic_model,
            max_tokens=250,
            messages=[{"role": "user", "content": prompt}],
        )

        content       = _strip_markdown(response.content[0].text)
        input_tokens  = response.usage.input_tokens
        output_tokens = response.usage.output_tokens

        # Confidence heuristic: lower if anomalies present or new account
        confidence = Decimal("0.85")
        if var.anomaly_flags:
            confidence = Decimal("0.70")
        if "new_account" in (var.anomaly_flags or []):
            confidence = Decimal("0.60")

        # Persist narrative
        narrative = Narrative(
            id=uuid.uuid4(),
            tenant_id=tid,
            variance_id=var_uuid,
            content=content,
            cache_key=cache_key,
            confidence_score=confidence,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
        session.add(narrative)
        var.status = "generated"
        await session.commit()

        # Check if all material variances for this TB are done → mark ready_for_review
        await _maybe_mark_tb_ready(session, var, acct)

    return {"status": "generated", "variance_id": variance_id}


async def _maybe_mark_tb_ready(session: object, var: object, acct: object) -> None:
    """Mark the TB as ready_for_review when all material variances are generated."""
    from sqlalchemy import select, func
    from models.account import Account
    from models.trial_balance import TrialBalance
    from models.variance import Variance

    try:
        # Count pending material variances for this TB
        pending_count = (await session.execute(
            select(func.count(Variance.id))
            .join(Account, Variance.account_id == Account.id)
            .where(
                Account.trial_balance_id == acct.trial_balance_id,
                Variance.is_material == True,
                Variance.status == "pending",
            )
        )).scalar_one()

        if pending_count == 0:
            tb_result = await session.execute(
                select(TrialBalance).where(TrialBalance.id == acct.trial_balance_id)
            )
            tb = tb_result.scalar_one_or_none()
            if tb and tb.status in ("generating", "parsed"):
                tb.status = "ready_for_review"
                await session.commit()
    except Exception:
        pass
