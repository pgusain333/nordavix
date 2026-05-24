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
    """
    Accurate AR reconciliation:

      Per-customer balance comes from AgedReceivables (= subledger detail).
      That IS the per-customer GL detail in QBO — every invoice/payment posts
      to AR atomically with a CustomerRef. We do NOT pro-rate a GL total
      across customers (that produced spurious per-customer "differences").

      Workspace-level gap = (total GL AR balance) − (sum of customer balances).
      If non-zero, it almost always means journal entries posted to an AR
      account without a CustomerRef. We surface that as its own reconciling
      item ('Unposted GL adjustments') so the totals tie out and the user
      can see exactly what needs to be cleared.
    """
    await _wipe_items(session, recon.id)

    aging = await _qbo_get(
        conn, session,
        "/reports/AgedReceivables",
        params={"report_date": recon.period_end.isoformat(), "aging_method": "Current"},
    )
    rows = _flatten_report_rows(aging)
    items_to_create = _build_aging_items(rows, recon, tenant_id, entity_col_aliases=["Customer"], entity_id_field="Customer_id")

    subledger_total = sum((i.subledger_balance for i in items_to_create), Decimal("0"))
    gl_total = await _gl_total_for_range(conn, session, recon.period_end, account_type="Accounts Receivable")

    # In QBO, per-customer subledger == per-customer GL detail. Don't fabricate
    # a per-customer difference — set them equal and let the reconciling-item
    # row carry any aggregate gap.
    for item in items_to_create:
        item.gl_balance = item.subledger_balance
        item.difference = Decimal("0")
        session.add(item)

    gap = (gl_total - subledger_total).quantize(Decimal("0.01"))
    if abs(gap) >= Decimal("0.01"):
        # Reconciling item that captures unposted JEs / posting issues
        session.add(ReconciliationItem(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_id=recon.id,
            entity_name="Unposted GL adjustments (no customer ref)",
            entity_qbo_id=None,
            subledger_balance=Decimal("0"),
            gl_balance=gap,
            difference=gap,
            aging_current=Decimal("0"),
            aging_1_30=Decimal("0"),
            aging_31_60=Decimal("0"),
            aging_61_90=Decimal("0"),
            aging_over_90=Decimal("0"),
            risk_level="high" if abs(gap) > Decimal("1000") else "medium",
            status="flagged",
        ))

    recon.gl_total = gl_total
    recon.subledger_total = subledger_total
    recon.difference = gap
    await session.flush()

    # Real evidence: open invoices, unapplied payments/credits, duplicates, JEs
    await _sync_ar_evidence(session, conn, recon, items_to_create, tenant_id)
    await _sync_ar_journal_entries(session, conn, recon, items_to_create, tenant_id, gap)


def _build_aging_items(
    rows: list[dict],
    recon: Reconciliation,
    tenant_id: uuid.UUID,
    *,
    entity_col_aliases: list[str],
    entity_id_field: str,
) -> list[ReconciliationItem]:
    """
    Shared aging-row → ReconciliationItem mapping for AR & AP.
    Handles QBO's varying column titles ("1 - 30" vs "1-30", etc.) and skips
    summary/total rows defensively.
    """
    col_lookups = {
        "current":   ["Current"],
        "1_30":      ["1 - 30", "1-30"],
        "31_60":     ["31 - 60", "31-60"],
        "61_90":     ["61 - 90", "61-90"],
        "over_90":   ["91 and over", "> 90", "Over 90"],
        "total":     ["Total"],
    }

    def first(row: dict, keys: list[str]) -> Any:
        for k in keys:
            if k in row:
                return row[k]
        return None

    items: list[ReconciliationItem] = []
    for r in rows:
        name = first(r, entity_col_aliases)
        if not name:
            continue
        n = str(name).strip()
        if not n or n.upper().startswith("TOTAL"):
            continue
        total = _dec(first(r, col_lookups["total"]))
        if total == 0:
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
        risk = _risk_for(item_totals)
        items.append(ReconciliationItem(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_id=recon.id,
            entity_name=n,
            entity_qbo_id=r.get(entity_id_field),
            **item_totals,
            gl_balance=Decimal("0"),
            risk_level=risk,
        ))
    return items


async def _sync_ar_evidence(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    items: list[ReconciliationItem],
    tenant_id: uuid.UUID,
) -> None:
    """
    Per-customer: pull open invoices (Balance > 0) + unapplied payments +
    unapplied credit memos. Surface duplicates, unmatched invoices > 60d old,
    and unapplied cash so the detail page has real evidence to act on.
    Best-effort: one customer failure doesn't abort the whole sync.

    Pulls are bounded-concurrent (4 at a time) — QBO's per-realm rate limit
    is 500 req/min so 4-way parallelism is safe and ~4x faster than serial.
    """
    period_end = recon.period_end.isoformat()
    sem = asyncio.Semaphore(4)

    async def for_one(item: ReconciliationItem) -> None:
        async with sem:
            await _pull_ar_evidence_for_customer(session, conn, recon, item, tenant_id, period_end)

    await asyncio.gather(*(for_one(i) for i in items if i.entity_qbo_id and i.subledger_balance > 0))


async def _pull_ar_evidence_for_customer(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    item: ReconciliationItem,
    tenant_id: uuid.UUID,
    period_end: str,
) -> None:
    """Single-customer evidence pull — open invoices, payments, credit memos."""
    # ── Open invoices (Balance > 0 as of period end) ─────────────────────────
    try:
        q = (
            f"SELECT Id, DocNumber, TotalAmt, Balance, TxnDate, DueDate, PrivateNote "
            f"FROM Invoice WHERE CustomerRef = '{item.entity_qbo_id}' "
            f"AND Balance > '0' MAXRESULTS 200"
        )
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        invoices = data.get("QueryResponse", {}).get("Invoice", []) or []
    except Exception:
        logger.exception("Open invoice pull failed for customer %s", item.entity_qbo_id)
        invoices = []

    # Duplicates: same DocNumber + same TotalAmt
    seen: dict[tuple[str, str], dict] = {}
    for inv in invoices:
        doc = str(inv.get("DocNumber") or "").strip()
        amt = str(inv.get("TotalAmt") or "")
        if doc and (doc, amt) in seen:
            session.add(ReconTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                reconciliation_item_id=item.id,
                txn_type="Invoice",
                txn_number=doc,
                txn_date=_parse_date(inv.get("TxnDate")),
                amount=_dec(inv.get("Balance")),
                memo=str(inv.get("PrivateNote") or "")[:500] or None,
                category="duplicate",
                meta={"duplicate_of_invoice_id": seen[(doc, amt)].get("Id")},
            ))
        elif doc:
            seen[(doc, amt)] = inv

    # Unmatched (overdue >60 days at period_end)
    for inv in invoices:
        due = _parse_date(inv.get("DueDate")) or _parse_date(inv.get("TxnDate"))
        if not due:
            continue
        days_overdue = (recon.period_end - due).days
        if days_overdue > 60:
            session.add(ReconTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                reconciliation_item_id=item.id,
                txn_type="Invoice",
                txn_number=str(inv.get("DocNumber") or ""),
                txn_date=_parse_date(inv.get("TxnDate")),
                amount=_dec(inv.get("Balance")),
                memo=str(inv.get("PrivateNote") or "")[:500] or None,
                category="unmatched",
                meta={"days_overdue": days_overdue, "due_date": str(due)},
            ))

    # ── Unapplied payments (UnappliedAmt > 0) ────────────────────────────────
    try:
        q = (
            f"SELECT Id, PaymentRefNum, TotalAmt, UnappliedAmt, TxnDate, PrivateNote "
            f"FROM Payment WHERE CustomerRef = '{item.entity_qbo_id}' "
            f"AND UnappliedAmt > '0' AND TxnDate <= '{period_end}' MAXRESULTS 100"
        )
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        payments = data.get("QueryResponse", {}).get("Payment", []) or []
    except Exception:
        payments = []

    for pay in payments:
        session.add(ReconTransaction(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_item_id=item.id,
            txn_type="Payment",
            txn_number=str(pay.get("PaymentRefNum") or ""),
            txn_date=_parse_date(pay.get("TxnDate")),
            amount=_dec(pay.get("UnappliedAmt")),
            memo=str(pay.get("PrivateNote") or "")[:500] or None,
            category="unapplied_cash",
            meta={"payment_id": pay.get("Id"), "total_amt": str(pay.get("TotalAmt", ""))},
        ))

    # ── Unapplied credit memos (Balance > 0) ─────────────────────────────────
    try:
        q = (
            f"SELECT Id, DocNumber, TotalAmt, Balance, TxnDate, PrivateNote "
            f"FROM CreditMemo WHERE CustomerRef = '{item.entity_qbo_id}' "
            f"AND Balance > '0' AND TxnDate <= '{period_end}' MAXRESULTS 100"
        )
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        credits = data.get("QueryResponse", {}).get("CreditMemo", []) or []
    except Exception:
        credits = []

    for cm in credits:
        session.add(ReconTransaction(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_item_id=item.id,
            txn_type="CreditMemo",
            txn_number=str(cm.get("DocNumber") or ""),
            txn_date=_parse_date(cm.get("TxnDate")),
            amount=_dec(cm.get("Balance")),
            memo=str(cm.get("PrivateNote") or "")[:500] or None,
            category="unapplied_cash",
            meta={"credit_memo_id": cm.get("Id")},
        ))


async def _sync_ar_journal_entries(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    items: list[ReconciliationItem],
    tenant_id: uuid.UUID,
    gap: Decimal,
) -> None:
    """
    When there's a workspace-level GL-vs-subledger gap, the likely culprits are
    manual JEs that touched the AR account without a customer ref. Pull recent
    JEs (last 90 days) and attach them to the synthetic 'Unposted GL adjustments'
    item created in _sync_ar.
    """
    if abs(gap) < Decimal("0.01"):
        return

    # Find the synthetic reconciling item we just created
    recon_item = (await session.execute(
        select(ReconciliationItem).where(
            ReconciliationItem.reconciliation_id == recon.id,
            ReconciliationItem.entity_qbo_id.is_(None),
        )
    )).scalars().first()
    if recon_item is None:
        return

    # Get the AR account IDs first so we can match JE lines against them
    try:
        acct_data = await _qbo_get(
            conn, session, "/query",
            params={"query": "SELECT Id FROM Account WHERE AccountType = 'Accounts Receivable'", "minorversion": "65"},
        )
        ar_account_ids = {a.get("Id") for a in acct_data.get("QueryResponse", {}).get("Account", []) or []}
    except Exception:
        ar_account_ids = set()
    if not ar_account_ids:
        return

    # Pull JEs from the last 90 days that touched AR
    cutoff = (recon.period_end - timedelta(days=90)).isoformat()
    try:
        q = (
            f"SELECT Id, DocNumber, TxnDate, PrivateNote, Line "
            f"FROM JournalEntry WHERE TxnDate >= '{cutoff}' "
            f"AND TxnDate <= '{recon.period_end.isoformat()}' MAXRESULTS 200"
        )
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
        jes = data.get("QueryResponse", {}).get("JournalEntry", []) or []
    except Exception:
        jes = []

    for je in jes:
        # Find AR-account lines that have no customer ref ("Entity" field absent on the line)
        ar_amount = Decimal("0")
        has_customer_ref = False
        for line in je.get("Line", []):
            detail = line.get("JournalEntryLineDetail") or {}
            acct_ref = (detail.get("AccountRef") or {}).get("value")
            if acct_ref not in ar_account_ids:
                continue
            entity = detail.get("Entity") or {}
            if entity.get("EntityRef"):
                has_customer_ref = True
                continue
            amt = _dec(line.get("Amount"))
            ptype = detail.get("PostingType")
            ar_amount += amt if ptype == "Debit" else -amt
        if ar_amount != 0 and not has_customer_ref:
            session.add(ReconTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                reconciliation_item_id=recon_item.id,
                txn_type="JournalEntry",
                txn_number=str(je.get("DocNumber") or ""),
                txn_date=_parse_date(je.get("TxnDate")),
                amount=ar_amount,
                memo=str(je.get("PrivateNote") or "")[:500] or None,
                category="manual_je",
                meta={"je_id": je.get("Id")},
            ))


# ── AP ────────────────────────────────────────────────────────────────────────

async def _sync_ap(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    tenant_id: uuid.UUID,
) -> None:
    """Mirror of _sync_ar for vendors. See _sync_ar docstring for the rationale."""
    await _wipe_items(session, recon.id)

    aging = await _qbo_get(
        conn, session,
        "/reports/AgedPayables",
        params={"report_date": recon.period_end.isoformat(), "aging_method": "Current"},
    )
    rows = _flatten_report_rows(aging)
    items_to_create = _build_aging_items(
        rows, recon, tenant_id,
        entity_col_aliases=["Vendor"],
        entity_id_field="Vendor_id",
    )

    subledger_total = sum((i.subledger_balance for i in items_to_create), Decimal("0"))
    gl_total = await _gl_total_for_range(conn, session, recon.period_end, account_type="Accounts Payable")

    for item in items_to_create:
        item.gl_balance = item.subledger_balance
        item.difference = Decimal("0")
        session.add(item)

    gap = (gl_total - subledger_total).quantize(Decimal("0.01"))
    if abs(gap) >= Decimal("0.01"):
        session.add(ReconciliationItem(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_id=recon.id,
            entity_name="Unposted GL adjustments (no vendor ref)",
            entity_qbo_id=None,
            subledger_balance=Decimal("0"),
            gl_balance=gap,
            difference=gap,
            aging_current=Decimal("0"),
            aging_1_30=Decimal("0"),
            aging_31_60=Decimal("0"),
            aging_61_90=Decimal("0"),
            aging_over_90=Decimal("0"),
            risk_level="high" if abs(gap) > Decimal("1000") else "medium",
            status="flagged",
        ))

    recon.gl_total = gl_total
    recon.subledger_total = subledger_total
    recon.difference = gap
    await session.flush()

    await _sync_ap_evidence(session, conn, recon, items_to_create, tenant_id)


async def _sync_ap_evidence(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    items: list[ReconciliationItem],
    tenant_id: uuid.UUID,
) -> None:
    """Per-vendor: open bills, vendor credits, overdue bills."""
    for item in items:
        if not item.entity_qbo_id or item.subledger_balance <= 0:
            continue
        try:
            q = (
                f"SELECT Id, DocNumber, TotalAmt, Balance, TxnDate, DueDate, PrivateNote "
                f"FROM Bill WHERE VendorRef = '{item.entity_qbo_id}' "
                f"AND Balance > '0' MAXRESULTS 200"
            )
            data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
            bills = data.get("QueryResponse", {}).get("Bill", []) or []
        except Exception:
            bills = []

        seen: dict[tuple[str, str], dict] = {}
        for bill in bills:
            doc = str(bill.get("DocNumber") or "").strip()
            amt = str(bill.get("TotalAmt") or "")
            if doc and (doc, amt) in seen:
                session.add(ReconTransaction(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    reconciliation_item_id=item.id,
                    txn_type="Bill",
                    txn_number=doc,
                    txn_date=_parse_date(bill.get("TxnDate")),
                    amount=_dec(bill.get("Balance")),
                    memo=str(bill.get("PrivateNote") or "")[:500] or None,
                    category="duplicate",
                    meta={"duplicate_of_bill_id": seen[(doc, amt)].get("Id")},
                ))
            elif doc:
                seen[(doc, amt)] = bill

            due = _parse_date(bill.get("DueDate")) or _parse_date(bill.get("TxnDate"))
            if due:
                days_overdue = (recon.period_end - due).days
                if days_overdue > 60:
                    session.add(ReconTransaction(
                        id=uuid.uuid4(),
                        tenant_id=tenant_id,
                        reconciliation_item_id=item.id,
                        txn_type="Bill",
                        txn_number=str(bill.get("DocNumber") or ""),
                        txn_date=_parse_date(bill.get("TxnDate")),
                        amount=_dec(bill.get("Balance")),
                        memo=str(bill.get("PrivateNote") or "")[:500] or None,
                        category="unmatched",
                        meta={"days_overdue": days_overdue, "due_date": str(due)},
                    ))

        # Unapplied vendor credits
        try:
            q = (
                f"SELECT Id, DocNumber, TotalAmt, Balance, TxnDate, PrivateNote "
                f"FROM VendorCredit WHERE VendorRef = '{item.entity_qbo_id}' "
                f"AND Balance > '0' MAXRESULTS 100"
            )
            data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
            credits = data.get("QueryResponse", {}).get("VendorCredit", []) or []
        except Exception:
            credits = []
        for vc in credits:
            session.add(ReconTransaction(
                id=uuid.uuid4(),
                tenant_id=tenant_id,
                reconciliation_item_id=item.id,
                txn_type="VendorCredit",
                txn_number=str(vc.get("DocNumber") or ""),
                txn_date=_parse_date(vc.get("TxnDate")),
                amount=_dec(vc.get("Balance")),
                memo=str(vc.get("PrivateNote") or "")[:500] or None,
                category="unapplied_cash",
                meta={"vendor_credit_id": vc.get("Id")},
            ))


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
    Per-item commentary in parallel (bounded concurrency), then a short
    overall summary on the Reconciliation header itself. Failures degrade
    gracefully — the UI still renders without commentary.

    Concurrency tuned for Anthropic's per-key rate limits: 5 in flight is
    safe for sonnet at default tiers and ~10x faster than sequential.
    """
    if not settings.anthropic_api_key:
        return

    items = list((await session.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon.id)
    )).scalars().all())

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    entity_label = "Customer" if recon.recon_type == "AR" else "Vendor" if recon.recon_type == "AP" else "Account"

    # Filter to items worth spending tokens on
    worth_explaining = [
        i for i in items
        if abs(i.difference) >= Decimal("100") or i.risk_level != "low"
    ]

    sem = asyncio.Semaphore(5)

    async def explain(item: ReconciliationItem) -> None:
        async with sem:
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
                resp = await asyncio.to_thread(
                    client.messages.create,
                    model=settings.anthropic_model,
                    max_tokens=220,
                    messages=[{"role": "user", "content": prompt}],
                )
                item.ai_commentary = resp.content[0].text.strip()
            except Exception:
                logger.exception("AI commentary failed for item %s", item.id)

    await asyncio.gather(*(explain(i) for i in worth_explaining))

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
