"""
Client Memory — learning service.

  capture  — record_signal() writes a ClientMemorySignal (one observation).
  distill  — distill_offset_swap() promotes a repeated offset correction into a
             `suggested` ClientMemoryFact. Confirm-first: a fact is NEVER
             applied to AI output until a reviewer confirms it (status active).
  apply    — active_offset_fact() returns the confirmed offset convention for
             an account, for the recon AI prompt to honour.

All writes set tenant_id explicitly (TenantBase auto-filters SELECT only, not
INSERT/UPDATE). Everything here is best-effort — a failure must never block the
close action that triggered it, so callers wrap these in try/except.
"""
import logging
import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.client_memory import ClientMemoryFact, ClientMemorySignal

logger = logging.getLogger(__name__)

# How many times the same correction must be seen before we suggest a fact.
SUGGEST_THRESHOLD = 2

VALID_FACT_STATUSES = {"suggested", "active", "dismissed", "stale"}


def _acct_identity(line: dict[str, Any] | None) -> str | None:
    """Stable identity for a JE line's account. Precedence: QBO account id →
    account number → name. The QBO id is the only identifier stable across a
    placeholder offset (number-less) and the same account picked from the chart
    (numbered), so leading with it keeps the distiller from under-counting a
    genuinely repeated correction. The SAME precedence is used to detect which
    account changed AND to group repeats, so it must stay consistent."""
    if not line:
        return None
    qid = str(line.get("account_qbo_id") or line.get("qbo_account_id") or "").strip()
    if qid:
        return f"id:{qid}"
    n = (line.get("account_number") or "").strip()
    if n:
        return f"#{n}"
    nm = (line.get("account_name") or "").strip().lower()
    return f"@{nm}" if nm else None


def _acct_brief(line: dict[str, Any]) -> dict[str, Any]:
    """The fields we keep about an account on a signal/fact."""
    return {
        "account_number": (line.get("account_number") or "").strip() or None,
        "account_name": (line.get("account_name") or "").strip() or None,
        "account_qbo_id": line.get("account_qbo_id") or line.get("qbo_account_id") or None,
    }


def detect_offset_swap(
    before: list[dict] | None, after: list[dict] | None
) -> dict[str, Any] | None:
    """If exactly one account was replaced between two versions of a balanced
    JE (one account removed, one added), return {"from": <brief>, "to": <brief>}.
    That's the offset-account correction we learn from. Returns None for
    anything fuzzier (multiple account changes, amount-only edits)."""
    b_ids = [_acct_identity(line) for line in (before or []) if _acct_identity(line)]
    a_ids = [_acct_identity(line) for line in (after or []) if _acct_identity(line)]
    # A repeated account on either side (e.g. a multi-line JE that splits the
    # same account) isn't the clean "swap one offset for another" shape — too
    # fuzzy to learn from. Bail rather than collapse it into a false swap.
    if len(b_ids) != len(set(b_ids)) or len(a_ids) != len(set(a_ids)):
        return None
    b = {_acct_identity(line): line for line in (before or []) if _acct_identity(line)}
    a = {_acct_identity(line): line for line in (after or []) if _acct_identity(line)}
    removed = [b[k] for k in b if k not in a]
    added = [a[k] for k in a if k not in b]
    if len(removed) == 1 and len(added) == 1:
        return {"from": _acct_brief(removed[0]), "to": _acct_brief(added[0])}
    return None


async def record_signal(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    signal_type: str,
    source: str,
    source_ref: str,
    period_end: date,
    account_key: str | None,
    proposed_entry_id: uuid.UUID | None,
    before: dict | None,
    after: dict | None,
    created_by: uuid.UUID | None,
) -> ClientMemorySignal:
    sig = ClientMemorySignal(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        signal_type=signal_type,
        source=source,
        source_ref=source_ref,
        period_end=period_end,
        account_key=account_key,
        proposed_entry_id=proposed_entry_id,
        before=before,
        after=after,
        created_by=created_by,
    )
    db.add(sig)
    await db.flush()
    return sig


async def distill_offset_swap(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    source: str,
    source_ref: str,
    swap: dict[str, Any],
) -> ClientMemoryFact | None:
    """After an offset swap, count how many times THIS account's adjustments
    have been re-pointed to THIS same target. At/above the threshold, upsert a
    `suggested` fact (confirm-first — never `active`). Never overrides an
    existing `active`/`dismissed` fact (the human's standing decision)."""
    to_line = swap.get("to") or {}
    target_ident = _acct_identity(to_line)
    if not target_ident:
        return None

    fact_key = f"{source}:offset:{source_ref}"

    # All recorded offset swaps for this account (tenant auto-filtered).
    sigs = (await db.execute(
        select(ClientMemorySignal).where(
            ClientMemorySignal.signal_type == "account_swap",
            ClientMemorySignal.source == source,
            ClientMemorySignal.account_key == source_ref,
        )
    )).scalars().all()
    matching = [s for s in sigs if _acct_identity(s.after) == target_ident]
    # Count DISTINCT proposed entries, not raw signals — re-editing the same
    # open entry (or UI churn) must never alone trip the threshold; a real
    # convention has to recur across different adjusting entries.
    entry_ids = {s.proposed_entry_id for s in matching if s.proposed_entry_id}
    seen = len(entry_ids) if entry_ids else len(matching)
    if seen < SUGGEST_THRESHOLD:
        return None

    num = to_line.get("account_number")
    name = to_line.get("account_name") or ""
    label = f"{num} · {name}".strip(" ·") if num else name
    title = f"Book the offset to {label} for this account's adjustments"
    value = {
        "to_account_number": num,
        "to_account_name": name or None,
        "to_account_qbo_id": to_line.get("account_qbo_id"),
        "from_account_number": (swap.get("from") or {}).get("account_number"),
        "from_account_name": (swap.get("from") or {}).get("account_name"),
        "account_ref": source_ref,
        "source": source,
    }
    provenance = {"seen": seen, "signal_ids": [str(s.id) for s in matching][:20]}
    now = datetime.now(UTC)

    existing = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
    )).scalar_one_or_none()

    if existing is None:
        fact = ClientMemoryFact(
            id=uuid.uuid4(), tenant_id=tenant_id, kind="offset_account",
            fact_key=fact_key, title=title, value=value, confidence=seen,
            status="suggested", provenance=provenance, last_seen_at=now,
        )
        db.add(fact)
        await db.flush()
        return fact

    if existing.status in ("suggested", "stale"):
        existing.title = title
        existing.value = value
        existing.confidence = seen
        existing.provenance = provenance
        existing.status = "suggested"
        existing.last_seen_at = now
    elif existing.status == "active":
        # Already confirmed — just reinforce (keeps it from going stale).
        existing.confidence = seen
        existing.last_seen_at = now
    elif existing.status == "dismissed":
        # The reviewer rejected a PRIOR offset for this account. If the firm is
        # now consistently using a DIFFERENT offset, that's a genuinely new
        # convention worth surfacing — re-suggest with the new target. If it's
        # the same target they already said no to, leave it dismissed (never
        # resurrect against the human's decision).
        prev_ident = _acct_identity({
            "account_qbo_id": (existing.value or {}).get("to_account_qbo_id"),
            "account_number": (existing.value or {}).get("to_account_number"),
            "account_name": (existing.value or {}).get("to_account_name"),
        })
        if prev_ident != target_ident:
            existing.title = title
            existing.value = value
            existing.confidence = seen
            existing.provenance = provenance
            existing.status = "suggested"
            existing.last_seen_at = now
    await db.flush()
    return existing


async def active_offset_fact(
    db: AsyncSession, *, source: str, source_ref: str
) -> ClientMemoryFact | None:
    """The confirmed offset convention for an account, if any. Used by the
    recon AI prompt (apply step). Only `active` facts are ever applied."""
    fact_key = f"{source}:offset:{source_ref}"
    return (await db.execute(
        select(ClientMemoryFact).where(
            ClientMemoryFact.fact_key == fact_key,
            ClientMemoryFact.status == "active",
        )
    )).scalar_one_or_none()


# ── Vendor schedule defaults (Slice 2) ────────────────────────────────────────
#
# Learn how a firm sets up a given vendor's prepaid (amortization method, term,
# and the expense account it amortizes into) from the EXPLICIT choices made on
# schedule creation — a deterministic signal, no inference. Same confirm-first
# lifecycle: a suggestion does nothing until a reviewer confirms it.


def _vendor_key(vendor: str | None) -> str | None:
    """Stable grouping key for a vendor name: lowercased, whitespace-collapsed,
    truncated to the source_ref column width. None for blank vendors."""
    if not vendor:
        return None
    key = " ".join(str(vendor).strip().lower().split())
    return key[:100] or None


def _schedule_signature(d: dict[str, Any] | None) -> str:
    """The repeatable 'how this party is set up' fingerprint, per schedule type.
    Two creates that share it are the same convention. Derived deterministically
    from the captured fields (so it works on historical signals too), keyed on
    schedule_type so different types never collide."""
    d = d or {}
    st = (d.get("schedule_type") or "").strip()
    offset = str(d.get("offset_qbo_account_id") or "").strip()
    bs = str(d.get("qbo_account_id") or "").strip()
    if st == "prepaid":
        return f"prepaid|{(d.get('amortization_method') or '').strip()}|{d.get('term_months')}|{offset}|{bs}"
    if st == "accrual":
        return f"accrual|{offset}|{bs}"
    if st == "fixed_asset":
        return (
            f"fixed_asset|{(d.get('category') or '').strip().lower()}|{d.get('useful_life_months')}|"
            f"{(d.get('depreciation_method') or '').strip()}|"
            f"{str(d.get('accumulated_dep_qbo_account_id') or '').strip()}|{offset}|{bs}"
        )
    if st == "lease":
        return (
            f"lease|{d.get('term_months')}|{str(d.get('discount_rate_pct') or '').strip()}|"
            f"{str(d.get('rou_qbo_account_id') or '').strip()}|{offset}|{bs}"
        )
    if st == "loan":
        return (
            f"loan|{d.get('term_months')}|{str(d.get('interest_rate_pct') or '').strip()}|"
            f"{(d.get('payment_type') or '').strip()}|{offset}|{bs}"
        )
    return st


def _schedule_title(schedule_type: str, party: str, d: dict[str, Any]) -> str:
    """Human-readable convention label, per schedule type."""
    offset_name = d.get("offset_account_name")
    if schedule_type == "prepaid":
        term = d.get("term_months")
        method = d.get("amortization_method") or ""
        method_label = {"straight_line": "straight-line", "daily_rate": "daily-rate"}.get(method, method)
        parts = [p for p in (f"{term}-month" if term else "", method_label, "prepaid") if p]
        title = f'Vendor "{party}" → ' + " ".join(parts)
        if offset_name:
            title += f", amortizing into {offset_name}"
    elif schedule_type == "accrual":
        title = f'Vendor "{party}" → accrual'
        if offset_name:
            title += f", booking to {offset_name}"
    elif schedule_type == "fixed_asset":
        cat = d.get("category")
        life = d.get("useful_life_months")
        meth = (d.get("depreciation_method") or "").replace("_", " ")
        bits = [b for b in (cat, f"{life}-mo" if life else "", meth) if b]
        title = f'Vendor "{party}" → {(" · ".join(bits)) or "fixed asset"} depreciation'
        if offset_name:
            title += f", into {offset_name}"
    elif schedule_type == "lease":
        term = d.get("term_months")
        title = f'Lessor "{party}" → {term}-month lease' if term else f'Lessor "{party}" → lease'
    elif schedule_type == "loan":
        term = d.get("term_months")
        rate = d.get("interest_rate_pct")
        pt = d.get("payment_type") or ""
        bits = [b for b in (f"{term}-month" if term else "", f"{rate}%" if rate else "", pt) if b]
        title = f'Lender "{party}" → ' + (" ".join(bits)) + " loan"
    else:
        title = f'"{party}" → learned setup'
    return title[:400]


async def record_schedule_default(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    schedule_type: str,
    vendor: str | None,
    defaults: dict[str, Any],
    item_id: uuid.UUID | None,
    when: date,
    created_by: uuid.UUID | None,
) -> ClientMemorySignal | None:
    vk = _vendor_key(vendor)
    if not vk:
        return None
    sig = ClientMemorySignal(
        id=uuid.uuid4(), tenant_id=tenant_id,
        signal_type="schedule_default", source=schedule_type[:10],
        source_ref=vk, period_end=when, account_key=vk,
        proposed_entry_id=item_id, before=None, after=defaults,
        created_by=created_by,
    )
    db.add(sig)
    await db.flush()
    return sig


async def distill_schedule_default(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    schedule_type: str,
    vendor: str | None,
    defaults: dict[str, Any],
) -> ClientMemoryFact | None:
    """Promote a repeated vendor setup into a `suggested` fact. Counts DISTINCT
    schedule items (an item can't double-count itself); never silently changes
    a CONFIRMED default whose setup differs (confirm-first), and re-suggests a
    dismissed vendor only when the setup actually changed."""
    vk = _vendor_key(vendor)
    if not vk:
        return None
    vendor_disp = " ".join(str(vendor).strip().split())[:255]
    sig_str = _schedule_signature(defaults)
    # Single normalized token for BOTH the signal `source` (String(10) column)
    # and the fact_key, so they can never diverge for a longer schedule_type.
    stype = schedule_type[:10]

    rows = (await db.execute(
        select(ClientMemorySignal).where(
            ClientMemorySignal.signal_type == "schedule_default",
            ClientMemorySignal.source == stype,
            ClientMemorySignal.account_key == vk,
        )
    )).scalars().all()
    matching = [s for s in rows if _schedule_signature(s.after) == sig_str]
    item_ids = {s.proposed_entry_id for s in matching if s.proposed_entry_id}
    seen = len(item_ids) if item_ids else len(matching)
    if seen < SUGGEST_THRESHOLD:
        return None

    fact_key = f"{stype}:vendor:{vk}"
    # Carry every field a dialog might pre-fill, keyed by schedule type. The
    # shared keys are always present; the type-specific ones only for the
    # relevant type (so the frontend chip/onApply have what they need).
    value = {
        "vendor": vendor_disp,
        "schedule_type": schedule_type,
        "term_months": defaults.get("term_months"),
        "offset_qbo_account_id": defaults.get("offset_qbo_account_id"),
        "offset_account_name": defaults.get("offset_account_name"),
        "qbo_account_id": defaults.get("qbo_account_id"),
    }
    if schedule_type == "prepaid":
        value["amortization_method"] = defaults.get("amortization_method")
    elif schedule_type == "fixed_asset":
        value["category"] = defaults.get("category")
        value["useful_life_months"] = defaults.get("useful_life_months")
        value["depreciation_method"] = defaults.get("depreciation_method")
        value["accumulated_dep_qbo_account_id"] = defaults.get("accumulated_dep_qbo_account_id")
    elif schedule_type == "lease":
        value["discount_rate_pct"] = defaults.get("discount_rate_pct")
        value["rou_qbo_account_id"] = defaults.get("rou_qbo_account_id")
    elif schedule_type == "loan":
        value["interest_rate_pct"] = defaults.get("interest_rate_pct")
        value["payment_type"] = defaults.get("payment_type")
    title = _schedule_title(schedule_type, vendor_disp, value)
    provenance = {"seen": seen, "signal_ids": [str(s.id) for s in matching][:20]}
    now = datetime.now(UTC)

    existing = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
    )).scalar_one_or_none()
    if existing is None:
        fact = ClientMemoryFact(
            id=uuid.uuid4(), tenant_id=tenant_id, kind="vendor_schedule",
            fact_key=fact_key, title=title, value=value, confidence=seen,
            status="suggested", provenance=provenance, last_seen_at=now,
        )
        db.add(fact)
        await db.flush()
        return fact
    if existing.status in ("suggested", "stale"):
        existing.title = title
        existing.value = value
        existing.confidence = seen
        existing.provenance = provenance
        existing.status = "suggested"
        existing.last_seen_at = now
    elif existing.status == "active":
        # Reinforce only when the confirmed setup is unchanged — never silently
        # overwrite a reviewer-confirmed default with a different setup.
        if _schedule_signature(existing.value) == sig_str:
            existing.value = value
            existing.confidence = seen
            existing.last_seen_at = now
    elif existing.status == "dismissed":
        # Re-suggest only if the firm has switched to a genuinely different
        # setup than the one the reviewer rejected.
        if _schedule_signature(existing.value) != sig_str:
            existing.title = title
            existing.value = value
            existing.confidence = seen
            existing.provenance = provenance
            existing.status = "suggested"
            existing.last_seen_at = now
    await db.flush()
    return existing


async def active_schedule_default(
    db: AsyncSession, *, schedule_type: str, vendor: str | None
) -> ClientMemoryFact | None:
    """The confirmed vendor setup for pre-filling a new schedule item, if any.
    Only `active` facts apply (confirm-first)."""
    vk = _vendor_key(vendor)
    if not vk:
        return None
    fact_key = f"{schedule_type[:10]}:vendor:{vk}"
    return (await db.execute(
        select(ClientMemoryFact).where(
            ClientMemoryFact.fact_key == fact_key,
            ClientMemoryFact.status == "active",
        )
    )).scalar_one_or_none()


def serialize_fact(f: ClientMemoryFact) -> dict[str, Any]:
    return {
        "id": str(f.id),
        "kind": f.kind,
        "fact_key": f.fact_key,
        "title": f.title,
        "value": f.value or {},
        "confidence": f.confidence,
        "status": f.status,
        "provenance": f.provenance or {},
        "confirmed_at": f.confirmed_at.isoformat() if f.confirmed_at else None,
        "last_seen_at": f.last_seen_at.isoformat() if f.last_seen_at else None,
        "created_at": f.created_at.isoformat() if f.created_at else None,
    }
