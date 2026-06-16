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
import hashlib
import logging
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import anthropic
import httpx
from sqlalchemy import delete, select
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

async def _refresh_token_if_needed(conn: QboConnection, db: AsyncSession) -> str:
    """Refresh the access token if it's within 5 minutes of expiry. Delegates to
    the shared, per-realm-serialized refresh so concurrent syncs (the 4-way
    evidence pulls, or Autopilot + a manual sync) can't double-refresh and
    corrupt Intuit's rotating refresh token."""
    from core.qbo_auth import refresh_access_token
    return await refresh_access_token(conn, db)


async def _qbo_get(conn: QboConnection, db: AsyncSession, path: str, params: dict | None = None) -> dict:
    from core.qbo_http import request_with_retry

    token = await _refresh_token_if_needed(conn, db)
    url = f"{settings.qbo_base_url}/v3/company/{conn.realm_id}{path}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await request_with_retry(
            lambda: client.get(url, headers=headers, params=params or {}),
            label=f"QBO GET {path}",
        )
    if resp.status_code == 401:
        raise RuntimeError("QBO returned 401 — reconnect QuickBooks.")
    if resp.status_code != 200:
        raise RuntimeError(f"QBO API error ({resp.status_code}): {resp.text[:500]}")
    return resp.json()


async def fetch_posted_journal_entries(
    conn: QboConnection, session: AsyncSession, *, start: date, end: date,
) -> list[dict]:
    """Read QBO JournalEntry transactions dated in [start, end] and return them
    as simplified dicts for matching against proposed adjustments:

        {"doc": str, "id": str, "txn_date": str,
         "lines": [{"account_id": str, "posting_type": "Debit"|"Credit",
                    "amount": Decimal}]}

    Read-only — Nordavix never writes to QBO. Used by the adjustments posting
    check to confirm the user booked the entries."""
    q = (
        f"SELECT Id, DocNumber, TxnDate, PrivateNote, Line "
        f"FROM JournalEntry WHERE TxnDate >= '{start.isoformat()}' "
        f"AND TxnDate <= '{end.isoformat()}' MAXRESULTS 500"
    )
    data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
    jes = data.get("QueryResponse", {}).get("JournalEntry", []) or []
    out: list[dict] = []
    for je in jes:
        lines: list[dict] = []
        for line in je.get("Line", []) or []:
            detail = line.get("JournalEntryLineDetail") or {}
            acct = (detail.get("AccountRef") or {}).get("value")
            ptype = detail.get("PostingType")
            if not acct or ptype not in ("Debit", "Credit"):
                continue
            lines.append({
                "account_id": str(acct),
                "posting_type": ptype,
                "amount": _dec(line.get("Amount")),
            })
        out.append({
            "doc": str(je.get("DocNumber") or je.get("Id") or ""),
            "id": str(je.get("Id") or ""),
            "txn_date": je.get("TxnDate"),
            "lines": lines,
        })
    return out


# ── Report parsing ─────────────────────────────────────────────────────────────

def _flatten_report_rows(report: dict) -> list[dict]:
    """
    QBO report payloads nest rows. Flatten to a list of {col_name: value} dicts.

    Tolerant of QBO's quirks:
      - Column titles vary by region/version; we keep BOTH the ColTitle key
        AND a normalized fallback key derived from ColType so callers can
        look up by either ("Customer" vs "Cust" vs ColType=Customer).
      - Some rows have empty ColTitle; we fall back to ColType, then to
        a positional `col_<i>` key.
      - Entity IDs (customer / vendor / account refs) are stashed under
        `<title>_id` AND `_entity_id` so callers don't have to guess the
        title casing.
    """
    rows_section = report.get("Rows", {}).get("Row", [])
    raw_cols = report.get("Columns", {}).get("Column", []) or []

    # Build per-column metadata. Each column gets (title, coltype, fallback_key)
    col_meta: list[tuple[str, str, str]] = []
    for i, c in enumerate(raw_cols):
        title = (c.get("ColTitle") or "").strip()
        coltype = (c.get("ColType") or "").strip()
        fallback = title or coltype or f"col_{i}"
        col_meta.append((title, coltype, fallback))

    out: list[dict] = []

    def walk(rows: list[dict]) -> None:
        for r in rows:
            sub = r.get("Rows", {}).get("Row", []) or []
            if sub:
                walk(sub)
            cols = r.get("ColData", []) or []
            if not cols:
                continue
            d: dict = {}
            for i, c in enumerate(cols):
                title, coltype, fallback = col_meta[i] if i < len(col_meta) else ("", "", f"col_{i}")
                val = c.get("value", "")
                # Store under every reasonable key so downstream lookup
                # works regardless of which name the QBO instance returns.
                if title:
                    d[title] = val
                if coltype and coltype not in d:
                    d[coltype] = val
                d[fallback] = val
                d[f"col_{i}"] = val
                entity_id = c.get("id")
                if entity_id:
                    if title:
                        d[f"{title}_id"] = entity_id
                    if coltype:
                        d[f"{coltype}_id"] = entity_id
                    d["_entity_id"] = entity_id
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
            elif recon.recon_type in _ACCOUNT_TYPE_MAP:
                # Generic balance-sheet account reconciliation — one item per
                # account in the selected QBO AccountType, with the period-end
                # balance + last-90-days transactions for variance evidence.
                await _sync_accounts(
                    session, conn, recon, tenant_id,
                    qbo_account_types=_ACCOUNT_TYPE_MAP[recon.recon_type],
                )
            else:
                # MVP: any remaining type gets a stub item so the UI renders
                await _sync_stub(session, recon, tenant_id)

            # AI commentary is now strictly on-demand: the user clicks
            # "Generate AI commentary" from the detail page when they want
            # an explanation. We never auto-spend tokens during sync.
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


def _row_value_fuzzy(row: dict, needles: list[str]) -> Any:
    """
    Look up a column value where the column title may be slightly different
    across QBO regions (e.g. "1 - 30" vs "1-30" vs "Days1to30" vs "Age1_30").
    We match by substring against ANY key in the row dict.
    """
    # First try exact key match (cheap)
    for n in needles:
        if n in row:
            return row[n]
    # Then fuzzy: normalize both sides and check containment
    norm_needles = [_normalize(n) for n in needles]
    for key, val in row.items():
        nk = _normalize(str(key))
        if any(nn and nn in nk for nn in norm_needles):
            return val
    return None


def _normalize(s: str) -> str:
    """Lowercase, strip spaces/hyphens/underscores/dots — for fuzzy column matching."""
    return "".join(ch for ch in s.lower() if ch.isalnum())


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

    Resilient against QBO column title drift — uses fuzzy matching plus
    POSITIONAL fallback for AgedReceivables/AgedPayables (the layout is
    always: Entity | Current | 1-30 | 31-60 | 61-90 | >90 | Total).
    """
    # Title-based alias lists (try lots of variations)
    aliases = {
        "current":   ["Current", "0-30", "0 - 30", "Current Due", "Not Due", "current"],
        "1_30":      ["1 - 30", "1-30", "1 to 30", "Days1to30", "Age1_30", "1-30 days"],
        "31_60":     ["31 - 60", "31-60", "31 to 60", "Days31to60", "Age31_60"],
        "61_90":     ["61 - 90", "61-90", "61 to 90", "Days61to90", "Age61_90"],
        "over_90":   ["91 and over", "> 90", "Over 90", "90+", "Days90Plus", "Over90Days"],
        "total":     ["Total", "Amount", "Balance"],
    }
    # Positional fallback for QBO's aging reports — used only when titles
    # didn't yield a hit. Index matches "Current" (1), 1-30 (2), 31-60 (3),
    # 61-90 (4), >90 (5), Total (6).
    POS = {"current": 1, "1_30": 2, "31_60": 3, "61_90": 4, "over_90": 5, "total": 6}

    def get(row: dict, bucket: str) -> Decimal:
        v = _row_value_fuzzy(row, aliases[bucket])
        if v is None or v == "":
            v = row.get(f"col_{POS[bucket]}", "")
        return _dec(v)

    items: list[ReconciliationItem] = []
    for r in rows:
        name = _row_value_fuzzy(r, entity_col_aliases)
        if name is None:
            # Fall back to first column positionally
            name = r.get("col_0", "")
        n = str(name).strip()
        if not n or n.upper().startswith(("TOTAL", "SUBTOTAL", "GRAND")):
            continue
        total = get(r, "total")
        # Sum the aging buckets as a tiebreaker — some QBO reports omit a Total col
        bucket_sum = sum((get(r, k) for k in ("current", "1_30", "31_60", "61_90", "over_90")),
                         Decimal("0"))
        if total == 0:
            total = bucket_sum
        if total == 0:
            continue

        # Entity ID lookup: try the specific field first, then fall back
        # to the universal _entity_id stashed by _flatten_report_rows.
        qbo_id = r.get(entity_id_field) or r.get("_entity_id")

        item_totals = {
            "aging_current": get(r, "current"),
            "aging_1_30":    get(r, "1_30"),
            "aging_31_60":   get(r, "31_60"),
            "aging_61_90":   get(r, "61_90"),
            "aging_over_90": get(r, "over_90"),
            "subledger_balance": total,
            "difference": Decimal("0"),
        }
        risk = _risk_for(item_totals)
        items.append(ReconciliationItem(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_id=recon.id,
            entity_name=n,
            entity_qbo_id=qbo_id,
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


# ── Generic balance-sheet account reconciliations ────────────────────────────
#
# QBO's Account.AccountType enum drives this. We map our internal recon_type
# to one or more QBO AccountTypes so a single reconciliation can cover all
# related accounts (e.g. FIXED_ASSETS catches both "Fixed Asset" and
# "Accumulated Depreciation" — typically you reconcile them together).
#
# Source for the QBO enum:
#   https://developer.intuit.com/.../entities/Account#enum-accounttype

_ACCOUNT_TYPE_MAP: dict[str, list[str]] = {
    "BANK":                    ["Bank"],
    "CC":                      ["Credit Card"],
    "FIXED_ASSETS":            ["Fixed Asset", "Other Asset"],
    "OTHER_CURRENT_ASSET":     ["Other Current Asset"],
    "OTHER_ASSET":             ["Other Asset"],
    "OTHER_CURRENT_LIABILITY": ["Other Current Liability"],
    "LONG_TERM_LIABILITY":     ["Long Term Liability"],
    "EQUITY":                  ["Equity"],
    "OTHER": [
        "Other Current Asset", "Other Asset",
        "Other Current Liability", "Long Term Liability", "Equity",
    ],
}


async def _sync_accounts(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    tenant_id: uuid.UUID,
    qbo_account_types: list[str],
) -> None:
    """
    Pull every account whose QBO AccountType is in `qbo_account_types`. For
    each account: list it with its period-end balance (from CurrentBalance —
    QBO doesn't return historical CurrentBalance via the Account query, so
    for true period-end we use the TrialBalance report at period_end).

    Sub-ledger is conceptual here:
      - For these account types QBO doesn't maintain a separate sub-ledger.
        Instead, we treat the SUM OF PERIOD-END ACCOUNT BALANCES as both the
        GL total AND the subledger total — they're definitionally equal in
        QBO because there's no external system to reconcile against.
      - The "reconciling item" pattern is preserved (gap == 0 here unless a
        custom sub-ledger feed is wired up later, e.g. fixed-asset manager).

    The detail page then shows per-account balances + recent transactions so
    the controller can drill in. Real reconciliation work for these accounts
    is rollforward analysis (BB + additions - reductions = EB) and that's
    what the AI commentary articulates per-account.
    """
    await _wipe_items(session, recon.id)

    # Pull TrialBalance to get accurate period-end balances per account.
    # The report is keyed by account display name; we cross-reference with
    # the Account query to filter by AccountType + capture QBO IDs.
    accounts = await _qbo_list_accounts(conn, session, qbo_account_types)
    if not accounts:
        recon.gl_total = Decimal("0")
        recon.subledger_total = Decimal("0")
        recon.difference = Decimal("0")
        await session.flush()
        return

    tb_balances = await _qbo_trial_balance_by_account(conn, session, recon.period_end)

    items_to_create: list[ReconciliationItem] = []
    grand_total = Decimal("0")
    for acct in accounts:
        name = str(acct.get("Name") or "Unnamed account")
        acct_num = str(acct.get("AcctNum") or "").strip()
        qbo_id = str(acct.get("Id") or "")
        display = f"{acct_num} {name}".strip() if acct_num else name

        # Look up by exact name + by stripped fully-qualified name
        balance = tb_balances.get(display) or tb_balances.get(name) or Decimal("0")
        grand_total += balance

        items_to_create.append(ReconciliationItem(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            reconciliation_id=recon.id,
            entity_name=display,
            entity_qbo_id=qbo_id or None,
            gl_balance=balance,
            subledger_balance=balance,
            difference=Decimal("0"),
            aging_current=Decimal("0"),
            aging_1_30=Decimal("0"),
            aging_31_60=Decimal("0"),
            aging_61_90=Decimal("0"),
            aging_over_90=Decimal("0"),
            risk_level=_risk_for_account_balance(balance),
            status="pending",
        ))

    for item in items_to_create:
        session.add(item)

    recon.gl_total = grand_total
    recon.subledger_total = grand_total
    recon.difference = Decimal("0")
    await session.flush()

    # Pull last-90-days transactions for each account into the evidence table
    # (sub-bounded concurrency so we don't blast the QBO API).
    await _sync_account_transactions(session, conn, recon, items_to_create, tenant_id)


def _risk_for_account_balance(balance: Decimal) -> str:
    """Crude heuristic until we have variance vs prior period:
       balances >$50k flagged medium, >$500k high. Tweak per company size later."""
    abs_bal = abs(balance)
    if abs_bal > Decimal("500000"):
        return "high"
    if abs_bal > Decimal("50000"):
        return "medium"
    return "low"


async def _qbo_list_accounts(
    conn: QboConnection,
    session: AsyncSession,
    account_types: list[str],
) -> list[dict]:
    """Return active accounts whose AccountType is in the provided list."""
    if not account_types:
        return []
    quoted = ", ".join(f"'{t}'" for t in account_types)
    q = (
        f"SELECT Id, Name, AcctNum, AccountType, CurrentBalance "
        f"FROM Account WHERE AccountType IN ({quoted}) AND Active = true "
        f"MAXRESULTS 500"
    )
    try:
        data = await _qbo_get(conn, session, "/query", params={"query": q, "minorversion": "65"})
    except Exception:
        logger.exception("QBO account list failed for types %s", account_types)
        return []
    return data.get("QueryResponse", {}).get("Account", []) or []


async def _qbo_trial_balance_by_account(
    conn: QboConnection,
    session: AsyncSession,
    period_end: date,
) -> dict[str, Decimal]:
    """
    Pull QBO TrialBalance report for period_end and return a dict keyed by
    the account name (as QBO renders it) → net balance (debit - credit).
    """
    out: dict[str, Decimal] = {}
    try:
        report = await _qbo_get(
            conn, session, "/reports/TrialBalance",
            params={"end_date": period_end.isoformat(), "accounting_method": "Accrual"},
        )
    except Exception:
        logger.exception("QBO TrialBalance pull failed for %s", period_end)
        return out

    def walk(rows: list[dict]) -> None:
        for r in rows:
            cols = r.get("ColData") or []
            sub = r.get("Rows", {}).get("Row", []) or []
            if cols and cols[0].get("value"):
                name = str(cols[0]["value"]).strip()
                if name and not name.lower().startswith(("total", "subtotal", "net income", "net loss")):
                    debit  = _dec(cols[1].get("value", "")) if len(cols) > 1 else Decimal("0")
                    credit = _dec(cols[2].get("value", "")) if len(cols) > 2 else Decimal("0")
                    out[name] = debit - credit
            if sub:
                walk(sub)

    walk(report.get("Rows", {}).get("Row", []) or [])
    return out


async def _sync_account_transactions(
    session: AsyncSession,
    conn: QboConnection,
    recon: Reconciliation,
    items: list[ReconciliationItem],
    tenant_id: uuid.UUID,
) -> None:
    """
    For each account, pull JournalEntry lines + Purchase + Deposit + Bill +
    Invoice rows from the last 90 days that touched it. Stored as evidence
    in recon_transactions for the detail page rollforward view.
    Bounded concurrency = 4.
    """
    cutoff = (recon.period_end - timedelta(days=90)).isoformat()
    end = recon.period_end.isoformat()
    sem = asyncio.Semaphore(4)

    async def for_one(item: ReconciliationItem) -> None:
        if not item.entity_qbo_id:
            return
        async with sem:
            try:
                # JE lines that touched this account
                q = (
                    f"SELECT Id, DocNumber, TxnDate, PrivateNote, Line "
                    f"FROM JournalEntry WHERE TxnDate >= '{cutoff}' "
                    f"AND TxnDate <= '{end}' MAXRESULTS 50"
                )
                data = await _qbo_get(conn, session, "/query",
                                       params={"query": q, "minorversion": "65"})
                jes = data.get("QueryResponse", {}).get("JournalEntry", []) or []
            except Exception:
                jes = []

            for je in jes:
                amt = Decimal("0")
                for line in je.get("Line", []) or []:
                    detail = line.get("JournalEntryLineDetail") or {}
                    if (detail.get("AccountRef") or {}).get("value") != item.entity_qbo_id:
                        continue
                    line_amt = _dec(line.get("Amount"))
                    amt += line_amt if detail.get("PostingType") == "Debit" else -line_amt
                if amt == 0:
                    continue
                session.add(ReconTransaction(
                    id=uuid.uuid4(),
                    tenant_id=tenant_id,
                    reconciliation_item_id=item.id,
                    txn_type="JournalEntry",
                    txn_number=str(je.get("DocNumber") or ""),
                    txn_date=_parse_date(je.get("TxnDate")),
                    amount=amt,
                    memo=str(je.get("PrivateNote") or "")[:500] or None,
                    category="manual_je",
                    meta={"je_id": je.get("Id")},
                ))

    await asyncio.gather(*(for_one(i) for i in items))


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
    "You are a senior CPA reviewing a {recon_type} reconciliation as of "
    "{period_end}. Write 2 to 3 sentences for the controller explaining the "
    "balance, aging, and variance for this {entity_label} so they can decide "
    "whether to investigate.\n\n"
    "{entity_label}: {entity_name}\n"
    "GL balance:        ${gl_balance:,.2f}\n"
    "Subledger balance: ${sub_balance:,.2f}\n"
    "Difference:        ${difference:,.2f}\n"
    "Aging — Current ${a0:,.2f} | 1-30 ${a1:,.2f} | 31-60 ${a2:,.2f} | "
    "61-90 ${a3:,.2f} | >90 ${a4:,.2f}\n"
    "Risk: {risk}\n\n"
    "Formatting rules — these are strict:\n"
    "- Plain prose only. No headers, no bullet lists, no tables.\n"
    "- Never use markdown. No **, no __, no ##, no ---, no backticks.\n"
    "- If you must separate clauses, use a normal hyphen-minus (-) or a period.\n"
    "- Do not restate the numbers verbatim — interpret them.\n"
    "- Professional tone, action-oriented, suitable for a controller's workpaper."
)


_AI_SUMMARY_PROMPT = (
    "You are a senior CPA. Write a 2 to 3 sentence executive summary of this "
    "{recon_type} reconciliation as of {period_end}. Total GL ${gl:,.2f}, "
    "total subledger ${sub:,.2f}, net difference ${diff:,.2f}. {n_items} "
    "{label_plural}, {n_high} flagged high-risk. {extra}\n\n"
    "Formatting rules — these are strict:\n"
    "- Plain prose only. No headers, no bullet lists, no tables.\n"
    "- Never use markdown. No **, no __, no ##, no ---, no backticks.\n"
    "- If you must separate clauses, use a normal hyphen-minus (-) or a period.\n"
    "- Mention specific {label_singular} names only when materially relevant.\n"
    "- Professional tone, controller-grade."
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


def _entity_label_for(recon_type: str, plural: bool = False) -> str:
    """UI/AI-friendly label for what each reconciliation item represents."""
    base = {
        "AR": "customer", "AP": "vendor",
        "BANK": "bank account", "CC": "credit card",
        "FIXED_ASSETS": "fixed asset account",
        "OTHER_CURRENT_ASSET": "current asset account",
        "OTHER_ASSET": "asset account",
        "OTHER_CURRENT_LIABILITY": "current liability account",
        "LONG_TERM_LIABILITY": "long-term liability account",
        "EQUITY": "equity account",
    }.get(recon_type, "account")
    if not plural:
        return base.title() if recon_type in ("AR", "AP") else base
    return base + "s"


def _strip_markdown(text: str) -> str:
    """
    Belt-and-suspenders cleanup of any markdown the model leaks despite the
    prompt instructions. Strips bold/italic, header marks, em-dashes that
    look like list separators, and trailing whitespace.
    """
    import re
    cleaned = text
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)   # **bold**
    cleaned = re.sub(r"\*([^*]+)\*",     r"\1", cleaned)   # *italic*
    cleaned = re.sub(r"__([^_]+)__",     r"\1", cleaned)   # __bold__
    cleaned = re.sub(r"^#{1,6}\s+",      "",    cleaned, flags=re.M)  # headers
    cleaned = re.sub(r"`([^`]+)`",       r"\1", cleaned)   # `code`
    cleaned = cleaned.replace("—", "-").replace("–", "-")
    cleaned = re.sub(r"^[ \t]*-{2,}[ \t]*$", "", cleaned, flags=re.M)  # divider --- lines
    return cleaned.strip()


async def explain_item(
    session: AsyncSession,
    recon: Reconciliation,
    item: ReconciliationItem,
) -> str | None:
    """
    Generate AI commentary for a single reconciliation item. Synchronous
    from the caller's perspective — the caller awaits the result and persists
    it. Returns the commentary string, or None if anthropic isn't configured
    or the call failed.
    """
    if not settings.anthropic_api_key:
        return None
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    prompt = _AI_PROMPT.format(
        recon_type=recon.recon_type,
        period_end=recon.period_end.isoformat(),
        entity_label=_entity_label_for(recon.recon_type).title(),
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
            max_tokens=260,
            messages=[{"role": "user", "content": prompt}],
        )
        from core.ai.usage import record_response
        record_response(resp, operation="recon_item_commentary")
        return _strip_markdown(resp.content[0].text if resp.content else "")
    except Exception:
        logger.exception("AI commentary failed for item %s", item.id)
        return None


async def explain_recon_summary(
    session: AsyncSession,
    recon: Reconciliation,
) -> str | None:
    """Aggregate AI summary for the whole reconciliation."""
    if not settings.anthropic_api_key:
        return None
    items = list((await session.execute(
        select(ReconciliationItem).where(ReconciliationItem.reconciliation_id == recon.id)
    )).scalars().all())
    high_risk = [i for i in items if i.risk_level == "high"]
    biggest = sorted(items, key=lambda i: abs(i.difference), reverse=True)[:3]
    extra = ""
    if biggest and abs(biggest[0].difference) > Decimal("100"):
        names = ", ".join(b.entity_name for b in biggest if abs(b.difference) > Decimal("100"))
        if names:
            extra = f"Biggest variances by name: {names}."

    prompt = _AI_SUMMARY_PROMPT.format(
        recon_type=recon.recon_type,
        period_end=recon.period_end.isoformat(),
        gl=float(recon.gl_total),
        sub=float(recon.subledger_total),
        diff=float(recon.difference),
        n_items=len(items),
        n_high=len(high_risk),
        label_singular=_entity_label_for(recon.recon_type),
        label_plural=_entity_label_for(recon.recon_type, plural=True),
        extra=extra,
    )
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    try:
        resp = await asyncio.to_thread(
            client.messages.create,
            model=settings.anthropic_model,
            max_tokens=320,
            messages=[{"role": "user", "content": prompt}],
        )
        from core.ai.usage import record_response
        record_response(resp, operation="recon_summary")
        return _strip_markdown(resp.content[0].text if resp.content else "")
    except Exception:
        logger.exception("AI summary failed for recon %s", recon.id)
        return None


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
