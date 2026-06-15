"""
Proposed adjusting entries — shared service layer.

Turns close-difference findings into reviewable journal entries
(``ProposedEntry`` rows). Three producers feed this:

  * bank reconciliation (deterministic — ``generate_bank_proposals`` here)
  * recon agentic commentary (``modules/recons/agentic.py`` calls
    ``replace_open_proposals`` with AI-drafted lines)
  * flux deep-agentic (``modules/flux/deep_agentic.py`` likewise)

The router (``modules/adjustments/router.py``) reads/serializes them and
drives the open → accepted → posted / dismissed lifecycle.

Two invariants live here, in one place, so every producer obeys them:

  1. **Balanced or not persisted.** A draft is only stored as ``open`` when
     its lines balance (Σ debit == Σ credit, within $0.01). A malformed AI
     suggestion is silently dropped rather than shown as a broken JE.
  2. **Human decisions are sticky.** Regenerating a source replaces only the
     ``open`` proposals for its ``(tenant, source, source_ref, period_end)``
     key — accepted / posted / dismissed rows are never clobbered.
"""
import logging
import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.gl_balance_snapshot import GlBalanceSnapshot
from models.proposed_entry import ProposedEntry

logger = logging.getLogger(__name__)

ZERO = Decimal("0.00")
# A JE balances if debits and credits agree to the cent. Rounding two
# decimal places can leave a sub-cent gap; one cent of slack absorbs it.
BALANCE_TOLERANCE = Decimal("0.01")

VALID_SOURCES = {"bank", "recon", "flux", "gl_accuracy"}
VALID_STATUSES = {"open", "accepted", "posted", "dismissed"}
VALID_CONFIDENCE = {"high", "medium", "low"}

# Keyword → suggested offset account for deterministic bank entries.
_FEE_KEYWORDS = ("fee", "service charge", "service chg", "charge", "nsf", "overdraft", "maintenance")
_INTEREST_KEYWORDS = ("interest", "int earned", "int credit")


def _q(value) -> Decimal:
    """Quantize anything number-ish to 2dp; non-numeric → 0.00."""
    try:
        return Decimal(str(value if value is not None else 0)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
    except (InvalidOperation, ValueError, TypeError):
        return ZERO


# ── JE line normalization + balance ──────────────────────────────────────


def _clean_line(raw: dict) -> dict | None:
    """Normalize one JE line to the canonical shape, or None if unusable.

    Accepts ``account`` or ``account_name`` for the label and tolerates
    string amounts (AI output). A line carries either a debit OR a credit,
    never both — if both arrive, keep the larger and zero the other.
    """
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("account_name") or raw.get("account") or "").strip()
    if not name:
        return None
    debit = _q(raw.get("debit"))
    credit = _q(raw.get("credit"))
    if debit <= ZERO and credit <= ZERO:
        return None
    if debit > ZERO and credit > ZERO:
        if debit >= credit:
            credit = ZERO
        else:
            debit = ZERO
    qid = raw.get("account_qbo_id") or raw.get("qbo_account_id")
    num = raw.get("account_number")
    return {
        "account_qbo_id": str(qid).strip() if qid else None,
        "account_number": str(num).strip() if num else None,
        "account_name": name[:255],
        "debit": str(debit if debit > ZERO else ZERO),
        "credit": str(credit if credit > ZERO else ZERO),
    }


def normalize_lines(raw_lines) -> list[dict]:
    """Clean a list of raw JE lines, dropping unusable ones."""
    if not isinstance(raw_lines, list):
        return []
    out = []
    for r in raw_lines:
        cl = _clean_line(r)
        if cl is not None:
            out.append(cl)
    return out


def lines_balanced(lines: list[dict]) -> bool:
    """True if 2+ lines with positive debits == credits (within tolerance)."""
    if len(lines) < 2:
        return False
    dr = sum((Decimal(line["debit"]) for line in lines), ZERO)
    cr = sum((Decimal(line["credit"]) for line in lines), ZERO)
    return dr > ZERO and abs(dr - cr) <= BALANCE_TOLERANCE


def parse_ai_entries(raw_entries, accounts: list[dict] | None = None) -> list[dict]:
    """Normalize + validate a list of AI-proposed JE entries into the shape
    ``replace_open_proposals`` expects. Maps each line onto a real chart
    account (by number, then name) so proposals reference live GL accounts,
    drops anything that doesn't balance, and clamps confidence. Shared by the
    recon and flux AI producers so they parse identically. Caps at 5 entries."""
    by_number: dict[str, dict] = {}
    by_name: dict[str, dict] = {}
    for a in accounts or []:
        if a.get("account_number"):
            by_number[str(a["account_number"]).strip()] = a
        if a.get("account_name"):
            by_name[str(a["account_name"]).strip().lower()] = a

    out: list[dict] = []
    for pe in (raw_entries or [])[:5]:
        if not isinstance(pe, dict):
            continue
        lines = normalize_lines(pe.get("lines"))
        for ln in lines:
            match = None
            if ln.get("account_number") and ln["account_number"] in by_number:
                match = by_number[ln["account_number"]]
            elif ln.get("account_name", "").lower() in by_name:
                match = by_name[ln["account_name"].lower()]
            if match is not None:
                ln["account_qbo_id"] = match.get("qbo_account_id")
                ln["account_number"] = match.get("account_number") or ln.get("account_number")
                ln["account_name"] = match.get("account_name") or ln["account_name"]
        if not lines_balanced(lines):
            continue
        conf = str(pe.get("confidence") or "").lower().strip()
        out.append({
            "description": str(pe.get("description") or "").strip()[:500] or "Proposed adjusting entry",
            "memo":        (str(pe.get("memo")).strip()[:500] if pe.get("memo") else None),
            "rationale":   (str(pe.get("rationale") or pe.get("reason") or "").strip() or None),
            "confidence":  conf if conf in VALID_CONFIDENCE else "medium",
            "lines":       lines,
        })
    return out


# ── Chart of accounts (for AI account-mapping + offset suggestions) ───────


async def period_accounts(
    db: AsyncSession, tenant_id: uuid.UUID, period_end: date
) -> list[dict]:
    """Distinct chart of accounts captured for this period, from the GL
    snapshot. Used to (a) suggest deterministic bank offsets and (b) let the
    AI producers map proposed lines onto real accounts."""
    # Explicit tenant filter + skip the auto-filter so this works identically
    # from a request (tenant ContextVar set) and a background agentic run
    # (ContextVar may be unset) — tenant scope is enforced by the WHERE here.
    rows = (await db.execute(
        select(
            GlBalanceSnapshot.qbo_account_id,
            GlBalanceSnapshot.account_number,
            GlBalanceSnapshot.account_name,
            GlBalanceSnapshot.account_type,
        ).where(
            GlBalanceSnapshot.tenant_id == tenant_id,
            GlBalanceSnapshot.period_end == period_end,
        ),
        execution_options={"skip_tenant_filter": True},
    )).all()
    seen: set[str] = set()
    out: list[dict] = []
    for qid, num, name, atype in rows:
        if qid in seen:
            continue
        seen.add(qid)
        out.append({
            "qbo_account_id": qid,
            "account_number": num,
            "account_name": name,
            "account_type": atype,
        })
    return out


def _find_account(accounts: list[dict], *, types: tuple, keywords: tuple) -> dict | None:
    for a in accounts:
        atype = (a.get("account_type") or "").lower()
        name = (a.get("account_name") or "").lower()
        if any(t in atype for t in types) and any(k in name for k in keywords):
            return a
    return None


# ── Idempotent persistence ────────────────────────────────────────────────


async def replace_open_proposals(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    source: str,
    source_ref: str,
    period_end: date,
    entries: list[dict],
    created_by: uuid.UUID | None = None,
) -> int:
    """Replace the OPEN proposals for one origin with a fresh set.

    Deletes existing ``open`` rows for ``(tenant, source, source_ref,
    period_end)`` then inserts the new balanced ones. Accepted / posted /
    dismissed rows are left untouched — the human's decisions persist across
    regeneration. Unbalanced drafts are skipped. The caller commits.

    Returns the number of proposals inserted.
    """
    if source not in VALID_SOURCES:
        raise ValueError(f"invalid proposed-entry source: {source!r}")

    # Tenant scope is explicit in the WHERE (the auto-filter only rewrites
    # SELECTs, not DELETEs).
    await db.execute(
        delete(ProposedEntry).where(
            ProposedEntry.tenant_id == tenant_id,
            ProposedEntry.source == source,
            ProposedEntry.source_ref == str(source_ref),
            ProposedEntry.period_end == period_end,
            ProposedEntry.status == "open",
        )
    )

    inserted = 0
    for e in entries or []:
        lines = normalize_lines(e.get("lines"))
        if not lines_balanced(lines):
            continue
        confidence = e.get("confidence")
        db.add(ProposedEntry(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            source=source,
            source_ref=str(source_ref),
            period_end=period_end,
            description=(str(e.get("description") or "").strip()[:500] or "Proposed adjusting entry"),
            lines=lines,
            memo=(str(e["memo"]).strip()[:500] if e.get("memo") else None),
            rationale=(str(e["rationale"]).strip() if e.get("rationale") else None),
            confidence=confidence if confidence in VALID_CONFIDENCE else "medium",
            status="open",
            created_by=created_by,
        ))
        inserted += 1
    return inserted


# ── Bank: deterministic generation ────────────────────────────────────────


def _pick_bank_offset(
    *, is_deposit: bool, accounts: list[dict], preferred: dict | None,
) -> dict | None:
    """Choose the offset account for a bank-only item. Prefer the firm's
    CONFIRMED offset (Client Memory) when its account TYPE matches the
    direction — an income account for a deposit, an expense account for a
    withdrawal — so a learned fee account is never put on a deposit (or
    vice versa). Falls back to the keyword heuristic otherwise."""
    if preferred:
        ptype = (preferred.get("account_type") or "").lower()
        if is_deposit and any(t in ptype for t in ("income", "revenue")):
            return preferred
        if (not is_deposit) and ("expense" in ptype):
            return preferred
    if is_deposit:
        return _find_account(accounts, types=("income", "revenue"), keywords=_INTEREST_KEYWORDS)
    return _find_account(accounts, types=("expense",), keywords=_FEE_KEYWORDS)


def build_bank_entries(
    *, bank_account: dict | None, bank_only: list[dict], accounts: list[dict],
    preferred_offset: dict | None = None,
) -> list[dict]:
    """Draft one balanced JE per bank-only item.

    A bank-only item is money on the statement but not in the GL. By sign:
      * deposit  (amount > 0): Dr [bank/cash], Cr Interest / Other Income
      * withdrawal (amount < 0): Dr Bank Fees / Service Charges, Cr [bank/cash]
    When the chart already has a matching offset account, we propose the real
    one (with its qbo_account_id); otherwise a free-text label the user edits.
    `preferred_offset` (a confirmed Client Memory convention for this bank
    account) overrides the heuristic when its type fits the direction.
    """
    bank_name = (bank_account or {}).get("account_name") or "Cash / Bank"
    bank_qid = (bank_account or {}).get("qbo_account_id")
    bank_num = (bank_account or {}).get("account_number")

    entries: list[dict] = []
    for b in bank_only or []:
        amt = _q(b.get("amount"))
        if amt == ZERO:
            continue
        is_deposit = amt > ZERO
        mag = abs(amt)
        desc = str(b.get("description") or "").strip()
        ref = str(b.get("bank_ref") or "").strip()
        bank_line = {
            "account_qbo_id": bank_qid,
            "account_number": bank_num,
            "account_name": bank_name,
        }

        if is_deposit:
            offset = _pick_bank_offset(is_deposit=True, accounts=accounts, preferred=preferred_offset)
            offset_name = offset["account_name"] if offset else "Interest / Other Income"
            lines = [
                {**bank_line, "debit": str(mag), "credit": "0.00"},
                {
                    "account_qbo_id": offset["qbo_account_id"] if offset else None,
                    "account_number": offset["account_number"] if offset else None,
                    "account_name": offset_name,
                    "debit": "0.00",
                    "credit": str(mag),
                },
            ]
            kind = "interest / deposit"
            direction = "deposit"
        else:
            offset = _pick_bank_offset(is_deposit=False, accounts=accounts, preferred=preferred_offset)
            offset_name = offset["account_name"] if offset else "Bank Fees / Service Charges"
            lines = [
                {
                    "account_qbo_id": offset["qbo_account_id"] if offset else None,
                    "account_number": offset["account_number"] if offset else None,
                    "account_name": offset_name,
                    "debit": str(mag),
                    "credit": "0.00",
                },
                {**bank_line, "debit": "0.00", "credit": str(mag)},
            ]
            kind = "bank fee / charge"
            direction = "withdrawal"

        label = desc or ref or ("Bank deposit" if is_deposit else "Bank charge")
        memo_bits = [x for x in (desc, f"Ref {ref}" if ref else "") if x]
        entries.append({
            "description": f"{label} — record {kind}",
            "lines": lines,
            "memo": " · ".join(memo_bits) or None,
            "rationale": (
                f"This {direction} of {mag} is on the bank statement but not in the GL — "
                f"it looks like {kind}. Post this entry in QuickBooks to record it, then re-sync."
            ),
            # Direction is unambiguous; confidence reflects whether we matched
            # a real offset account or left a placeholder for the user.
            "confidence": "high" if offset else "medium",
        })
    return entries


async def generate_bank_proposals(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    qbo_account_id: str,
    period_end: date,
    bank_only: list[dict],
) -> int:
    """Deterministically (re)generate the bank proposed entries for one
    account+period from its bank-only items. Idempotent; caller commits."""
    accounts = await period_accounts(db, tenant_id, period_end)
    bank_account = next((a for a in accounts if a["qbo_account_id"] == qbo_account_id), None)

    # Client Memory (apply): if the firm has CONFIRMED an offset for this bank
    # account's adjustments, resolve it against the live chart (for its type +
    # ids) and let it override the keyword heuristic. Confirm-first — only
    # active facts are returned; best-effort so it never blocks generation.
    preferred_offset = None
    try:
        from modules.memory.service import active_offset_fact
        fact = await active_offset_fact(db, source="bank", source_ref=qbo_account_id)
        if fact:
            v = fact.value or {}
            tnum = (v.get("to_account_number") or "").strip()
            tqid = (v.get("to_account_qbo_id") or "")
            preferred_offset = next(
                (a for a in accounts if (tqid and a["qbo_account_id"] == tqid)
                 or (tnum and (a.get("account_number") or "") == tnum)),
                None,
            )
    except Exception:
        logger.exception("bank offset memory lookup failed for acct=%s", qbo_account_id)

    entries = build_bank_entries(
        bank_account=bank_account, bank_only=bank_only, accounts=accounts,
        preferred_offset=preferred_offset,
    )
    return await replace_open_proposals(
        db,
        tenant_id=tenant_id,
        source="bank",
        source_ref=qbo_account_id,
        period_end=period_end,
        entries=entries,
    )


# ── Serialization (shared by router + producers that echo a preview) ──────


def serialize(entry: ProposedEntry) -> dict:
    return {
        "id": str(entry.id),
        "source": entry.source,
        "source_ref": entry.source_ref,
        "period_end": entry.period_end.isoformat(),
        "description": entry.description,
        "lines": entry.lines or [],
        "memo": entry.memo,
        "rationale": entry.rationale,
        "confidence": entry.confidence,
        "status": entry.status,
        "status_changed_at": entry.status_changed_at.isoformat() if entry.status_changed_at else None,
        "saved_at": entry.saved_at.isoformat() if entry.saved_at else None,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
    }


# ── QuickBooks Online Accountant — "Import journal entries" CSV ────────────


# QBOA's importer maps columns in a preview step, so exact header strings
# aren't load-bearing — but these match the standard template so the upload is
# one click. One row per JE line; lines of the same entry share a Journal No.
_QBO_JE_HEADERS = [
    "Journal No.", "Journal Date", "Account", "Debits", "Credits", "Description", "Name",
]


def _csv_amount(value) -> str:
    """Blank for zero, else 2dp plain number (no thousands separator)."""
    d = _q(value)
    return "" if d == ZERO else f"{d:.2f}"


def _entry_target_lines(entry: ProposedEntry) -> list[tuple[str | None, str, Decimal]]:
    """(account_qbo_id, 'Debit'|'Credit', amount) for each line of a proposed
    entry — the signature we look for in a real QBO journal entry."""
    out: list[tuple[str | None, str, Decimal]] = []
    for ln in (entry.lines or []):
        debit = _q(ln.get("debit"))
        credit = _q(ln.get("credit"))
        qid = ln.get("account_qbo_id")
        qid = str(qid) if qid else None
        if debit > ZERO:
            out.append((qid, "Debit", debit))
        elif credit > ZERO:
            out.append((qid, "Credit", credit))
    return out


def match_entry_to_qbo(entry: ProposedEntry, qbo_jes: list[dict]) -> str | None:
    """Best-effort: return the QBO doc number of a journal entry that contains
    ALL of this proposed entry's lines (same account + posting type + amount,
    each consumed once), else None. Lines with no account_qbo_id (placeholders)
    match on posting type + amount only. Used by the posting check to confirm
    the user booked the adjustment in QuickBooks."""
    targets = _entry_target_lines(entry)
    if not targets:
        return None
    for je in qbo_jes:
        avail = list(je.get("lines") or [])
        matched_all = True
        for (acct, ptype, amt) in targets:
            hit = None
            for i, jl in enumerate(avail):
                if jl.get("posting_type") != ptype:
                    continue
                if abs(_q(jl.get("amount")) - amt) > BALANCE_TOLERANCE:
                    continue
                if acct and str(jl.get("account_id")) != acct:
                    continue
                hit = i
                break
            if hit is None:
                matched_all = False
                break
            avail.pop(hit)  # each QBO line satisfies at most one target line
        if matched_all:
            return je.get("doc") or je.get("id") or "matched"
    return None


def build_qbo_je_csv(entries: list[ProposedEntry]) -> str:
    """Render saved adjusting entries as a QuickBooks Online Accountant
    'Import journal entries' CSV. Each JE line is a row; the lines of one entry
    share a Journal No (``ADJ-n``) so QBO groups them into a single journal
    entry. Journal Date is the period end (MM/DD/YYYY). Only the entries passed
    in are included — the caller filters to the saved/approved set."""
    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(_QBO_JE_HEADERS)
    for i, e in enumerate(entries, start=1):
        journal_no = f"ADJ-{i}"
        jdate = e.period_end.strftime("%m/%d/%Y")
        description = (e.memo or e.description or "").strip()[:1000]
        for ln in (e.lines or []):
            account = str(ln.get("account_name") or "").strip()
            if not account:
                continue
            writer.writerow([
                journal_no,
                jdate,
                account,
                _csv_amount(ln.get("debit")),
                _csv_amount(ln.get("credit")),
                description,
                "",  # Name (entity) — left blank; the user can add in QBO
            ])
    return buf.getvalue()
