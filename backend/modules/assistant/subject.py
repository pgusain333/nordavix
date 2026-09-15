"""What the user is looking at when they ask.

The Copilot lives on its own page, so asking about the account already on your
screen means leaving it, retyping which account and which month, and waiting
while the model spends three or four tool calls rediscovering what was rendered
a second ago. That round trip is the whole cost of the feature — about six
seconds and a paragraph of typing, which is enough that people don't bother.

A *subject* is the thing the screen is already showing. Attached to a question
it gets resolved here into two products:

  describe()      — a context preamble injected into the system prompt, exactly
                    the way `footing.py` injects the period's trustworthiness.
                    The obvious questions then cost ZERO tool calls, because the
                    answer is already in the prompt.

  suggestions_for() — the two or three questions worth asking about THIS object,
                    derived from its real state. Pure, no model call. This is
                    the part that decides whether the feature gets used: a
                    contextual assistant that opens on an empty input teaches
                    people it is noise, and they stop looking at it.

One kind today (`account`). The shape is deliberately open — a variance, a
finding and an entry are the same idea with a different resolver, and the point
of putting it here is that they share the component, the thread and the prompt
plumbing rather than growing four of each.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

SUBJECT_KINDS = ("account",)

# Variances below this are rounding, not a question worth putting in someone's
# face as a suggested prompt. Matches the tie-out tolerance used elsewhere.
_MATERIAL = Decimal("1.00")

# At most this many chips. Three fits one line at the drawer's default width,
# and a wall of suggestions is its own kind of blank page.
_MAX_SUGGESTIONS = 3

_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December")


def _dec(v) -> Decimal:
    try:
        return Decimal(str(v or "0"))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _money(v: Decimal) -> str:
    return f"{abs(v):,.0f}"


# ── Suggestions ───────────────────────────────────────────────────────────────

def suggestions_for(state: dict) -> list[str]:
    """The questions worth asking about this object, most useful first.

    Ordered by what a controller would actually do next, not by what is easy to
    generate. An unexplained variance outranks everything — it is the reason the
    drawer is open. History outranks drafting, because knowing how it was
    treated before usually decides what the entry should be.

    Every branch reads state the screen already has, so this costs nothing and
    can run on render.
    """
    out: list[str] = []
    variance = _dec(state.get("variance"))
    status = (state.get("review_status") or "pending").lower()
    approved = status == "approved"

    if abs(variance) >= _MATERIAL and not approved:
        out.append(f"Why is this {_money(variance)} out?")

    if state.get("prior_note_period"):
        out.append(f"What did we do in {state['prior_note_period']}?")

    if state.get("open_findings"):
        out.append("Is this flag real?")

    if abs(variance) >= _MATERIAL and not approved:
        out.append("Draft the adjusting entry")

    if state.get("schedule_type"):
        out.append("Show me the roll-forward")

    if approved:
        out.append("Summarise this reconciliation")
        out.append("Who prepared and approved it?")

    # Always reachable, and the right question when nothing else is flagged.
    out.append("What's the story behind this account?")

    # Dedupe while keeping order — two branches can produce the same line for
    # an account that is both scheduled and approved.
    seen: set[str] = set()
    uniq = [s for s in out if not (s in seen or seen.add(s))]
    return uniq[:_MAX_SUGGESTIONS]


def headline_for(state: dict) -> str:
    """One line under the ask bar saying where this account stands.

    The same discipline as the period footing: say what the answer will be
    standing on before anyone asks a question of it.
    """
    variance = _dec(state.get("variance"))
    status = (state.get("review_status") or "pending").lower()
    bits: list[str] = []
    bits.append({"approved": "Approved",
                 "prepared": "Prepared, not approved",
                 "pending": "Not reconciled yet"}.get(status, status.title()))
    if abs(variance) >= _MATERIAL:
        bits.append(f"subledger out by {_money(variance)}")
    else:
        bits.append("ties to the subledger")
    if state.get("open_findings"):
        n = state["open_findings"]
        bits.append(f"{n} open flag{'s' if n != 1 else ''}")
    return " · ".join(bits)


def describe(state: dict) -> str:
    """The context preamble handed to the model with the question.

    Written as prose rather than a dict because a model given raw fields
    invents a framing, and the framing is what the user reads. Everything here
    was already on the user's screen — restating it in the prompt is what
    removes the tool calls, not what adds them.
    """
    label = state.get("label") or "this account"
    lines = [
        f"SUBJECT: the user is looking at {label} for {state.get('period_end')} "
        f"and their question is about IT unless they clearly name something else. "
        f"Do not ask which account or which month — you have both."
    ]
    facts: list[str] = []
    if state.get("account_type"):
        facts.append(f"type {state['account_type']}")
    if state.get("gl_balance") is not None:
        facts.append(f"GL balance {state['gl_balance']}")
    if state.get("subledger_balance") is not None:
        src = state.get("subledger_source") or "subledger"
        facts.append(f"{src} {state['subledger_balance']}")
    variance = _dec(state.get("variance"))
    if abs(variance) >= _MATERIAL:
        facts.append(f"VARIANCE {state.get('variance')} — not yet explained")
    else:
        facts.append("it ties")
    facts.append(f"review status {state.get('review_status')}")
    if state.get("schedule_type"):
        facts.append(f"backed by the {state['schedule_type']} schedule")
    if state.get("open_findings"):
        facts.append(f"{state['open_findings']} open Risk Radar finding(s)")
    if state.get("evidence_count"):
        facts.append(f"{state['evidence_count']} evidence file(s) attached")
    if state.get("open_entries"):
        facts.append(f"{state['open_entries']} proposed entr(y/ies) waiting in Adjustments")
    lines.append("Known already: " + "; ".join(facts) + ".")

    if state.get("review_notes"):
        lines.append(f"The reconciliation note on it reads: \"{state['review_notes']}\"")
    if state.get("prior_note"):
        lines.append(
            f"Last time anyone wrote about this account ({state.get('prior_note_period')}): "
            f"\"{state['prior_note']}\""
        )
    lines.append(
        "Answer about this account directly. Only call a tool for something not "
        "listed above — the transactions behind it, its history, other accounts."
    )
    return "\n".join(lines)


# ── Resolution ────────────────────────────────────────────────────────────────

async def resolve_account(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    qbo_account_id: str,
    period_end: date,
) -> dict | None:
    """Assemble one account's state for the period.

    Reads what the reconciliation overview already assembled rather than
    recomputing it — the drawer the user is looking at was rendered from the
    same payload, so the Copilot and the screen cannot disagree about the
    balance. Each extra read is fenced: a missing schedule or a failing
    findings query degrades the preamble, it does not lose the subject.
    """
    from modules.recons.overview import read_overview_from_snapshots

    try:
        ov = await read_overview_from_snapshots(db, period_end)
    except Exception:
        logger.exception("subject: overview read failed for %s", period_end)
        return None

    row = next(
        (a for a in (ov.get("accounts") or []) if a.get("qbo_id") == qbo_account_id),
        None,
    )
    if row is None:
        return None

    label = f"{row.get('account_number') or ''} {row.get('account_name') or ''}".strip() \
        or qbo_account_id
    state: dict = {
        "kind":               "account",
        "id":                 qbo_account_id,
        "label":              label,
        "period_end":         period_end.isoformat(),
        "account_type":       row.get("account_type"),
        "gl_balance":         row.get("gl_balance"),
        "subledger_balance":  row.get("subledger_balance"),
        "subledger_source":   row.get("subledger_source"),
        "variance":           row.get("variance"),
        "review_status":      row.get("review_status"),
        "review_notes":       row.get("review_notes"),
        "evidence_count":     row.get("evidence_count") or 0,
    }

    # Which schedule backs it, if any.
    try:
        from sqlalchemy import select

        from models.schedule import ScheduleSnapshot
        st = (await db.execute(
            select(ScheduleSnapshot.schedule_type).where(
                ScheduleSnapshot.period_end == period_end,
                ScheduleSnapshot.qbo_account_id == qbo_account_id,
                ScheduleSnapshot.status == "committed",
            ).limit(1)
        )).scalar_one_or_none()
        state["schedule_type"] = st
    except Exception:
        logger.exception("subject: schedule lookup failed")

    # Open Risk Radar findings naming this account.
    try:
        from modules.gl_accuracy.service import list_findings
        data = await list_findings(db, period_end)
        state["open_findings"] = sum(
            1 for it in (data.get("items") or [])
            if it.get("posted_account_id") == qbo_account_id
            and it.get("status") in ("open", "accepted")
        )
    except Exception:
        logger.exception("subject: findings lookup failed")
        state["open_findings"] = 0

    # Entries already proposed against this account, so the Copilot does not
    # offer to draft one that is sitting in the queue unreviewed.
    try:
        from sqlalchemy import select

        from models.proposed_entry import ProposedEntry
        rows = (await db.execute(
            select(ProposedEntry).where(
                ProposedEntry.period_end == period_end,
                ProposedEntry.status == "open",
            )
        )).scalars().all()
        state["open_entries"] = sum(
            1 for r in rows
            if any((ln or {}).get("account_qbo_id") == qbo_account_id
                   for ln in (r.lines or []))
        )
    except Exception:
        logger.exception("subject: proposed-entry lookup failed")
        state["open_entries"] = 0

    # The most recent thing anyone wrote about this account BEFORE this period.
    # "What did we do last time" is the second question people ask, and having
    # the answer in the preamble turns it into a zero-tool reply.
    try:
        from sqlalchemy import select

        from models.account_review_status import AccountReviewStatus
        prior = (await db.execute(
            select(AccountReviewStatus)
            .where(
                AccountReviewStatus.qbo_account_id == qbo_account_id,
                AccountReviewStatus.period_end < period_end,
                AccountReviewStatus.notes.is_not(None),
            )
            .order_by(AccountReviewStatus.period_end.desc())
            .limit(1)
        )).scalar_one_or_none()
        if prior is not None and (prior.notes or "").strip():
            state["prior_note"] = prior.notes.strip()[:400]
            state["prior_note_period"] = (
                f"{_MONTHS[prior.period_end.month - 1]} {prior.period_end.year}"
            )
    except Exception:
        logger.exception("subject: prior-note lookup failed")

    return state


async def resolve(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    kind: str,
    subject_id: str,
    period_end: date | None,
) -> dict | None:
    """Dispatch to the resolver for `kind`. Returns None when it can't be
    resolved — the caller carries on without a subject rather than failing the
    question, because an answer with no context beats no answer."""
    if period_end is None or kind not in SUBJECT_KINDS:
        return None
    try:
        if kind == "account":
            return await resolve_account(db, tenant_id, subject_id, period_end)
    except Exception:
        logger.exception("subject: resolve failed for %s/%s", kind, subject_id)
    return None
