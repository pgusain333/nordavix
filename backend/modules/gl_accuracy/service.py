"""
GL Accuracy — scan + interlink service.

Pulls the period's GL transactions plus a trailing window (the evidence), runs
the deterministic engine, and persists findings. Accept files a reclass
ProposedEntry into the Adjustments module (the interlink) and links it to the
finding; Dismiss records a confirmed vendor→account exception in Client Memory.

We never write to QuickBooks — Accept produces a *draft* the human posts.
"""
import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.db.base import current_tenant_id
from core.db.session import AsyncSessionLocal
from core.qbo_gl import pull_gl_transactions_multi
from models.gl_accuracy_finding import GlAccuracyFinding
from models.gl_balance_snapshot import GlBalanceSnapshot
from models.proposed_entry import ProposedEntry
from models.qbo_connection import QboConnection
from modules.gl_accuracy.engine import _norm_vendor, run_detectors
from modules.memory.service import (
    active_classification_exceptions,
    confirm_classification_exception,
)

logger = logging.getLogger(__name__)

# Vendor misclassification matters on the P&L spend side — scan expense + COGS
# accounts (where vendor coding decisions live), not balance-sheet accounts.
_EXPENSE_TYPES = ("expense", "cost of goods")


def _shift_months(d: date, months: int) -> date:
    """First-of-month `months` before `d` (which should be a month start)."""
    m = d.month - 1 - months
    y = d.year + m // 12
    return date(y, (m % 12) + 1, 1)


def _as_date(v) -> date | None:
    if isinstance(v, date):
        return v
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except (ValueError, TypeError):
        return None


def _dec(v) -> Decimal:
    try:
        return Decimal(str(v if v not in (None, "") else 0))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(0)


async def _expense_account_ids(db: AsyncSession, tenant_id: uuid.UUID, period_end: date) -> list[str]:
    rows = (await db.execute(
        select(GlBalanceSnapshot.qbo_account_id, GlBalanceSnapshot.account_type).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.period_end == period_end,
        ),
        execution_options={"skip_tenant_filter": True},
    )).all()
    out: list[str] = []
    seen: set[str] = set()
    for qid, atype in rows:
        if not qid or qid in seen:
            continue
        if any(t in (atype or "").lower() for t in _EXPENSE_TYPES):
            seen.add(qid)
            out.append(qid)
    return out


async def _all_snapshots(db: AsyncSession, tenant_id: uuid.UUID, period_end: date) -> list[dict]:
    """Every account's balance snapshot for the period (all account types) — the
    evidence for the structural detectors (suspense / contra-balance), which need
    the full chart of accounts, not just the expense stream."""
    rows = (await db.execute(
        select(
            GlBalanceSnapshot.qbo_account_id, GlBalanceSnapshot.account_name,
            GlBalanceSnapshot.account_number, GlBalanceSnapshot.account_type,
            GlBalanceSnapshot.balance,
        ).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.period_end == period_end,
        ),
        execution_options={"skip_tenant_filter": True},
    )).all()
    return [{"qbo_account_id": qid, "account_name": name, "account_number": num,
             "account_type": atype, "balance": bal}
            for qid, name, num, atype, bal in rows]


def _finding_key(flag: dict) -> str:
    # Stable per-finding key for idempotent re-scan. A detector may supply its own
    # `dedupe_key` (e.g. missing-recurring has no current txn); otherwise we build
    # one from txn_id + posted account (+ txn_number + amount as tiebreakers, since
    # QBO GL rows can lack a txn_id and we mustn't silently drop a real finding).
    #
    # Misclassification keeps its ORIGINAL un-prefixed key so a re-scan still
    # matches findings actioned before the Risk-Radar generalization — a
    # dismissed/accepted item must never come back. Other kinds namespace by kind.
    kind = str(flag.get("kind") or "misclassification")
    if flag.get("dedupe_key"):
        return f"{kind}:{flag['dedupe_key']}"[:160]
    base = ":".join([
        str(flag.get("qbo_txn_id") or ""),
        str(flag.get("posted_account_id") or ""),
        str(flag.get("txn_number") or ""),
        str(flag.get("amount") or ""),
    ])
    return (base if kind == "misclassification" else f"{kind}:{base}")[:160]


async def _replace_open_findings(
    db: AsyncSession, tenant_id: uuid.UUID, period_end: date, flags: list[dict]
) -> int:
    """Refresh OPEN findings for the period; never clobber actioned ones
    (in_adjustments / dismissed) — those are the human's decisions."""
    existing = (await db.execute(
        select(GlAccuracyFinding).where(GlAccuracyFinding.period_end == period_end)
    )).scalars().all()
    actioned_keys = {f.finding_key for f in existing if f.status != "open"}

    await db.execute(
        delete(GlAccuracyFinding).where(
            GlAccuracyFinding.tenant_id == tenant_id,
            GlAccuracyFinding.period_end == period_end,
            GlAccuracyFinding.status == "open",
        )
    )

    inserted = 0
    seen: set[str] = set()
    new_edges: list[tuple[str, str | None]] = []
    for fl in flags:
        key = _finding_key(fl)
        if key in actioned_keys or key in seen:
            continue
        seen.add(key)
        new_edges.append((key, fl.get("posted_account_id")))
        db.add(GlAccuracyFinding(
            id=uuid.uuid4(), tenant_id=tenant_id, period_end=period_end, finding_key=key,
            kind=fl.get("kind") or "misclassification",
            severity=fl.get("severity") or fl.get("confidence") or "medium",
            action_kind=fl.get("action_kind") or "reclass",
            title=(fl.get("title") or None),
            detail=(fl.get("detail") or None),
            evidence=(fl.get("evidence") or None),
            vendor=(fl.get("vendor") or "(unknown)")[:255],
            qbo_txn_id=fl.get("qbo_txn_id"), txn_type=fl.get("txn_type"),
            txn_number=fl.get("txn_number"), txn_date=_as_date(fl.get("txn_date")),
            amount=_dec(fl.get("amount")), memo=(fl.get("memo") or None),
            posted_account_id=fl.get("posted_account_id"),
            posted_account_name=fl.get("posted_account_name"),
            suggested_account_id=fl.get("suggested_account_id"),
            suggested_account_name=fl.get("suggested_account_name"),
            dominant_count=int(fl.get("dominant_count") or 0),
            total_count=int(fl.get("total_count") or 0),
            posted_count=int(fl.get("posted_count") or 0),
            confidence=fl.get("confidence") or "medium",
            status="open",
        ))
        inserted += 1

    # Knowledge-graph dual-write (best-effort, additive): record that each
    # finding is "found on" the account it flags and is "part of" the period.
    # Keyed on the stable finding_key so re-scans are idempotent. A graph
    # failure must never break the scan.
    if new_edges:
        try:
            from core.db.base import tenant_scope
            from core.graph import Node, link

            with tenant_scope(tenant_id):
                period_node = Node("period", period_end.isoformat())
                for key, acct in new_edges:
                    finding_node = Node("finding", key)
                    await link(db, finding_node, "part_of", period_node, origin="system")
                    if acct:
                        await link(db, finding_node, "found_on", Node("account", str(acct)), origin="system")
        except Exception:
            logger.exception("graph dual-write failed for GL-accuracy findings (non-fatal)")

    return inserted


async def scan_period(
    conn: QboConnection,
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    period_end: date,
    lookback_months: int = 12,
) -> dict:
    """Pull evidence, run the engine, persist findings. Returns a summary the UI
    uses for the reassurance strip. Caller commits."""
    period_start = period_end.replace(day=1)
    hist_start = _shift_months(period_start, lookback_months)
    hist_end = period_start - timedelta(days=1)

    # Structural detectors (suspense / contra-balance) read the full chart-of-
    # accounts balance snapshots — every account type, not just expense — so Risk
    # Radar reaches the balance sheet too. The vendor/transaction detectors still
    # run on the expense + COGS stream, where coding decisions live. We run even
    # when there are no expense accounts (the snapshots can still carry findings).
    snapshots = await _all_snapshots(db, tenant_id, period_end)
    acct_ids = await _expense_account_ids(db, tenant_id, period_end)
    current: list[dict] = []
    history: list[dict] = []
    if acct_ids:
        current = await pull_gl_transactions_multi(conn, db, acct_ids, period_start, period_end)
        history = await pull_gl_transactions_multi(conn, db, acct_ids, hist_start, hist_end)
    exceptions = await active_classification_exceptions(db)
    flags = run_detectors(current, history, snapshots=snapshots, exceptions=exceptions)
    await _replace_open_findings(db, tenant_id, period_end, flags)

    open_findings = (await db.execute(
        select(GlAccuracyFinding).where(
            GlAccuracyFinding.period_end == period_end,
            GlAccuracyFinding.status == "open",
        )
    )).scalars().all()
    high = sum(1 for f in open_findings if f.severity == "high")
    # "to reclassify" dollars cover only fixable findings (reclass/accrual);
    # review-only flags (duplicates, missing memos, …) aren't a dollar to move.
    dollars = sum((abs(_dec(f.amount)) for f in open_findings
                   if (f.action_kind or "reclass") != "flag"), Decimal("0"))
    return {
        "period_end": period_end.isoformat(),
        "scanned": len(current),
        "accounts": len(acct_ids),
        "findings": len(open_findings),
        "high": high,
        "medium": len(open_findings) - high,
        "dollars": str(dollars),
    }


async def run_auto_scan(tenant_id: uuid.UUID, period_end: date) -> None:
    """Watchdog pass triggered right after a QuickBooks sync, as a BackgroundTask.

    Runs in its own session with its own error handling: a scan failure must
    never surface to — or fail — the sync that scheduled it. Idempotent, since
    scan_period only replaces a period's *open* findings (accepted/dismissed
    stay put, and dismissed pairings remain suppressed via the learned
    exception). If QuickBooks isn't connected, it quietly does nothing.
    """
    current_tenant_id.set(tenant_id)
    async with AsyncSessionLocal() as session:
        try:
            conn = (await session.execute(
                select(QboConnection).where(QboConnection.tenant_id == tenant_id),
                execution_options={"skip_tenant_filter": True},
            )).scalar_one_or_none()
            if conn is None:
                return
            summary = await scan_period(conn, session, tenant_id=tenant_id, period_end=period_end)
            await write_audit_event(
                session, tenant_id=tenant_id, user_id=None, action="gl_accuracy.auto_scan",
                entity_type="period", entity_id=None,
                metadata={"summary": f"Auto-checked GL accuracy after sync for {period_end} "
                                     f"— {summary['findings']} to review",
                          "period_end": period_end.isoformat(), "findings": summary["findings"],
                          "scanned": summary["scanned"]},
            )
            await session.commit()
        except Exception:  # noqa: BLE001
            logger.exception("Auto GL-accuracy scan failed: tenant=%s period=%s", tenant_id, period_end)


def _composed_title(f: GlAccuracyFinding) -> str:
    """Fallback headline for rows written before titles were stored (legacy
    misclassification findings)."""
    posted = f.posted_account_name or f.posted_account_id or "another account"
    suggested = f.suggested_account_name or f.suggested_account_id or "the suggested account"
    return f"{f.vendor}: {posted} → {suggested}"


def serialize_finding(f: GlAccuracyFinding) -> dict:
    return {
        "id": str(f.id),
        "finding_key": f.finding_key,
        "period_end": f.period_end.isoformat(),
        "kind": f.kind or "misclassification",
        "severity": f.severity or f.confidence or "medium",
        "action_kind": f.action_kind or "reclass",
        "title": f.title or _composed_title(f),
        "detail": f.detail,
        "evidence": f.evidence,
        "vendor": f.vendor,
        "qbo_txn_id": f.qbo_txn_id,
        "txn_type": f.txn_type,
        "txn_number": f.txn_number,
        "txn_date": f.txn_date.isoformat() if f.txn_date else None,
        "amount": str(f.amount),
        "memo": f.memo,
        "posted_account_id": f.posted_account_id,
        "posted_account_name": f.posted_account_name,
        "suggested_account_id": f.suggested_account_id,
        "suggested_account_name": f.suggested_account_name,
        "dominant_count": f.dominant_count,
        "total_count": f.total_count,
        "posted_count": f.posted_count,
        "confidence": f.confidence,
        "status": f.status,
        "linked_proposed_entry_id": str(f.linked_proposed_entry_id) if f.linked_proposed_entry_id else None,
    }


async def list_findings(db: AsyncSession, period_end: date) -> dict:
    rows = (await db.execute(
        select(GlAccuracyFinding).where(GlAccuracyFinding.period_end == period_end)
    )).scalars().all()
    # open first, then by absolute dollars desc.
    rows = sorted(rows, key=lambda f: (f.status != "open", -abs(_dec(f.amount))))
    open_rows = [f for f in rows if f.status == "open"]
    high = sum(1 for f in open_rows if f.severity == "high")
    dollars = sum((abs(_dec(f.amount)) for f in open_rows
                   if (f.action_kind or "reclass") != "flag"), Decimal("0"))
    return {
        "items": [serialize_finding(f) for f in rows],
        "open_count": len(open_rows),
        "high": high,
        "medium": len(open_rows) - high,
        "dollars": str(dollars),
    }


def build_reclass_entry(f: GlAccuracyFinding) -> dict:
    """The correcting JE: move the amount from the posted (wrong) account to the
    suggested (right) one, in the direction matching the original entry's sign."""
    signed = _dec(f.amount)
    amt = abs(signed)
    right = {"account_qbo_id": f.suggested_account_id,
             "account_name": f.suggested_account_name or "Suggested account"}
    wrong = {"account_qbo_id": f.posted_account_id,
             "account_name": f.posted_account_name or "Posted account"}
    if signed >= 0:  # original debited the wrong account → Dr right, Cr wrong
        lines = [{**right, "debit": str(amt), "credit": "0.00"},
                 {**wrong, "debit": "0.00", "credit": str(amt)}]
    else:            # original credited the wrong account → Dr wrong, Cr right
        lines = [{**wrong, "debit": str(amt), "credit": "0.00"},
                 {**right, "debit": "0.00", "credit": str(amt)}]
    rationale = (
        f"{f.vendor} posts to {f.suggested_account_name or f.suggested_account_id} on "
        f"{f.dominant_count} of its last {f.total_count} transactions; this entry went to "
        f"{f.posted_account_name or f.posted_account_id}."
    )
    desc = (f"Reclassify {f.vendor}: {f.posted_account_name or 'posted'} → "
            f"{f.suggested_account_name or 'suggested'}")
    return {"description": desc[:500], "memo": (f.memo or None),
            "rationale": rationale, "confidence": f.confidence, "lines": lines}


def build_accrual_entry(f: GlAccuracyFinding) -> dict:
    """The accrual for a recurring charge that's missing this period: Dr the
    expense account the vendor usually hits (known), Cr an accrued-liability
    account the preparer picks in Adjustments before posting (we can't reliably
    know the client's accrual account, so we leave it as an editable placeholder
    — confirm-first, and we never post to QuickBooks)."""
    amt = abs(_dec(f.amount))
    expense = {"account_qbo_id": f.suggested_account_id,
               "account_name": f.suggested_account_name or "Expense account"}
    accrued = {"account_qbo_id": None, "account_name": "Accrued liabilities (select account)"}
    lines = [{**expense, "debit": str(amt), "credit": "0.00"},
             {**accrued, "debit": "0.00", "credit": str(amt)}]
    rationale = (
        f"{f.vendor} recurs in most recent months (~{amt}) but has no entry this period; "
        f"accrue the expected charge. Choose the accrued-liability account before posting."
    )
    desc = f"Accrue {f.vendor} — recurring {f.suggested_account_name or 'expense'} missing this period"
    return {"description": desc[:500], "memo": None, "rationale": rationale,
            "confidence": f.severity or f.confidence or "medium", "lines": lines}


async def accept_finding(
    db: AsyncSession, *, tenant_id: uuid.UUID, finding: GlAccuracyFinding, user_id: uuid.UUID | None,
) -> uuid.UUID:
    """File the fixable finding as a ProposedEntry in Adjustments and link it.
    Caller commits. Review-only flags aren't fixable by a JE and must go through
    acknowledge_finding instead — guarded here so a flag can never mint an entry."""
    action = finding.action_kind or "reclass"
    if action == "flag":
        raise ValueError("This finding is review-only; acknowledge it instead of accepting.")
    entry = build_accrual_entry(finding) if action == "accrual" else build_reclass_entry(finding)
    pe = ProposedEntry(
        id=uuid.uuid4(), tenant_id=tenant_id, source="gl_accuracy",
        source_ref=str(finding.id), period_end=finding.period_end,
        description=entry["description"], lines=entry["lines"], memo=entry["memo"],
        rationale=entry["rationale"], confidence=entry["confidence"], status="open",
        created_by=user_id,
    )
    db.add(pe)
    await db.flush()
    finding.status = "in_adjustments"
    finding.linked_proposed_entry_id = pe.id
    finding.status_changed_by = user_id
    finding.status_changed_at = datetime.now(UTC)

    # Knowledge graph: the adjusting entry explains the finding it resolves —
    # closing the loop from "flag" to "fix". Best-effort; never break the accept.
    try:
        from core.db.base import tenant_scope
        from core.graph import Node, link

        with tenant_scope(tenant_id):
            await link(
                db, Node("journal_entry", str(pe.id)), "explains",
                Node("finding", finding.finding_key), origin="system", created_by=user_id,
            )
    except Exception:
        logger.exception("graph link failed for accepted finding %s (non-fatal)", finding.id)

    return pe.id


async def dismiss_finding(
    db: AsyncSession, *, tenant_id: uuid.UUID, finding: GlAccuracyFinding, user_id: uuid.UUID | None,
) -> None:
    """Close the finding as 'not a problem'. For a MISCLASSIFICATION, this also
    records a confirmed vendor→account exception so the watchdog never re-flags
    that pairing. For other kinds we only close it — recording a classification
    exception would wrongly tell the miscode detector the pairing is 'correct'.
    (Within-period re-flagging is already prevented by the finding_key.) Caller
    commits."""
    if (finding.kind or "misclassification") == "misclassification":
        await confirm_classification_exception(
            db, tenant_id=tenant_id, vendor=finding.vendor,
            vendor_norm=_norm_vendor(finding.vendor),
            account_id=finding.posted_account_id or "",
            account_name=finding.posted_account_name, created_by=user_id,
        )
    finding.status = "dismissed"
    finding.status_changed_by = user_id
    finding.status_changed_at = datetime.now(UTC)


async def acknowledge_finding(
    db: AsyncSession, *, finding: GlAccuracyFinding, user_id: uuid.UUID | None,
) -> None:
    """Mark a review-only flag as handled (no journal entry). For findings whose
    action is to be *looked at*, not auto-fixed (duplicates, missing memos, …).
    Distinct from dismiss, which records 'this isn't a problem'. Caller commits."""
    finding.status = "acknowledged"
    finding.status_changed_by = user_id
    finding.status_changed_at = datetime.now(UTC)
