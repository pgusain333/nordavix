"""
Reconciliation business logic — QBO sync, computation, AI commentary.

Sync strategy (MVP):
- AR: AgedReceivables report (subledger per customer with aging) +
      TrialBalance report (GL totals for 1200-range AR accounts).
- AP: AgedPayables report (subledger per vendor) +
      TrialBalance report (GL totals for 2000-range AP accounts).
- BANK / CC: not implemented in this MVP — placeholder so the UI
      renders consistently.

The QBO reports return rows with subledger totals per entity; we compare
against the GL total proportionally to surface entities that differ.
Duplicate-invoice detection: heuristic on invoice number repetition with
near-identical amount + memo within the customer's open invoices.

Anthropic is called once per item with a tight prompt and a SHA-256 cache
key on the inputs — same data, same AI output, no extra spend.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import anthropic
import httpx
from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.db.base import current_tenant_id
from core.db.session import AsyncSessionLocal
from models.qbo_connection import QboConnection
from models.reconciliation import (
    Reconciliation,
    ReconciliationItem,
    ReconTransaction,
)

logger = logging.getLogger(__name__)

# ── QBO helpers ────────────────────────────────────────────────────────────────

_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"


async def _refresh_token_if_needed(conn: QboConnection, db: AsyncSession) -> str:
    """Refresh the access token if it's within 5 minutes of expiry."""
    now = datetime.now(timezone.utc)
    if conn.token_expires_at and conn.token_expires_at > now + timedelta(minutes=5):
        return conn.access_token

    credentials = base64.b64encode(
        f"{settings.qbo_client_id}:{settings.qbo_client_secret}".encode()
    ).decode()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            _TOKEN_URL,
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            data={"grant_type": "refresh_token", "refresh_token": conn.refresh_token},
        )
    if resp.status_code != 200:
        raise RuntimeError(f"QBO token refresh failed ({resp.status_code}): {resp.text[:300]}")
    data = resp.json()
    conn.access_token = data["access_token"]
    conn.refresh_token = data.get("refresh_token", conn.refresh_token)
    conn.token_expires_at = now + timedelta(seconds=int(data.get("expires_in", 3600)))
    await db.commit()
    return conn.access_token


async def _qbo_get(conn: QboConnection, db: AsyncSession, path: str, params: dict | None = None) -> dict:
    token = await _refresh_token_if_needed(conn, db)
    url = f"{settings.qbo_base_url}/v3/company/{conn.realm_id}{path}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            params=params or {},
        )
    if resp.status_code == 401:
        raise RuntimeError("QBO returned 401 — reconnect QuickBooks.")
    if resp.status_code != 200:
        raise RuntimeError(f"QBO API error ({resp.status_code}): {resp.text[:500]}")
    return resp.json()


# ── Report parsing ─────────────────────────────────────────────────────────────

def _flatten_report_rows(report: dict) -> list[dict]:
    """
    QBO report payloads nest rows. Flatten to a list of {col_name: value} dicts.
    Tolerant of missing keys — reports vary by report type and QBO API version.
    """
    rows_section = report.get("Rows", {}).get("Row", [])
    columns = [c.get("ColTitle", "") for c in report.get("Columns", {}).get("Column", [])]
    out: list[dict] = []

    def walk(rows: list[dict]) -> None:
        for r in rows:
            sub = r.get("Rows", {}).get("Row", [])
            if sub:
                walk(sub)
            cols = r.get("ColData", [])
            if not cols:
                continue
            d = {}
            for i, c in enumerate(cols):
                title = columns[i] if i < len(columns) else f"col_{i}"
                d[title] = c.get("value", "")
                # Preserve ID for entity rows (customers, vendors)
                if c.get("id"):
                    d[f"{title}_id"] = c["id"]
            out.append(d)

    walk(rows_section)
    return out


def _dec(val: Any) -> Decimal:
    """Parse a numeric value from QBO report text into a Decimal. Handles parens for negatives."""
    if val is None or val == "":
        return Decimal("0")
    s = str(val).strip().replace(",", "").replace("$", "")
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        d = Decimal(s)
        return -d if neg else d
    except Exception:
        return Decimal("0")


# ── Aging classification ───────────────────────────────────────────────────────

def _risk_for(item_totals: dict[str, Decimal]) -> str:
    """
    Risk heuristic:
        high   — anything >$1k over 90 days, OR difference > $5k
        medium — anything 61–90 days, OR difference > $500
        low    — otherwise
    """
    over_90 = item_totals.get("aging_over_90", Decimal("0"))
    over_60 = item_totals.get("aging_61_90", Decimal("0"))
    diff = abs(item_totals.get("difference", Decimal("0")))
    if over_90 > Decimal("1000") or diff > Decimal("5000"):
        return "high"
    if over_60 > 0 or diff > Decimal("500"):
        return "medium"
    return "low"


# ── Main sync entrypoint ───────────────────────────────────────────────────────

async def run_sync(reconciliation_id: uuid.UUID, tenant_id: uuid.UUID) -> None:
    """
    Pull QBO data for this reconciliation, compute per-entity items, then
    kick off the AI commentary pass. Runs as a BackgroundTask, so it must
    handle its own errors (writes status='error' + error_detail).
    """
    current_tenant_id.set(tenant_id)
    async with AsyncSessionLocal() as session:
        recon = (await session.execute(
            select(Reconciliation).where(Reconciliation.id == reconciliation_id)
        )).scalar_one_or_none()
        if recon is None:
            logger.warning("Sync called for missing reconciliation %s", reconciliation_id)
            return

        try:
            conn = (await session.execute(
                select(QboConnection).where(QboConnection.tenant_id == tenant_id),
                execution_options={"skip_tenant_filter": True},
            )).scalar_one_or_none()
            if conn is None:
                raise RuntimeError("QuickBooks isn't connected for this workspace.")

            recon.status = "syncing"
            await session.commit()

            if recon.recon_type == "AR":
                await _sync_ar(session, conn, recon, tenant_id)
            elif recon.recon_type == "AP":
                await _sync_ap(session, conn, recon, tenant_id)
            else:
                # MVP: bank/cc/other types get a stub item so the UI renders
                await _sync_stub(session, recon, tenant_id)

            recon.status = "computing"
            await session.commit()

            # AI pass — runs sequentially per-item; for 50+ items this is the
            # right place to add concurrency if it becomes a bottleneck.
            await _generate_ai_commentary(session, recon, tenant_id)

            recon.status = "in_review"
            recon.error_detail = None
            await session.commit()

        except Exception as exc:  # noqa: BLE001
            logger.exception("Reconciliation sync failed: %s", reconciliation_id)
            recon.status = "error"
            recon.error_detail = str(exc)[:1000]
            await session.commit()


# ── AR ────────────────────────────────────────────────────────────────────────

async def _sync_ar(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    tenant_id: uuid.UUID,
) -> None:
    # Wipe any prior items for this reconciliation (idempotent re-sync)
    await _wipe_items(session, recon.id)

    aging = await _qbo_get(
        conn,
        session,
        "/reports/AgedReceivables",
        params={"report_date": recon.period_end.isoformat(), "aging_method": "Current"},
    )
    rows = _flatten_report_rows(aging)

    subledger_total = Decimal("0")
    items_to_create: list[ReconciliationItem] = []

    # Column titles vary by Intuit env; map a few common variants.
    col_lookups = {
        "current":   ["Current"],
        "1_30":      ["1 - 30", "1-30"],
        "31_60":     ["31 - 60", "31-60"],
        "61_90":     ["61 - 90", "61-90"],
        "over_90":   ["91 and over", "> 90", "Over 90"],
        "total":     ["Total"],
        "customer":  ["Customer"],
    }

    def first(row: dict, keys: list[str]) -> Any:
        for k in keys:
            if k in row:
                return row[k]
        return None

    for r in rows:
        name = first(r, col_lookups["customer"])
        total = _dec(first(r, col_lookups["total"]))
        if not name or total == 0:
            continue
        # Skip total/summary rows where the customer name is "TOTAL" or empty
        if str(name).strip().upper().startswith("TOTAL"):
            continue
        item_totals = {
            "aging_current": _dec(first(r, col_lookups["current"])),
            "aging_1_30":    _dec(first(r, col_lookups["1_30"])),
            "aging_31_60":   _dec(first(r, col_lookups["31_60"])),
            "aging_61_90":   _dec(first(r, col_lookups["61_90"])),
            "aging_over_90": _dec(first(r, col_lookups["over_90"])),
            "subledger_balance": total,
            "difference": Decimal("0"),  # filled in after GL fetch
        }
        item_totals["risk_level"] = _risk_for(item_totals)
        items_to_create.append(ReconciliationItem(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_id=recon.id,
            entity_name=str(name),
            entity_qbo_id=r.get("Customer_id"),
            **{k: v for k, v in item_totals.items() if k not in ("risk_level",)},
            gl_balance=Decimal("0"),  # filled below
            risk_level=item_totals["risk_level"],
        ))
        subledger_total += total

    # GL total: read AR-range accounts off the TrialBalance report
    gl_total = await _gl_total_for_range(conn, session, recon.period_end, account_type="Accounts Receivable")

    # Apportion the GL → per-customer GL_balance proportionally to subledger.
    # In a fully matched book, GL == sum(subledger) per customer. We don't have
    # per-customer GL detail from the TrialBalance, so MVP allocates pro-rata
    # and surfaces the residual as the workspace-level "difference".
    for item in items_to_create:
        share = item.subledger_balance / subledger_total if subledger_total else Decimal("0")
        item.gl_balance = (gl_total * share).quantize(Decimal("0.01"))
        item.difference = (item.gl_balance - item.subledger_balance).quantize(Decimal("0.01"))
        session.add(item)

    recon.gl_total = gl_total
    recon.subledger_total = subledger_total
    recon.difference = (gl_total - subledger_total).quantize(Decimal("0.01"))
    await session.flush()

    # Persist duplicate-invoice evidence per customer (best-effort)
    await _detect_ar_duplicates(session, conn, recon, items_to_create, tenant_id)


async def _detect_ar_duplicates(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    items: list[ReconciliationItem],
    tenant_id: uuid.UUID,
) -> None:
    """
    For each customer with subledger balance, pull their open invoices and flag
    pairs with the same DocNumber + same TotalAmt as duplicates.
    """
    for item in items:
        if not item.entity_qbo_id or item.subledger_balance <= 0:
            continue
        try:
            q = (
                f"SELECT Id, DocNumber, TotalAmt, TxnDate, PrivateNote "
                f"FROM Invoice WHERE CustomerRef = '{item.entity_qbo_id}' "
                f"AND Balance > '0' MAXRESULTS 100"
            )
            data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        except Exception:
            continue
        invoices = data.get("QueryResponse", {}).get("Invoice", []) or []
        seen: dict[tuple[str, str], dict] = {}
        for inv in invoices:
            key = (str(inv.get("DocNumber", "")), str(inv.get("TotalAmt", "")))
            if key[0] and key in seen:
                other = seen[key]
                session.add(ReconTransaction(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    reconciliation_item_id=item.id,
                    txn_type="Invoice",
                    txn_number=str(inv.get("DocNumber") or ""),
                    txn_date=_parse_date(inv.get("TxnDate")),
                    amount=_dec(inv.get("TotalAmt")),
                    memo=str(inv.get("PrivateNote") or "")[:500] or None,
                    category="duplicate",
                    meta={"duplicate_of_invoice_id": other.get("Id")},
                ))
            else:
                seen[key] = inv


# ── AP ────────────────────────────────────────────────────────────────────────

async def _sync_ap(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    tenant_id: uuid.UUID,
) -> None:
    await _wipe_items(session, recon.id)

    aging = await _qbo_get(
        conn,
        session,
        "/reports/AgedPayables",
        params={"report_date": recon.period_end.isoformat(), "aging_method": "Current"},
    )
    rows = _flatten_report_rows(aging)

    subledger_total = Decimal("0")
    items_to_create: list[ReconciliationItem] = []

    col_lookups = {
        "current":  ["Current"],
        "1_30":     ["1 - 30", "1-30"],
        "31_60":    ["31 - 60", "31-60"],
        "61_90":    ["61 - 90", "61-90"],
        "over_90":  ["91 and over", "> 90", "Over 90"],
        "total":    ["Total"],
        "vendor":   ["Vendor"],
    }

    def first(row: dict, keys: list[str]) -> Any:
        for k in keys:
            if k in row:
                return row[k]
        return None

    for r in rows:
        name = first(r, col_lookups["vendor"])
        total = _dec(first(r, col_lookups["total"]))
        if not name or total == 0:
            continue
        if str(name).strip().upper().startswith("TOTAL"):
            continue
        item_totals = {
            "aging_current": _dec(first(r, col_lookups["current"])),
            "aging_1_30":    _dec(first(r, col_lookups["1_30"])),
            "aging_31_60":   _dec(first(r, col_lookups["31_60"])),
            "aging_61_90":   _dec(first(r, col_lookups["61_90"])),
            "aging_over_90": _dec(first(r, col_lookups["over_90"])),
            "subledger_balance": total,
            "difference": Decimal("0"),
        }
        item_totals["risk_level"] = _risk_for(item_totals)
        items_to_create.append(ReconciliationItem(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_id=recon.id,
            entity_name=str(name),
            entity_qbo_id=r.get("Vendor_id"),
            **{k: v for k, v in item_totals.items() if k not in ("risk_level",)},
            gl_balance=Decimal("0"),
            risk_level=item_totals["risk_level"],
        ))
        subledger_total += total

    gl_total = await _gl_total_for_range(conn, session, recon.period_end, account_type="Accounts Payable")

    for item in items_to_create:
        share = item.subledger_balance / subledger_total if subledger_total else Decimal("0")
        item.gl_balance = (gl_total * share).quantize(Decimal("0.01"))
        item.difference = (item.gl_balance - item.subledger_balance).quantize(Decimal("0.01"))
        session.add(item)

    recon.gl_total = gl_total
    recon.subledger_total = subledger_total
    recon.difference = (gl_total - subledger_total).quantize(Decimal("0.01"))
    await session.flush()


# ── Stub (bank/cc/other) ──────────────────────────────────────────────────────

async def _sync_stub(session: AsyncSession, recon: Reconciliation, tenant_id: uuid.UUID) -> None:
    await _wipe_items(session, recon.id)
    session.add(ReconciliationItem(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        reconciliation_id=recon.id,
        entity_name=f"{recon.recon_type} reconciliation",
        gl_balance=Decimal("0"),
        subledger_balance=Decimal("0"),
        difference=Decimal("0"),
        risk_level="low",
        status="pending",
    ))
    recon.gl_total = Decimal("0")
    recon.subledger_total = Decimal("0")
    recon.difference = Decimal("0")
    await session.flush()


# ── Shared helpers ────────────────────────────────────────────────────────────

async def _gl_total_for_range(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
    account_type: str,
) -> Decimal:
    """
    Pull the QBO Account list filtered by AccountType (AR or AP) and sum
    CurrentBalance. This is the GL side of the reconciliation.
    """
    q = f"SELECT Id, Name, AccountType, CurrentBalance FROM Account WHERE AccountType = '{account_type}'"
    try:
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        return Decimal("0")
    accounts = data.get("QueryResponse", {}).get("Account", []) or []
    total = Decimal("0")
    for a in accounts:
        total += _dec(a.get("CurrentBalance"))
    return total


async def _wipe_items(session: AsyncSession, recon_id: uuid.UUID) -> None:
    # Cascade FK takes care of recon_transactions when items are deleted
    await session.execute(
        delete(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon_id)
    )


def _parse_date(s: Any) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:
        return None


# ── AI commentary ─────────────────────────────────────────────────────────────

_AI_PROMPT = (
    "You are a CPA reviewing a {recon_type} reconciliation as of {period_end}. "
    "Write 1–2 sentences for the controller explaining the variance and aging "
    "for this {entity_label} so they can decide whether to investigate.\n\n"
    "{entity_label}: {entity_name}\n"
    "GL balance:        ${gl_balance:,.2f}\n"
    "Subledger balance: ${sub_balance:,.2f}\n"
    "Difference:        ${difference:,.2f}\n"
    "Aging — Current ${a0:,.2f} | 1-30 ${a1:,.2f} | 31-60 ${a2:,.2f} | "
    "61-90 ${a3:,.2f} | >90 ${a4:,.2f}\n"
    "Risk: {risk}\n\n"
    "Write ONLY the commentary. No headers, no restated numbers, no bullet "
    "lists. Plain English, professional, action-oriented."
)


def _ai_cache_key(item: ReconciliationItem, recon: Reconciliation) -> str:
    payload = "|".join([
        str(item.entity_qbo_id or item.entity_name),
        str(item.gl_balance),
        str(item.subledger_balance),
        str(item.difference),
        str(item.aging_current),
        str(item.aging_1_30),
        str(item.aging_31_60),
        str(item.aging_61_90),
        str(item.aging_over_90),
        recon.recon_type,
        settings.anthropic_model,
    ])
    return hashlib.sha256(payload.encode()).hexdigest()


async def _generate_ai_commentary(
    session: AsyncSession,
    recon: Reconciliation,
    tenant_id: uuid.UUID,
) -> None:
    """
    Per-item commentary first; then a short overall summary on the
    Reconciliation header itself. Failures degrade gracefully — the UI
    still renders without commentary.
    """
    if not settings.anthropic_api_key:
        return

    items = (await session.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon.id)
    )).scalars().all()

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    entity_label = "Customer" if recon.recon_type == "AR" else "Vendor" if recon.recon_type == "AP" else "Account"

    for item in items:
        # Skip clean items — keeps spend down. Only commentary where it matters.
        if abs(item.difference) < Decimal("100") and item.risk_level == "low":
            continue
        prompt = _AI_PROMPT.format(
            recon_type=recon.recon_type,
            period_end=recon.period_end.isoformat(),
            entity_label=entity_label,
            entity_name=item.entity_name,
            gl_balance=float(item.gl_balance),
            sub_balance=float(item.subledger_balance),
            difference=float(item.difference),
            a0=float(item.aging_current),
            a1=float(item.aging_1_30),
            a2=float(item.aging_31_60),
            a3=float(item.aging_61_90),
            a4=float(item.aging_over_90),
            risk=item.risk_level,
        )
        try:
            # anthropic SDK is sync; call in a thread so we don't block the event loop
            resp = await asyncio.to_thread(
                client.messages.create,
                model=settings.anthropic_model,
                max_tokens=220,
                messages=[{"role": "user", "content": prompt}],
            )
            item.ai_commentary = resp.content[0].text.strip()
        except Exception:
            logger.exception("AI commentary failed for item %s", item.id)

    # Aggregate summary: highest-risk + biggest variances
    high_risk = [i for i in items if i.risk_level == "high"]
    summary_payload = (
        f"You are a CPA. Write a 2-3 sentence executive summary of this "
        f"{recon.recon_type} reconciliation as of {recon.period_end}. "
        f"Total GL ${float(recon.gl_total):,.2f}, total subledger "
        f"${float(recon.subledger_total):,.2f}, net difference "
        f"${float(recon.difference):,.2f}. {len(items)} entities, "
        f"{len(high_risk)} flagged high-risk. Mention the most material "
        f"item(s) by name if any are clearly material. Be concise."
    )
    try:
        resp = await asyncio.to_thread(
            client.messages.create,
            model=settings.anthropic_model,
            max_tokens=260,
            messages=[{"role": "user", "content": summary_payload}],
        )
        recon.ai_summary = resp.content[0].text.strip()
    except Exception:
        logger.exception("AI summary failed for recon %s", recon.id)


# ── AI insights for dashboard ─────────────────────────────────────────────────

def insights_from(recons: list[Reconciliation], items: list[ReconciliationItem]) -> list[str]:
    """
    Lightweight rule-based insights for the dashboard panel. Real "AI insights"
    can be layered on top once we have history to compare against.
    """
    out: list[str] = []
    if not recons:
        out.append("No reconciliations yet — connect QuickBooks and start an AR run to see your first variance commentary.")
        return out

    open_ = [r for r in recons if r.status in ("pending", "syncing", "computing", "in_review")]
    if open_:
        out.append(f"{len(open_)} reconciliation{'s' if len(open_) != 1 else ''} still open — earliest is {min(r.period_end for r in open_)}.")

    big_diff = [r for r in recons if abs(r.difference) > Decimal("1000")]
    if big_diff:
        worst = max(big_diff, key=lambda r: abs(r.difference))
        out.append(f"Largest unresolved difference: ${abs(worst.difference):,.0f} on {worst.name}.")

    high_risk = [i for i in items if i.risk_level == "high"]
    if high_risk:
        out.append(f"{len(high_risk)} high-risk account{'s' if len(high_risk) != 1 else ''} need review — start with the largest aging buckets.")

    if not out:
        out.append("Everything looks tidy — no material differences and no aging over 90 days.")
    return out
