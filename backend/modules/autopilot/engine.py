"""
Close Autopilot engine — the close that starts itself.

For one (workspace, period), chains the engines that already exist:

  1. SYNC      — fresh balances/aging from QuickBooks (recons sync_overview)
  2. PREPARE   — the AI agentic preparer on every open account
  3. FLUX      — create the month's flux analysis from QBO (skip if it
                 exists) + queue AI commentary on material variances,
                 bounded so a big chart of accounts can't run away
  4. PBC       — EXPLICIT OPT-IN ONLY: magic-link evidence requests to the
                 client for bank/card accounts with no statement attached
                 and no open request
  5. DIGEST    — in-app notification + branded email to every member:
                 what's done, what's flagged, what's waiting

Design rules:
  * Tenant scoping: callers run OUTSIDE a request (cron / background), so
    we set the `current_tenant_id` ContextVar for the duration — every
    downstream ORM query then behaves exactly as it does in-request.
  * Each step is fenced: a failure records an error string and the run
    continues (status "partial"), never half-crashes a tenant loop.
  * AI spend respects the same per-tenant cap as interactive use
    (enforce_ai_limits) — when the cap is hit, AI steps degrade to
    non-AI behavior instead of erroring.
  * Idempotent per (tenant, period): a completed run short-circuits a
    scheduled re-run; manual "Run now" is allowed to repeat.
  * Demo workspaces never run.
"""
import logging
import uuid
from calendar import monthrange
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.db.base import current_tenant_id
from models.autopilot import AutopilotConfig, AutopilotRun
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from models.user import User

logger = logging.getLogger(__name__)

_FLUX_AI_MAX_VARIANCES = 8   # per run — bounds AI spend on huge charts
_PBC_BANK_TYPES = {"Bank", "Credit Card"}


def focus_period_for(tenant: Tenant, closed: set[date], today: date) -> date | None:
    """Oldest non-closed FULLY-ELAPSED month end (the month the close is
    actually about). Returns None when there's nothing to run — books not
    set up, or every elapsed month is already closed."""
    if not tenant.books_start_date:
        return None
    cur = date(tenant.books_start_date.year, tenant.books_start_date.month, 1)
    first_of_this_month = today.replace(day=1)
    while cur < first_of_this_month:
        pe = date(cur.year, cur.month, monthrange(cur.year, cur.month)[1])
        if pe not in closed:
            return pe
        cur = date(cur.year + 1, 1, 1) if cur.month == 12 else date(cur.year, cur.month + 1, 1)
    return None


async def _step_sync(db: AsyncSession, tenant_id: uuid.UUID, pe: date, results: dict) -> dict | None:
    conn = (await db.execute(
        select(QboConnection).where(QboConnection.tenant_id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    if conn is None:
        results["errors"].append("QuickBooks isn't connected — sync skipped.")
        return None
    from modules.recons.overview import sync_overview
    overview = await sync_overview(conn, db, pe)
    results["synced"] = True
    results["accounts_total"] = len(overview.get("accounts", []))
    return overview


async def _step_prepare(db: AsyncSession, tenant_id: uuid.UUID, actor: User, pe: date, results: dict) -> None:
    from core.ai.guard import enforce_ai_limits
    try:
        await enforce_ai_limits(tenant_id)
    except Exception:
        results["errors"].append("AI usage cap reached — agentic preparer skipped.")
        return
    from modules.recons.agentic import run_agentic_prep
    res = await run_agentic_prep(db, tenant_id, actor, pe)
    # AgenticResult is a dataclass; read the common counters defensively so a
    # future shape change degrades the digest, not the run.
    results["prepared"]    = getattr(res, "prepared", None) or getattr(res, "prepared_count", 0) or 0
    results["ai_analyzed"] = getattr(res, "analyzed", None) or getattr(res, "analyzed_count", 0) or 0
    results["skipped"]     = getattr(res, "skipped", None) or getattr(res, "skipped_count", 0) or 0


async def _step_flux(db: AsyncSession, tenant_id: uuid.UUID, actor: User, pe: date, results: dict) -> None:
    """Create the month's flux analysis from QBO (current vs same month
    prior year — the app's convention) and queue AI commentary for the
    first N material variances. Skips creation if an analysis for this
    period already exists."""
    import httpx

    from core.config import settings
    from core.qbo_tb import fetch_trial_balance
    from models.account import Account
    from models.trial_balance import TrialBalance
    from models.variance import Variance
    from modules.flux.service import create_accounts_and_variances, parse_qbo_trial_balance_report
    from modules.qbo.router import _get_valid_token

    existing = (await db.execute(
        select(TrialBalance).where(TrialBalance.period_current == pe)
        .order_by(TrialBalance.created_at.desc()).limit(1)
    )).scalar_one_or_none()

    tb = existing
    if tb is None:
        conn = (await db.execute(
            select(QboConnection).where(QboConnection.tenant_id == tenant_id),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        if conn is None:
            results["errors"].append("QuickBooks isn't connected — flux skipped.")
            return
        prior = date(pe.year - 1, pe.month, monthrange(pe.year - 1, pe.month)[1])
        tb = TrialBalance(
            id=uuid.uuid4(), tenant_id=tenant_id,
            name=f"{pe.strftime('%b %Y')} (Autopilot)",
            period_current=pe, period_prior=prior,
            created_by=actor.id, status="processing",
        )
        db.add(tb)
        await db.commit()
        await db.refresh(tb)

        report_current = await fetch_trial_balance(conn, pe)
        report_prior   = await fetch_trial_balance(conn, prior)

        # Account-number lookup — mirrors the from-QBO endpoint so flux rows
        # carry proper AcctNums (best-effort; parser falls back without it).
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
            qbo_acct_lookup = {}

        account_dicts = parse_qbo_trial_balance_report(
            report_current, report_prior, {}, qbo_acct_lookup=qbo_acct_lookup,
        )
        if not account_dicts:
            tb.status = "error"
            tb.error_detail = "QBO TrialBalance returned no rows (Autopilot)."
            await db.commit()
            results["errors"].append("Flux: QBO returned no trial-balance rows.")
            return
        _, vars_created, material = await create_accounts_and_variances(db, tb, tenant_id, account_dicts)
        tb.status = "ready_for_review"
        await db.commit()
        results["flux_created"]   = True
        results["flux_variances"] = vars_created
        results["flux_material"]  = material
    else:
        # Flux already exists for this period (human-made or a prior run) — still
        # surface its material-variance count so the digest + timeline show it
        # instead of silently dropping the flux line on re-runs.
        mat = (await db.execute(
            select(func.count()).select_from(Variance)
            .join(Account, Variance.account_id == Account.id)
            .where(Account.trial_balance_id == tb.id, Variance.is_material == True)  # noqa: E712
        )).scalar() or 0
        results["flux_created"]  = True
        results["flux_material"] = int(mat)

    # AI commentary on material variances — bounded, cap-aware, sequential
    # (generate_narrative_async opens its own session per variance).
    from core.ai.guard import enforce_ai_limits
    try:
        await enforce_ai_limits(tenant_id)
    except Exception:
        results["errors"].append("AI usage cap reached — flux commentary skipped.")
        return
    pending = list((await db.execute(
        select(Variance).join(Account, Variance.account_id == Account.id)
        .where(
            Account.trial_balance_id == tb.id,
            Variance.is_material == True,  # noqa: E712
            Variance.status.in_(("pending", "flagged")),
        )
        .limit(_FLUX_AI_MAX_VARIANCES)
    )).scalars().all())
    if pending:
        from modules.flux.tasks import generate_narrative_async
        queued = 0
        for var in pending:
            try:
                await generate_narrative_async(str(var.id), str(tenant_id))
                queued += 1
            except Exception:
                logger.exception("Autopilot flux narrative failed for %s", var.id)
        results["flux_ai_queued"] = queued


async def _step_pbc(db: AsyncSession, tenant_id: uuid.UUID, actor: User,
                    config: AutopilotConfig, pe: date, results: dict) -> None:
    """Magic-link evidence requests for bank/card accounts with no
    statement and no open request. ONLY runs when the user explicitly
    opted in at setup and gave a recipient address."""
    import hashlib
    import secrets
    from datetime import timedelta

    from models.evidence_request import EvidenceRequest
    from models.gl_balance_snapshot import GlBalanceSnapshot
    from models.subledger_evidence import SubledgerEvidence
    from modules.pbc.router import _send_request_email

    snaps = list((await db.execute(
        select(GlBalanceSnapshot).where(
            GlBalanceSnapshot.period_end == pe,
            GlBalanceSnapshot.account_type.in_(_PBC_BANK_TYPES),
        )
    )).scalars().all())
    if not snaps:
        return
    ev_ids = {
        r[0] for r in (await db.execute(
            select(SubledgerEvidence.qbo_account_id)
            .where(SubledgerEvidence.period_end == pe)
        )).all()
    }
    open_req_ids = {
        r[0] for r in (await db.execute(
            select(EvidenceRequest.qbo_account_id).where(
                EvidenceRequest.period_end == pe,
                EvidenceRequest.status.in_(("pending", "fulfilled")),
            )
        )).all()
    }
    sent = 0
    for snap in snaps:
        if snap.qbo_account_id in ev_ids or snap.qbo_account_id in open_req_ids:
            continue
        label = f"{snap.account_number or ''} {snap.account_name}".strip()
        token = secrets.token_urlsafe(32)
        req = EvidenceRequest(
            id=uuid.uuid4(), tenant_id=tenant_id,
            qbo_account_id=snap.qbo_account_id, period_end=pe,
            title=f"{label} — {pe.strftime('%B %Y')} statement",
            note="Requested automatically by Close Autopilot — this account has no statement on file for the month.",
            account_label=label,
            recipient_email=config.pbc_recipient_email or "",
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            expires_at=datetime.now(UTC) + timedelta(days=14),
            status="pending", files=[], send_count=1,
            last_sent_at=datetime.now(UTC), created_by=actor.id,
        )
        db.add(req)
        await write_audit_event(
            db, tenant_id=tenant_id, user_id=actor.id,
            action="pbc.request_sent", entity_type="evidence_request", entity_id=req.id,
            metadata={"summary": f"Autopilot requested '{req.title}' from {req.recipient_email}"},
        )
        await db.commit()
        try:
            await _send_request_email(db, req, token)
            sent += 1
        except Exception:
            logger.exception("Autopilot PBC email failed for %s", req.id)
            results["errors"].append(f"Evidence email failed for {label}.")
    results["pbc_sent"] = sent


async def _step_review(db: AsyncSession, tenant_id: uuid.UUID, actor: User, pe: date, results: dict) -> None:
    """AI reviewing-partner pass over the freshly prepared close. Snapshot-based
    deterministic checks + a bounded, cap-aware AI narrative."""
    from modules.review.engine import run_close_review
    review = await run_close_review(db, tenant_id, pe, generated_by=actor.id, use_ai=True)
    results["review_exceptions"] = review.high_count + review.review_count
    results["review_high"] = review.high_count


def _digest_lines(results: dict, pe: date) -> tuple[str, str]:
    """(title, body) for the in-app notification + email."""
    label = pe.strftime("%B %Y")
    bits: list[str] = []
    if results.get("synced"):
        bits.append(f"synced {results.get('accounts_total', 0)} accounts from QuickBooks")
    if results.get("prepared"):
        bits.append(f"prepared {results['prepared']} reconciliations")
    if results.get("ai_analyzed"):
        bits.append(f"AI-analyzed {results['ai_analyzed']}")
    if results.get("flux_created"):
        bits.append(f"ran flux ({results.get('flux_material', 0)} material variances)")
    if results.get("flux_ai_queued"):
        bits.append(f"AI commentary on {results['flux_ai_queued']} variances")
    if results.get("pbc_sent"):
        bits.append(f"requested {results['pbc_sent']} statements from your client")
    if results.get("review_exceptions"):
        hi = results.get("review_high") or 0
        suffix = f" ({hi} high-priority)" if hi else ""
        bits.append(f"flagged {results['review_exceptions']} review exception{'s' if results['review_exceptions'] != 1 else ''}{suffix}")
    summary = "; ".join(bits) if bits else "nothing needed doing"
    errs = results.get("errors") or []
    title = f"Autopilot ran your {label} close"
    body = f"Autopilot {summary}."
    if errs:
        body += f" {len(errs)} step{'s' if len(errs) != 1 else ''} need attention."
    return title, body


async def run_autopilot_for_tenant(
    db: AsyncSession,
    tenant: Tenant,
    config: AutopilotConfig,
    period_end: date,
    *,
    triggered_by: str,
    started_by: uuid.UUID | None,
) -> AutopilotRun:
    """Execute one Autopilot run. Sets the tenant ContextVar for the
    duration so every downstream query is tenant-scoped exactly as if it
    ran inside a request."""
    ctx_token = current_tenant_id.set(tenant.id)
    try:
        run = AutopilotRun(
            id=uuid.uuid4(), tenant_id=tenant.id, period_end=period_end,
            status="running", triggered_by=triggered_by, started_by=started_by,
            results={},
        )
        db.add(run)
        await write_audit_event(
            db, tenant_id=tenant.id, user_id=started_by,
            action="autopilot.run_started", entity_type="period", entity_id=None,
            metadata={"summary": f"Close Autopilot started for {period_end.strftime('%b %Y')} ({triggered_by})"},
        )
        await db.commit()
        await db.refresh(run)

        results: dict = {"errors": []}

        # Actor for stamps/attribution: the admin who configured Autopilot.
        actor = (await db.execute(
            select(User).where(User.id == config.updated_by),
            execution_options={"skip_tenant_filter": True},
        )).scalar_one_or_none()
        if actor is None:
            actor = (await db.execute(
                select(User).where(User.tenant_id == tenant.id, User.role == "admin").limit(1),
                execution_options={"skip_tenant_filter": True},
            )).scalar_one_or_none()
        if actor is None:
            results["errors"].append("No workspace user found to attribute actions to.")
            run.results, run.status = results, "failed"
            run.finished_at = datetime.now(UTC)
            await db.commit()
            return run

        # 1 — SYNC
        try:
            overview = await _step_sync(db, tenant.id, period_end, results)
        except Exception as exc:
            logger.exception("Autopilot sync failed for %s", tenant.id)
            results["errors"].append(f"Sync failed: {type(exc).__name__}")
            overview = None

        # 2 — AGENTIC PREPARER (only with fresh data)
        if overview is not None:
            try:
                await _step_prepare(db, tenant.id, actor, period_end, results)
            except Exception as exc:
                logger.exception("Autopilot prepare failed for %s", tenant.id)
                results["errors"].append(f"AI preparer failed: {type(exc).__name__}")

        # 3 — FLUX
        if config.run_flux:
            try:
                await _step_flux(db, tenant.id, actor, period_end, results)
            except Exception as exc:
                logger.exception("Autopilot flux failed for %s", tenant.id)
                results["errors"].append(f"Flux failed: {type(exc).__name__}")

        # 4 — PBC (explicit opt-in only)
        if config.send_pbc_requests and config.pbc_recipient_email:
            try:
                await _step_pbc(db, tenant.id, actor, config, period_end, results)
            except Exception as exc:
                logger.exception("Autopilot PBC failed for %s", tenant.id)
                results["errors"].append(f"Evidence requests failed: {type(exc).__name__}")

        # 4b — CLOSE REVIEW: the AI reviewing-partner pass over everything above.
        try:
            await _step_review(db, tenant.id, actor, period_end, results)
        except Exception as exc:
            logger.exception("Autopilot review failed for %s", tenant.id)
            results["errors"].append(f"Close review failed: {type(exc).__name__}")

        # 5 — DIGEST: branded email to every member with email on.
        title, body = _digest_lines(results, period_end)
        try:
            from core.email.sender import send_email
            members = list((await db.execute(
                select(User).where(User.tenant_id == tenant.id),
                execution_options={"skip_tenant_filter": True},
            )).scalars().all())
            recipients = [m.email for m in members
                          if m.email and getattr(m, "email_notifications_enabled", True)]
            if recipients:
                from core.config import settings
                link = f"{settings.web_url}/app/reconciliations"
                await send_email(
                    to=recipients,
                    subject=f"✦ {title}",
                    html=_digest_email_html(
                        company=tenant.name if tenant.name and not tenant.name.startswith("org_") else "Your company",
                        title=title, body=body, results=results,
                        period_label=period_end.strftime("%B %Y"), link=link,
                    ),
                    text=f"{title}\n\n{body}\n\nOpen Nordavix: {link}",
                )
        except Exception:
            logger.exception("Autopilot digest email failed for %s", tenant.id)
            results["errors"].append("Digest email failed to send.")

        run.results = results
        run.status = "partial" if results["errors"] else "completed"
        run.finished_at = datetime.now(UTC)
        await write_audit_event(
            db, tenant_id=tenant.id, user_id=started_by,
            action="autopilot.run_completed", entity_type="period", entity_id=None,
            metadata={"summary": f"Close Autopilot {run.status} for {period_end.strftime('%b %Y')}: {body}"},
        )
        await db.commit()
        return run
    finally:
        current_tenant_id.reset(ctx_token)


def _digest_email_html(*, company: str, title: str, body: str, results: dict,
                       period_label: str, link: str) -> str:
    rows = []
    def row(label: str, value: str) -> None:
        rows.append(
            f'<tr><td style="padding:6px 0;color:#8A8F98;font-size:12px;">{label}</td>'
            f'<td style="padding:6px 0;color:#14181A;font-size:12px;font-weight:700;text-align:right;">{value}</td></tr>'
        )
    if results.get("accounts_total") is not None:
        row("Accounts synced", str(results.get("accounts_total", 0)))
    if results.get("prepared") is not None:
        row("Reconciliations prepared", str(results.get("prepared", 0)))
    if results.get("ai_analyzed"):
        row("AI-analyzed accounts", str(results["ai_analyzed"]))
    if results.get("flux_material") is not None and results.get("flux_created"):
        row("Material flux variances", str(results["flux_material"]))
    if results.get("flux_ai_queued"):
        row("Variances with AI commentary", str(results["flux_ai_queued"]))
    if results.get("pbc_sent"):
        row("Statements requested from client", str(results["pbc_sent"]))
    if results.get("review_exceptions") is not None:
        row("Close-review exceptions", str(results.get("review_exceptions", 0)))
    errs = results.get("errors") or []
    err_block = ""
    if errs:
        items = "".join(f'<li style="margin:2px 0;">{e}</li>' for e in errs[:6])
        err_block = (
            f'<div style="margin-top:14px;background:#f7eeec;border:1px solid #ecd7d3;'
            f'border-radius:8px;padding:10px 14px;color:#86332e;font-size:12px;">'
            f'<strong>Needs attention</strong><ul style="margin:6px 0 0;padding-left:18px;">{items}</ul></div>'
        )
    return f"""\
<div style="background:#F4F1E9;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #E6E4DF;overflow:hidden;">
    <div style="background:#0C2620;padding:18px 28px;">
      <span style="color:#F4F1E9;font-size:15px;font-weight:700;">nordavix<span style="color:#9CC4AD;">.</span></span>
      <span style="float:right;color:#9CC4AD;font-size:10px;letter-spacing:0.16em;font-weight:700;">AUTOPILOT</span>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 6px;color:#8A8F98;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">{company} · {period_label}</p>
      <h1 style="margin:0 0 10px;color:#14181A;font-size:20px;line-height:1.3;">{title}</h1>
      <p style="margin:0 0 14px;color:#3C4146;font-size:13.5px;line-height:1.6;">{body}</p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6E4DF;">{''.join(rows)}</table>
      {err_block}
      <a href="{link}" style="display:inline-block;background:#2E7A55;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;padding:11px 20px;border-radius:9px;margin-top:18px;">Review your close &rarr;</a>
    </div>
    <div style="padding:13px 28px;border-top:1px solid #E6E4DF;">
      <p style="margin:0;color:#8A8F98;font-size:11px;">Close Autopilot ran because you enabled it in Settings &middot; you can pause it anytime.</p>
    </div>
  </div>
</div>"""
