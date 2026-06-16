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
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models.client_memory import ClientMemoryFact, ClientMemorySignal

logger = logging.getLogger(__name__)

# How many times the same correction must be seen before we suggest a fact.
SUGGEST_THRESHOLD = 2

VALID_FACT_STATUSES = {"suggested", "active", "dismissed", "stale"}


async def _insert_fact_or_lose_race(db: AsyncSession, fact: ClientMemoryFact) -> bool:
    """Insert a brand-new fact inside a SAVEPOINT. Returns True on success, or
    False if a concurrent request already inserted the same (tenant_id, fact_key):
    the unique constraint turns that race into an IntegrityError, which we scope
    to the savepoint so the rest of the transaction (e.g. the signal row written
    earlier in the same request) survives. On False the caller re-selects the
    winning row and merges into it instead of double-inserting.

    A SELECT-then-INSERT is otherwise not atomic — two simultaneous first-time
    captures for the same account would both see no row and both INSERT, 500-ing
    the loser and losing its capture. Mirrors the close_workflow precedent."""
    try:
        async with db.begin_nested():
            db.add(fact)
            await db.flush()
        return True
    except IntegrityError:
        return False


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
        if await _insert_fact_or_lose_race(db, fact):
            return fact
        # Lost the insert race to a concurrent request — re-select the winner and
        # fall through to merge into it.
        existing = (await db.execute(
            select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
        )).scalar_one_or_none()
        if existing is None:
            raise RuntimeError("offset fact vanished after unique conflict")

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
        if await _insert_fact_or_lose_race(db, fact):
            return fact
        # Lost the insert race to a concurrent request — re-select and merge.
        existing = (await db.execute(
            select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
        )).scalar_one_or_none()
        if existing is None:
            raise RuntimeError("vendor-schedule fact vanished after unique conflict")
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


# ── Variance expectations (Slice 2 — captured judgment on flux) ────────────────
#
# When an accountant explains a flux variance and marks it as RECURRING, we
# capture that judgment as a confirm-first fact. Once a reviewer confirms it,
# the next period's flux uses the human's expectation in place of the
# statistical run-rate — and pre-explains the variance ONLY when the actual
# lands within the rule's tolerance. Outside tolerance the rule never hides the
# movement; it flags it as deviating. Same two-gate safety as every memory fact.

_EXPECTATION_PREFIX = "flux:expectation:"


def _usd(v: Any) -> str:
    try:
        n = Decimal(str(v))
    except (TypeError, InvalidOperation, ValueError):
        return "—"
    body = f"${abs(n):,.0f}"
    return f"({body})" if n < 0 else body


def _recurrence_phrase(recurrence: str | None, month: int | None) -> str:
    """Shared human phrase for an expectation's cadence — used by the title and the
    'What Nordavix knows' note so both read consistently across the four cadences
    (monthly / quarterly / annual / one-off)."""
    import calendar
    if recurrence == "monthly":
        return "every month"
    if recurrence == "quarterly":
        return "every quarter"
    if recurrence == "one_off":
        return "this period"
    # annual (and legacy/unknown) — name the calendar month when we have it.
    try:
        m = int(month)  # type: ignore[arg-type]
        if 1 <= m <= 12:
            return f"each {calendar.month_name[m]}"
    except (TypeError, ValueError):
        pass
    return "each year"


def _tolerance_phrase(v: dict[str, Any]) -> str:
    """Short band label ('15%' or '$500') for display; '' if unparseable. Mirrors
    the band evaluate_expectation actually applies (percent default, abs opt-in)."""
    mode = str(v.get("tolerance_mode") or "pct").lower()
    try:
        if mode == "abs":
            return f"${abs(float(v.get('tolerance_abs'))):,.0f}"
        return f"{float(v.get('tolerance_pct', 15)):g}%"
    except (TypeError, ValueError):
        return ""


def expectation_title(account_name: str, recurrence: str, month: int | None,
                      expected_balance: Any, explanation: str | None) -> str:
    """Human-readable label for a captured expectation, shown in the Memory UI."""
    when = _recurrence_phrase(recurrence, month)
    base = f"{(account_name or 'This account')}: expect ~{_usd(expected_balance)} {when}"
    reason = (explanation or "").strip().splitlines()[0] if explanation else ""
    if reason:
        base += f" — {reason[:80]}"
    return base[:400]


def build_expectation_value(
    *,
    account_number: str | None,
    account_name: str | None,
    qbo_account_id: str | None,
    default_balance: Any,
    period_current: date,
    recurrence: str,
    explanation: str,
    expected_amount: Any = None,
    tolerance_mode: str | None = None,
    tolerance_pct: Any = None,
    tolerance_abs: Any = None,
    scope: str = "account",
) -> dict[str, Any]:
    """Build the JSONB `value` for a variance_expectation fact from a capture
    request. Shared by the flux + recon capture endpoints so both store the
    identical shape with identical clamping. Validates/clamps user input here; the
    apply-side gate (evaluate_expectation) re-validates defensively regardless.

      • expected_balance: the user's override, else the account's current balance
      • month: anchor month for annual + quarterly cadences (None otherwise)
      • tolerance: percent (default, clamped 1..200) or absolute ±$ (>= 0)
    """
    expected = default_balance
    if expected_amount not in (None, ""):
        try:
            expected = Decimal(str(expected_amount))
        except (TypeError, InvalidOperation, ValueError):
            expected = default_balance
    month = period_current.month if recurrence in ("annual", "quarterly") else None
    mode = "abs" if str(tolerance_mode or "").lower() == "abs" else "pct"
    tol_pct, tol_abs = 15.0, 0.0
    if mode == "abs":
        try:
            tol_abs = max(0.0, float(tolerance_abs)) if tolerance_abs not in (None, "") else 0.0
        except (TypeError, ValueError):
            tol_abs = 0.0
    else:
        try:
            tol_pct = max(1.0, min(200.0, float(tolerance_pct))) if tolerance_pct not in (None, "") else 15.0
        except (TypeError, ValueError):
            tol_pct = 15.0
    return {
        "account_number": account_number,
        "account_name": account_name,
        "qbo_account_id": qbo_account_id,
        "recurrence": recurrence,
        "month": month,
        "expected_balance": str(expected),
        "tolerance_mode": mode,
        "tolerance_pct": tol_pct,
        "tolerance_abs": tol_abs,
        "explanation": (explanation or "")[:2000],
        "captured_period": period_current.isoformat(),
        "scope": scope,
    }


def _expectation_fires(value: dict[str, Any] | None, period_end: date) -> bool:
    """Whether a confirmed expectation rule applies THIS period, by recurrence:
    monthly fires every period; annual fires only in its stored month. This is
    the single source of truth shared by the flux apply path (evaluate_expectation)
    and the close prefill rollup (close_prefill), so the rail can never claim a
    rule fires when flux wouldn't actually apply it."""
    if not value:
        return False
    recurrence = value.get("recurrence")
    if recurrence == "monthly":
        return True
    if recurrence == "quarterly":
        # Fires on the captured month and every third month thereafter
        # (e.g. captured in March → Jun/Sep/Dec also fire).
        month = value.get("month")
        try:
            return bool(month) and (period_end.month - int(month)) % 3 == 0
        except (TypeError, ValueError):
            return False
    if recurrence == "annual":
        month = value.get("month")
        try:
            return bool(month) and period_end.month == int(month)
        except (TypeError, ValueError):
            return False
    if recurrence == "one_off":
        # A documented one-time expectation: applies only to the period it was
        # captured for, and never recurs.
        cap = str(value.get("captured_period") or "")
        return bool(cap) and period_end.isoformat() == cap
    return False


def evaluate_expectation(
    value: dict[str, Any] | None,
    period_end: date,
    actual_balance: Decimal,
) -> dict[str, Any] | None:
    """PURE. Given a confirmed expectation fact's value, decide how it applies to
    one account this period. Returns None when the rule does NOT fire this period
    (wrong recurrence month, or malformed) — caller then falls back to run-rate.

    When it fires, returns {expected_value, basis, pre_explained}:
      • pre_explained is True ONLY when the actual is within the rule's tolerance
        band of the expectation. Outside the band the rule still surfaces the
        expectation (so the human sees what was expected) but pre_explained is
        False and the basis says it DEVIATES — a learned rule never silences a
        genuinely anomalous movement.
    This function is deterministic + side-effect-free so it can be unit-tested.
    """
    if not value:
        return None
    if not _expectation_fires(value, period_end):
        return None

    try:
        expected = Decimal(str(value.get("expected_balance")))
    except (TypeError, InvalidOperation, ValueError):
        return None
    # "NaN"/"Infinity" parse cleanly into Decimal but would poison the tolerance
    # math and the <= comparison below. A non-finite expectation is malformed —
    # don't fire; fall back to the run-rate baseline.
    if not expected.is_finite():
        return None

    # Two tolerance modes: a percent band (default) or an absolute ±$ band the
    # user can opt into. Either way the result is a finite, non-negative `tol_abs`
    # the comparison below uses. The pure gate cannot trust the JSONB it is handed:
    # a non-finite/negative band ("Infinity"/"NaN"/-1) is garbage and collapses to
    # an exact-match band (0), NEVER an anomaly-hiding infinite one.
    mode = str(value.get("tolerance_mode") or "pct").lower()
    if mode == "abs":
        try:
            tol_abs = Decimal(str(value.get("tolerance_abs", 0)))
        except (TypeError, InvalidOperation, ValueError):
            tol_abs = Decimal(0)
        if not tol_abs.is_finite() or tol_abs < 0:
            tol_abs = Decimal(0)
    else:
        try:
            tol_pct = Decimal(str(value.get("tolerance_pct", 15)))
        except (TypeError, InvalidOperation, ValueError):
            tol_pct = Decimal(15)
        # Infinity would make every variance "within tolerance" (silently pre-
        # explaining a genuine anomaly); NaN would raise on the `< 0` compare and
        # crash the run. Fall back to the safe default.
        if not tol_pct.is_finite():
            tol_pct = Decimal(15)
        if tol_pct < 0:
            tol_pct = Decimal(0)
        # Never honor a band wider than the product's capture cap (router clamps to
        # 1..200). Keeps a drifted/edited fact from granting an impossibly wide,
        # anomaly-hiding tolerance the human never could have confirmed.
        if tol_pct > 200:
            tol_pct = Decimal(200)
        tol_abs = (abs(expected) * tol_pct / Decimal(100))

    reason = str(value.get("explanation") or "").strip()
    short = (reason[:140] + "…") if len(reason) > 140 else reason
    within = abs(actual_balance - expected) <= tol_abs
    if within:
        basis = f"Confirmed rule: {short}" if short else "Confirmed recurring expectation"
    else:
        basis = f"Deviates from confirmed expectation (~{_usd(expected)})"
        if short:
            basis += f": {short}"
    return {"expected_value": expected, "basis": basis[:200], "pre_explained": within}


async def record_expectation_signal(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    account_key: str,
    period_end: date,
    value: dict[str, Any],
    variance_id: uuid.UUID | None,
    created_by: uuid.UUID | None,
    source: str = "flux",
) -> ClientMemorySignal:
    """One capture observation for a recurring variance expectation. `source` is
    where the human taught it ('flux' or 'recon') — both teach the SAME per-account
    fact (keyed by account, not source), so an expectation learned on either
    surface compounds and applies to both."""
    sig = ClientMemorySignal(
        id=uuid.uuid4(), tenant_id=tenant_id,
        signal_type="variance_expectation", source=source,
        source_ref=account_key[:100], period_end=period_end,
        account_key=account_key[:160], proposed_entry_id=variance_id,
        before=None, after=value, created_by=created_by,
    )
    db.add(sig)
    await db.flush()
    return sig


async def upsert_expectation_fact(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    account_key: str,
    value: dict[str, Any],
    title: str,
) -> ClientMemoryFact:
    """Upsert the confirm-first expectation fact for an account. A deliberate
    human capture, so threshold is 1 — but it is created `suggested` and never
    applied until a reviewer confirms it. A CONFIRMED (active) fact is only
    reinforced, never silently overwritten with a new expectation."""
    fact_key = f"{_EXPECTATION_PREFIX}{account_key}"[:200]
    # Count signals across ALL sources (flux + recon) for this account — teaching
    # on either surface reinforces the one per-account expectation fact.
    sigs = (await db.execute(
        select(ClientMemorySignal).where(
            ClientMemorySignal.signal_type == "variance_expectation",
            ClientMemorySignal.account_key == account_key[:160],
        )
    )).scalars().all()
    # Distinct capture periods — re-saving within the same period shouldn't
    # inflate the "seen" count.
    seen = len({s.period_end for s in sigs}) or 1
    provenance = {"seen": seen, "signal_ids": [str(s.id) for s in sigs][:20]}
    now = datetime.now(UTC)

    existing = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
    )).scalar_one_or_none()
    if existing is None:
        fact = ClientMemoryFact(
            id=uuid.uuid4(), tenant_id=tenant_id, kind="variance_expectation",
            fact_key=fact_key, title=title[:400], value=value, confidence=seen,
            status="suggested", provenance=provenance, last_seen_at=now,
        )
        if await _insert_fact_or_lose_race(db, fact):
            return fact
        # Lost the insert race to a concurrent capture — re-select the winning
        # row and fall through to reinforce/re-surface it (never double-insert).
        existing = (await db.execute(
            select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
        )).scalar_one_or_none()
        if existing is None:
            raise RuntimeError("expectation fact vanished after unique conflict")
    if existing.status == "active":
        # Confirmed — reinforce recency/confidence only. Never change the
        # confirmed expectation's value out from under the reviewer.
        existing.confidence = seen
        existing.last_seen_at = now
    else:
        # suggested | stale | dismissed → (re-)surface this deliberate capture.
        existing.title = title[:400]
        existing.value = value
        existing.confidence = seen
        existing.provenance = provenance
        existing.status = "suggested"
        existing.last_seen_at = now
    await db.flush()
    return existing


async def active_expectation_facts_map(db: AsyncSession) -> dict[str, dict[str, Any]]:
    """Map account_key → confirmed expectation value, for all ACTIVE expectation
    facts of the current tenant (SELECT auto-filtered by TenantBase). Used by the
    flux build to apply confirmed expectations. Only `active` facts are returned."""
    facts = (await db.execute(
        select(ClientMemoryFact).where(
            ClientMemoryFact.kind == "variance_expectation",
            ClientMemoryFact.status == "active",
        )
    )).scalars().all()
    out: dict[str, dict[str, Any]] = {}
    for f in facts:
        key = (f.fact_key or "").removeprefix(_EXPECTATION_PREFIX)
        if key:
            out[key] = f.value or {}
    return out


# ── Close prefill rollup (Slice A — make learned conventions visible) ──────────
#
# kind → (module the fact pre-fills, short human "what it does"). Drives the
# "Prefilled by Nordavix" rail on the close workspace. Unknown kinds are skipped
# so the rail never shows a mystery row.
_PREFILL_META: dict[str, tuple[str, str]] = {
    "variance_expectation": ("flux", "Pre-explains this account's variance when it lands within your confirmed tolerance"),
    "offset_account": ("adjustments", "Pre-selects your learned offset account for this account's adjustments"),
    "vendor_schedule": ("schedules", "Pre-fills this vendor's amortization setup on a new schedule"),
    "recon_recurring_item": ("recons", "Suggests this confirmed recurring reconciling item on the recon"),
}


async def close_prefill(db: AsyncSession, period_end: date) -> dict[str, Any]:
    """Read-only rollup for the close workspace: every CONFIRMED (active) memory
    convention that pre-fills part of THIS period's close, plus a count of
    suggestions still awaiting confirmation. Pure aggregation — it surfaces what
    memory already does; it never writes and never applies anything new.

    A variance_expectation is flagged `applies_this_period` only when its
    recurrence fires this month (shared `_expectation_fires`, identical to the
    flux apply path). Standing conventions (offsets, vendor setups) apply whenever
    their data appears, so they're always relevant. SELECTs are tenant-auto-
    filtered by TenantBase — one workspace can never see another's memory."""
    facts = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.status == "active")
    )).scalars().all()
    applying: list[dict[str, Any]] = []
    for f in facts:
        meta = _PREFILL_META.get(f.kind)
        if meta is None:
            continue
        module, what = meta
        fires = _expectation_fires(f.value or {}, period_end) if f.kind == "variance_expectation" else True
        applying.append({
            "fact_id": str(f.id),
            "kind": f.kind,
            "module": module,
            "title": f.title,
            "what_it_does": what,
            "applies_this_period": fires,
            "confidence": f.confidence,
            "last_seen_at": f.last_seen_at.isoformat() if f.last_seen_at else None,
            "confirmed_at": f.confirmed_at.isoformat() if f.confirmed_at else None,
        })
    # Relevant-now first, then most-recently reinforced. Two stable passes.
    applying.sort(key=lambda r: r["last_seen_at"] or "", reverse=True)
    applying.sort(key=lambda r: not r["applies_this_period"])

    # Entity select (not a column-only select) so it matches every other
    # tenant-scoped fact query in this module — leaves zero doubt that the
    # TenantBase auto-filter applies and one workspace can't count another's.
    suggested = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.status == "suggested")
    )).scalars().all()
    return {
        "period_end": period_end.isoformat(),
        "applying": applying,
        "suggested_count": len(suggested),
    }


# ── Account memory context (Slice B — knowledge follows the account) ───────────
#
# Surface every CONFIRMED fact that concerns an account wherever that account
# appears (flux variance, recon detail). STRICTLY ADDITIVE: these notes are
# informational only — they never change a computed number and never pre-explain
# a variance. The amount-aware variance_expectation engine remains the only thing
# that can mark a flux movement pre_explained.


def _offset_target_label(v: dict[str, Any]) -> str:
    num = (v.get("to_account_number") or "").strip()
    name = (v.get("to_account_name") or "").strip()
    return f"{num} · {name}".strip(" ·") if num else name


def _schedule_brief(v: dict[str, Any]) -> str:
    """Short 'how it's set up' phrase, e.g. '12-mo straight-line prepaid'."""
    stype = (v.get("schedule_type") or "schedule").replace("_", " ")
    term = v.get("term_months")
    method = ""
    if v.get("schedule_type") == "prepaid":
        method = {"straight_line": "straight-line", "daily_rate": "daily-rate"}.get(
            (v.get("amortization_method") or "").strip(), ""
        )
    bits = [b for b in (f"{term}-mo" if term else "", method, stype) if b]
    return " ".join(bits) or stype


def _expectation_note(v: dict[str, Any]) -> str:
    when = _recurrence_phrase(v.get("recurrence"), v.get("month"))
    base = f"Expected ~{_usd(v.get('expected_balance'))} {when}"
    band = _tolerance_phrase(v)
    if band:
        base += f" (±{band})"
    expl = str(v.get("explanation") or "").strip()
    reason = expl.splitlines()[0] if expl else ""
    if reason:
        base += f" — {reason[:80]}"
    return base[:200]


def _fact_note_for_account(
    fact: ClientMemoryFact, qbo_id: str | None, acct_num: str | None,
) -> dict[str, Any] | None:
    """PURE. If this confirmed fact concerns the given account, return a read-only
    display note {kind, module, text, fact_id}; else None.

    Matching is by EXACT, NON-EMPTY id/number equality only — an empty id never
    matches an empty id — so a fact can never bleed onto an unrelated account.
    The note is informational: it never changes a number or pre-explains anything.
    """
    v = fact.value or {}
    qid = (qbo_id or "").strip()
    num = (acct_num or "").strip()

    def matches(cand_id: Any, cand_num: Any = None) -> bool:
        """ID-preferred, mirroring _account_key: when both sides carry a canonical
        QBO id, compare ONLY those — so an id that happens to equal some other
        account's number can never cross-match. Fall back to account number only
        when an id isn't available on both sides."""
        cid = str(cand_id or "").strip()
        cnum = str(cand_num or "").strip()
        if qid and cid:
            return qid == cid
        if num and cnum:
            return num == cnum
        return False

    if fact.kind == "variance_expectation":
        if matches(v.get("qbo_account_id"), v.get("account_number")):
            return {"kind": fact.kind, "module": "flux",
                    "text": _expectation_note(v), "fact_id": str(fact.id)}
        return None

    if fact.kind == "offset_account":
        # account_ref is the account the offset applies to — a raw QBO account id
        # (recon/bank/flux capture all store the account's qbo id). Match id-first;
        # only fall back to number when this account has no id, so an id-shaped ref
        # can't collide with another account's number.
        ref = str(v.get("account_ref") or "").strip()
        hit = bool(ref) and ((bool(qid) and ref == qid) or (not qid and bool(num) and ref == num))
        if hit:
            label = _offset_target_label(v)
            if label:
                return {"kind": fact.kind, "module": "adjustments",
                        "text": f"Adjustments here are usually booked to {label}.",
                        "fact_id": str(fact.id)}
        return None

    if fact.kind == "vendor_schedule":
        vendor = (v.get("vendor") or "This vendor").strip() or "This vendor"
        stype = (v.get("schedule_type") or "schedule").replace("_", " ")
        # The balance-sheet account the schedule sits on.
        if matches(v.get("qbo_account_id")):
            return {"kind": fact.kind, "module": "schedules",
                    "text": f"{vendor}: {_schedule_brief(v)} set up on this account.",
                    "fact_id": str(fact.id)}
        # The expense/offset account it posts into.
        off = str(v.get("offset_qbo_account_id") or "").strip()
        if off and bool(qid) and off == qid:
            return {"kind": fact.kind, "module": "schedules",
                    "text": f"{vendor}'s {stype} posts into this account.",
                    "fact_id": str(fact.id)}
        return None

    if fact.kind == "recon_recurring_item":
        if matches(v.get("qbo_account_id")):
            label = (v.get("label") or "Recurring item").strip() or "Recurring item"
            amt = v.get("expected_amount")
            txt = f"Recurring reconciling item: {label}"
            if amt not in (None, ""):
                txt += f" (≈ {_usd(amt)} each period)"
            return {"kind": fact.kind, "module": "recons",
                    "text": f"{txt}.", "fact_id": str(fact.id)}
        return None

    return None


async def account_memory_context(
    db: AsyncSession, *, qbo_account_id: str | None = None, account_number: str | None = None,
    period_end: date | None = None, actual_balance: Decimal | None = None,
) -> list[dict[str, Any]]:
    """Read-only: confirmed (active) facts that concern ONE account, as display
    notes for the 'What Nordavix knows' surfaces in flux + recon. Additive
    context only — never changes a computed number. SELECT is tenant-auto-filtered,
    so one workspace can never read another's conventions.

    When the caller supplies `period_end` + `actual_balance` (the account's booked
    balance this period), each variance_expectation note gains a live `match`:
    {status: 'within'|'deviates', expected, text} — the same evaluation flux applies
    to a variance, surfaced read-only so the recon drawer can show whether this
    period lands as expected. Omitted when the rule doesn't fire this period."""
    if not (qbo_account_id or "").strip() and not (account_number or "").strip():
        return []
    facts = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.status == "active")
    )).scalars().all()
    notes: list[dict[str, Any]] = []
    for f in facts:
        note = _fact_note_for_account(f, qbo_account_id, account_number)
        if not note:
            continue
        if (f.kind == "variance_expectation" and period_end is not None
                and actual_balance is not None):
            try:
                res = evaluate_expectation(f.value, period_end, actual_balance)
            except Exception:  # pragma: no cover - defensive; note still renders
                res = None
            if res is not None:
                note["match"] = {
                    "status": "within" if res["pre_explained"] else "deviates",
                    "expected": str(res["expected_value"]),
                    "text": res["basis"],
                }
        notes.append(note)
    return notes


async def account_ai_guidance(
    db: AsyncSession, *,
    qbo_account_id: str | None,
    account_number: str | None = None,
    offset_source: str | None = None,
) -> str | None:
    """The 'Confirmed firm guidance' block injected into the flux + recon AI prompts
    so the model's analysis reflects what the firm has CONFIRMED about this account —
    recurring expectations, vendor/schedule conventions, recurring reconciling items,
    and (for adjusting entries) the preferred offset account.

    Confirm-first: only `active` facts. Best-effort — returns None on any failure so a
    memory lookup can never break an AI run. Framed as guidance to WEIGH, never an
    instruction to obey, so memory can never silence a genuine exception.

    `offset_source` ('flux'|'recon') selects the offset fact's source for the stronger,
    action-oriented offset directive; pass None to omit it (the passive offset note
    still appears via account_memory_context when present).
    """
    try:
        lines: list[str] = []
        offset_label: str | None = None
        if offset_source and (qbo_account_id or "").strip():
            fact = await active_offset_fact(db, source=offset_source, source_ref=qbo_account_id)
            if fact:
                v = fact.value or {}
                num = (v.get("to_account_number") or "").strip()
                nm = (v.get("to_account_name") or "").strip()
                offset_label = f"{num} · {nm}".strip(" ·") if num else nm
        notes = await account_memory_context(
            db, qbo_account_id=qbo_account_id, account_number=account_number,
        )
        for n in notes:
            # The offset gets a stronger, action-oriented directive below when an
            # offset_source is supplied — don't also list its passive note then.
            if offset_source and n.get("kind") == "offset_account":
                continue
            txt = (n.get("text") or "").strip()
            if txt:
                lines.append(f"- {txt}")
        directive = ""
        if offset_label:
            directive = (
                f"\n- When an adjusting entry is warranted, book the offset to {offset_label} "
                f"(use it for the offset line unless the evidence clearly points elsewhere)."
            )
        if not lines and not directive:
            return None
        return (
            "Confirmed firm guidance for this account (reviewer-approved — weigh it, "
            "but still flag any genuine exception):\n"
            + "\n".join(lines) + directive
        )
    except Exception:  # pragma: no cover - defensive; AI run proceeds without memory
        logger.exception("account_ai_guidance lookup failed (qbo=%s)", qbo_account_id)
        return None


# ── Recurring reconciling items (Slice C — learn period-over-period recon items) ─
#
# When an accountant marks a reconciling item as RECURRING, capture it confirm-
# first. Once confirmed, next period's recon SUGGESTS it — the preparer still
# toggles it on and confirms the amount. Memory NEVER auto-adds a reconciling
# item: items reduce the GL↔subledger difference, so an auto-added one could make
# a recon falsely tie. So the apply side is suggestion-only, by design.

_RECURRING_PREFIX = "recon:recurring:"


def _recurring_slug(label: str) -> str:
    """Stable slug for a recurring-item label, used in the fact_key so one account
    can carry several distinct recurring items (e.g. unapplied cash AND in-transit)
    without colliding."""
    s = "".join(c if c.isalnum() else "-" for c in (label or "").strip().lower())
    s = "-".join(p for p in s.split("-") if p)  # collapse runs of "-"
    return s[:60]


def recurring_item_title(label: str, account_name: str | None, expected_amount: Any) -> str:
    """Human-readable label for a captured recurring reconciling item."""
    base = f'{(account_name or "This account")}: recurring "{label}"'
    if expected_amount not in (None, ""):
        base += f" ≈ {_usd(expected_amount)}/period"
    return base[:400]


async def record_recurring_item_signal(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    qbo_account_id: str,
    period_end: date,
    value: dict[str, Any],
    created_by: uuid.UUID | None,
) -> ClientMemorySignal:
    """One capture observation for a recurring reconciling item."""
    sig = ClientMemorySignal(
        id=uuid.uuid4(), tenant_id=tenant_id,
        signal_type="recon_recurring_item", source="recon",
        source_ref=qbo_account_id[:100], period_end=period_end,
        account_key=qbo_account_id[:160], proposed_entry_id=None,
        before=None, after=value, created_by=created_by,
    )
    db.add(sig)
    await db.flush()
    return sig


async def upsert_recurring_item_fact(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    qbo_account_id: str,
    label: str,
    value: dict[str, Any],
    title: str,
) -> ClientMemoryFact:
    """Upsert the confirm-first recurring-item fact (suggested; never applied until
    confirmed). A CONFIRMED (active) fact is only reinforced, never silently
    overwritten with a new amount/label out from under the reviewer."""
    fact_key = f"{_RECURRING_PREFIX}{qbo_account_id}:{_recurring_slug(label)}"[:200]
    sigs = (await db.execute(
        select(ClientMemorySignal).where(
            ClientMemorySignal.signal_type == "recon_recurring_item",
            ClientMemorySignal.source == "recon",
            ClientMemorySignal.account_key == qbo_account_id[:160],
        )
    )).scalars().all()
    seen = len({s.period_end for s in sigs}) or 1
    provenance = {"seen": seen, "signal_ids": [str(s.id) for s in sigs][:20]}
    now = datetime.now(UTC)

    existing = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
    )).scalar_one_or_none()
    if existing is None:
        fact = ClientMemoryFact(
            id=uuid.uuid4(), tenant_id=tenant_id, kind="recon_recurring_item",
            fact_key=fact_key, title=title[:400], value=value, confidence=seen,
            status="suggested", provenance=provenance, last_seen_at=now,
        )
        if await _insert_fact_or_lose_race(db, fact):
            return fact
        existing = (await db.execute(
            select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
        )).scalar_one_or_none()
        if existing is None:
            raise RuntimeError("recurring-item fact vanished after unique conflict")
    if existing.status == "active":
        existing.confidence = seen
        existing.last_seen_at = now
    else:
        existing.title = title[:400]
        existing.value = value
        existing.confidence = seen
        existing.provenance = provenance
        existing.status = "suggested"
        existing.last_seen_at = now
    await db.flush()
    return existing


async def active_recurring_items(db: AsyncSession, qbo_account_id: str) -> list[dict[str, Any]]:
    """Confirmed recurring reconciling items for an account — suggestion-shaped for
    the recon 'Recurring (from memory)' panel. Only `active` facts; the preparer
    still toggles each on and confirms the amount (never auto-added). SELECT is
    tenant-auto-filtered."""
    qid = (qbo_account_id or "").strip()
    if not qid:
        return []
    facts = (await db.execute(
        select(ClientMemoryFact).where(
            ClientMemoryFact.kind == "recon_recurring_item",
            ClientMemoryFact.status == "active",
        )
    )).scalars().all()
    out: list[dict[str, Any]] = []
    for f in facts:
        v = f.value or {}
        if str(v.get("qbo_account_id") or "").strip() != qid:
            continue
        out.append({
            "fact_id": str(f.id),
            "label": v.get("label") or f.title,
            "txn_type": v.get("txn_type") or "Reconciling item",
            "expected_amount": v.get("expected_amount"),
            "entity": v.get("entity") or "",
        })
    return out


# ── GL accuracy exceptions (Client Brain — dismissed-as-correct) ───────────────
#
# When a reviewer dismisses a GL-accuracy flag ("this coding is correct"), record
# the vendor→account pairing as a CONFIRMED exception so the watchdog never raises
# it again. Minted already-ACTIVE: the dismissal IS the human confirmation.

_GLACC_EXC_PREFIX = "gl_accuracy:exception:"


async def confirm_classification_exception(
    db: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    vendor: str,
    vendor_norm: str,
    account_id: str,
    account_name: str | None,
    created_by: uuid.UUID | None,
) -> ClientMemoryFact:
    """Record a vendor→account pairing as correct (watchdog won't re-flag it).
    Active on creation; idempotent on fact_key; race-safe."""
    # Key on the RAW normalized vendor (already lowercased + whitespace-collapsed),
    # not a slug — slugging maps "AT&T" and "AT T" to the same token, which would
    # let one vendor's confirmed exception overwrite another's and re-open a
    # dismissed pairing. Strip the ":" delimiter so it can't break the key shape.
    vk = (vendor_norm or vendor or "").replace(":", " ").strip()
    fact_key = f"{_GLACC_EXC_PREFIX}{vk}:{account_id}"[:200]
    value = {"vendor": vendor, "vendor_norm": vendor_norm,
             "account_id": account_id, "account_name": account_name}
    title = f'"{vendor or "This vendor"}" → {account_name or account_id} is correct'[:400]
    now = datetime.now(UTC)

    existing = (await db.execute(
        select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
    )).scalar_one_or_none()
    if existing is None:
        fact = ClientMemoryFact(
            id=uuid.uuid4(), tenant_id=tenant_id, kind="gl_accuracy_exception",
            fact_key=fact_key, title=title, value=value, confidence=1,
            status="active", provenance={"seen": 1}, last_seen_at=now,
            confirmed_by=created_by, confirmed_at=now,
        )
        if await _insert_fact_or_lose_race(db, fact):
            return fact
        existing = (await db.execute(
            select(ClientMemoryFact).where(ClientMemoryFact.fact_key == fact_key)
        )).scalar_one_or_none()
        if existing is None:
            raise RuntimeError("gl-accuracy exception vanished after unique conflict")
    existing.status = "active"
    existing.value = value
    existing.title = title
    existing.last_seen_at = now
    if existing.confirmed_at is None:
        existing.confirmed_by = created_by
        existing.confirmed_at = now
    await db.flush()
    return existing


async def active_classification_exceptions(db: AsyncSession) -> set[tuple[str, str]]:
    """Confirmed (vendor_norm, account_id) pairings the watchdog must never flag.
    SELECT auto-filtered to the current tenant."""
    facts = (await db.execute(
        select(ClientMemoryFact).where(
            ClientMemoryFact.kind == "gl_accuracy_exception",
            ClientMemoryFact.status == "active",
        )
    )).scalars().all()
    out: set[tuple[str, str]] = set()
    for f in facts:
        v = f.value or {}
        vn = str(v.get("vendor_norm") or "").strip()
        acct = str(v.get("account_id") or "").strip()
        if vn and acct:
            out.add((vn, acct))
    return out


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
