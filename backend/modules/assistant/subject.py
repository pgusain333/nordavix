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

Each kind is a resolver; they share the component, the thread and the prompt
plumbing rather than growing one of each. A subject is also SERIALISABLE, which
turns it into an address: a digest email or a notification can link to the
screen with the question already asked, instead of just to the screen.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

SUBJECT_KINDS = ("account", "variance", "entry")

# Variances below this are rounding, not a question worth putting in someone's
# face as a suggested prompt. Matches the tie-out tolerance used elsewhere.
_MATERIAL = Decimal("1.00")

# At most this many chips. Three fits one line at the drawer's default width,
# and a wall of suggestions is its own kind of blank page.
_MAX_SUGGESTIONS = 3

# What joins the preamble's lines. A named constant rather than the literal,
# so this file stays safe to edit with tooling that mangles escape sequences.
_NL = chr(10)

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

def _account_suggestions(state: dict) -> list[str]:
    """The questions worth asking about a RECONCILIATION account, best first.

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


def _account_headline(state: dict) -> str:
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


def _account_describe(state: dict) -> str:
    """The account preamble handed to the model with the question.

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


# ── Variance ──────────────────────────────────────────────────────────────────

def _variance_suggestions(state: dict) -> list[str]:
    """A flux variance's questions.

    Different from an account's because the job is different. A reconciliation
    drawer asks "does this tie"; a flux drawer asks "why did it move" and then
    wants that written down. So the order runs explain → write → compare, and
    the FIRST chip changes depending on whether commentary already exists —
    offering to "explain this" over an explanation someone wrote is the
    assistant not reading the room.
    """
    out: list[str] = []
    mv = _dec(state.get("dollar_variance"))
    has_note = bool(state.get("commentary"))

    if not has_note and abs(mv) >= _MATERIAL:
        out.append(f"Why did this move {_money(mv)}?")
    elif has_note:
        out.append("Is this explanation complete?")

    if state.get("expected_value") is not None:
        out.append("Is this what we expected?")

    if not has_note:
        out.append("Write the commentary")

    if state.get("txn_count"):
        out.append(f"Walk me through the {state['txn_count']} transactions")
    else:
        out.append("What drove it?")

    if state.get("anomaly_flags"):
        out.append("Why was this flagged?")

    out.append("How did this look last year?")

    seen: set[str] = set()
    uniq = [x for x in out if not (x in seen or seen.add(x))]
    return uniq[:_MAX_SUGGESTIONS]


def _variance_headline(state: dict) -> str:
    mv = _dec(state.get("dollar_variance"))
    bits = [f"{'+' if mv >= 0 else '−'}{_money(mv)} vs {state.get('prior_period') or 'prior'}"]
    pct = state.get("pct_variance")
    if pct is not None:
        try:
            bits.append(f"{float(pct):+.1f}%")
        except (TypeError, ValueError):
            pass
    bits.append("material" if state.get("is_material") else "below materiality")
    bits.append("explained" if state.get("commentary") else "not explained yet")
    return " · ".join(bits)


def _variance_describe(state: dict) -> str:
    label = state.get("label") or "this account"
    lines = [
        f"SUBJECT: the user is looking at the FLUX VARIANCE on {label} for "
        f"{state.get('period_end')} and their question is about IT unless they "
        f"clearly name something else. Do not ask which account or which period "
        f"— you have both."
    ]
    facts = [
        f"current {state.get('current_balance')}",
        f"prior ({state.get('prior_period')}) {state.get('prior_balance')}",
        f"moved {state.get('dollar_variance')}",
    ]
    if state.get("pct_variance") is not None:
        facts.append(f"{state['pct_variance']}%")
    facts.append("MATERIAL" if state.get("is_material")
                 else f"below the {state.get('materiality')} materiality threshold")
    if state.get("fs_line"):
        facts.append(f"maps to {state['fs_line']}")
    facts.append(f"review status {state.get('review_status')}")
    if state.get("anomaly_flags"):
        facts.append(f"flagged: {', '.join(str(f) for f in state['anomaly_flags'][:4])}")
    if state.get("txn_count"):
        facts.append(f"{state['txn_count']} transaction(s) already pulled behind it")
    lines.append("Known already: " + "; ".join(facts) + ".")

    if state.get("expected_value") is not None:
        lines.append(
            f"The firm TAUGHT Nordavix to expect {state['expected_value']} here"
            + (f" ({state['expected_basis']})" if state.get("expected_basis") else "")
            + ". Say whether the actual matches that expectation — it is usually "
              "the real question behind \"is this ok\"."
        )
    if state.get("commentary"):
        lines.append(
            f"An explanation has ALREADY been written{' and edited by a human' if state.get('commentary_edited') else ''}: "
            f"\"{state['commentary']}\" — build on it or challenge it; do not "
            "restate it as though it were new."
        )
    else:
        lines.append(
            "NOTHING has been written to explain this variance yet. If the user "
            "asks you to write the commentary, produce something that could be "
            "pasted into the workpaper as-is: what moved, why, and whether it is "
            "expected — in two or three sentences, no preamble."
        )
    lines.append(
        "Only call a tool for something not listed above — the transactions "
        "themselves, prior periods, other accounts."
    )
    return "\n".join(lines)


# ── Adjusting entry ───────────────────────────────────────────────────────────

def _entry_suggestions(state: dict) -> list[str]:
    """An adjusting entry's questions.

    The queue is a decision surface, not a reading surface: the person looking
    at this is deciding whether to approve it. So the chips are the things a
    reviewer wants settled before they sign — is it right, what does it touch,
    who proposed it and on what basis — and they change with status, because
    "should I approve this" is not a question about an entry already posted.
    """
    out: list[str] = []
    status = (state.get("status") or "open").lower()

    if status == "open":
        out.append("Is this entry right?")
        if state.get("confidence") in ("low", "medium"):
            out.append(f"Why only {state['confidence']} confidence?")
        out.append("What does it touch?")
    elif status == "posted":
        out.append("What did this change?")
        out.append("Who approved it?")
    elif status == "dismissed":
        out.append("Why was this dismissed?")
        out.append("Should we reconsider it?")
    else:  # accepted, awaiting posting
        out.append("What does it touch?")
        out.append("Anything left before posting?")

    if state.get("source") and status == "open":
        out.append("Where did this come from?")

    out.append("Explain this entry in plain English")

    seen: set[str] = set()
    uniq = [x for x in out if not (x in seen or seen.add(x))]
    return uniq[:_MAX_SUGGESTIONS]


def _entry_headline(state: dict) -> str:
    bits = [{
        "open": "Waiting for review", "accepted": "Approved, not posted",
        "posted": "Posted", "dismissed": "Dismissed",
    }.get((state.get("status") or "").lower(), (state.get("status") or "").title())]
    amt = _dec(state.get("amount"))
    if amt:
        bits.append(_money(amt))
    if state.get("source_label"):
        bits.append(f"from {state['source_label']}")
    if state.get("confidence"):
        bits.append(f"{state['confidence']} confidence")
    return " · ".join(bits)


def _entry_describe(state: dict) -> str:
    lines = [
        f"SUBJECT: the user is looking at the ADJUSTING ENTRY \"{state.get('label')}\" "
        f"for {state.get('period_end')} in the Adjustments queue, and their question "
        f"is about IT unless they clearly name something else."
    ]
    facts = [
        f"status {state.get('status')}",
        f"proposed by {state.get('source_label') or state.get('source')}",
        f"{state.get('confidence')} confidence",
        f"total {state.get('amount')}",
    ]
    if state.get("posted_doc"):
        facts.append(f"posted to QuickBooks as {state['posted_doc']}")
    lines.append("Known already: " + "; ".join(facts) + ".")

    if state.get("lines"):
        lines.append("The entry, in full:")
        for ln in state["lines"]:
            lines.append(
                f"  {ln.get('account') or '?'} — "
                f"Dr {ln.get('debit') or '0'} / Cr {ln.get('credit') or '0'}"
            )
    if state.get("rationale"):
        lines.append(f"The stated rationale: \"{state['rationale']}\"")
    if state.get("memo"):
        lines.append(f"Memo: \"{state['memo']}\"")
    if state.get("dismiss_reason"):
        lines.append(f"It was dismissed because: \"{state['dismiss_reason']}\"")

    lines.append(
        "You have the whole entry above, so do NOT go and look it up. If asked "
        "whether it is right, actually judge it: do the accounts make sense for "
        "what it claims to do, does it balance, is the period right, and is there "
        "anything about the rationale that does not follow. Say so plainly. You "
        "never approve and never post — a human does both."
    )
    return _NL.join(lines)


# ── Dispatch ──────────────────────────────────────────────────────────────────
#
# One entry point per product so every surface calls the same three functions
# and a new kind is a branch, not a new API.

_BY_KIND = {
    "account":  (_account_suggestions, _account_headline, _account_describe),
    "variance": (_variance_suggestions, _variance_headline, _variance_describe),
    "entry":    (_entry_suggestions, _entry_headline, _entry_describe),
}


def _pick(state: dict, idx: int):
    kind = (state or {}).get("kind") or "account"
    return _BY_KIND.get(kind, _BY_KIND["account"])[idx]


def suggestions_for(state: dict) -> list[str]:
    """The two or three questions worth asking about this object."""
    return _pick(state, 0)(state)


def headline_for(state: dict) -> str:
    """One line saying where this object stands, before anyone asks."""
    return _pick(state, 1)(state)


def describe(state: dict) -> str:
    """The context preamble handed to the model with the question."""
    return _pick(state, 2)(state)


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


async def resolve_variance(
    db: AsyncSession,
    tenant_id: uuid.UUID,  # noqa: ARG001 — scoping is enforced by the session
    variance_id: str,
    period_end: date,      # noqa: ARG001 — the TB carries the period, not the caller
) -> dict | None:
    """One flux variance: what moved, by how much, and what has been said.

    The sharpest fit for the whole idea. A flux drawer exists to answer "why
    did this move", which is the question the Copilot is best at — and unlike a
    reconciliation it has the prior period's figure sitting right there, so the
    comparison needs no lookup at all.
    """
    from sqlalchemy import select

    from models.account import Account
    from models.narrative import Narrative
    from models.trial_balance import TrialBalance
    from models.variance import Variance

    try:
        vid = uuid.UUID(variance_id)
    except (ValueError, AttributeError, TypeError):
        return None

    row = (await db.execute(
        select(Variance, Account, TrialBalance)
        .join(Account, Account.id == Variance.account_id)
        .join(TrialBalance, TrialBalance.id == Account.trial_balance_id)
        .where(Variance.id == vid)
    )).first()
    if row is None:
        return None
    var, acct, tb = row

    label = f"{acct.account_number or ''} {acct.account_name or ''}".strip() or "this account"
    state: dict = {
        "kind":            "variance",
        "id":              variance_id,
        "label":           label,
        "period_end":      tb.period_current.isoformat() if tb.period_current else None,
        "prior_period":    tb.period_prior.isoformat() if tb.period_prior else None,
        "fs_line":         acct.fs_line,
        "current_balance": str(acct.current_balance),
        "prior_balance":   str(acct.prior_balance),
        "dollar_variance": str(var.dollar_variance),
        "pct_variance":    str(var.pct_variance) if var.pct_variance is not None else None,
        "is_material":     bool(var.is_material),
        "materiality":     str(tb.materiality_threshold),
        "review_status":   var.status,
        "anomaly_flags":   list(var.anomaly_flags or []),
        # An expectation the firm taught Nordavix, if one matched. "Is this
        # what we expected" is a different question from "is this big".
        "expected_value":  str(var.expected_value) if var.expected_value is not None else None,
        "expected_basis":  var.expected_basis,
        "pre_explained":   bool(getattr(var, "pre_explained", False)),
    }

    # The explanation already written for it, if any. Whether one EXISTS is the
    # difference between "explain this" and "improve what I wrote".
    try:
        nar = (await db.execute(
            select(Narrative).where(Narrative.variance_id == vid)
            .order_by(Narrative.generated_at.desc()).limit(1)
        )).scalar_one_or_none()
        if nar is not None and (nar.content or "").strip():
            state["commentary"] = nar.content.strip()[:600]
            state["commentary_edited"] = nar.edited_at is not None
    except Exception:
        logger.exception("subject: narrative lookup failed")

    # How many transactions have been pulled behind it — the model should offer
    # to walk them only when they are actually there.
    try:
        from sqlalchemy import func

        from models.variance_transaction import VarianceTransaction
        state["txn_count"] = (await db.execute(
            select(func.count()).select_from(VarianceTransaction)
            .where(VarianceTransaction.variance_id == vid)
        )).scalar_one_or_none() or 0
    except Exception:
        logger.exception("subject: variance-transaction count failed")
        state["txn_count"] = 0

    return state


_SOURCE_LABEL = {
    "recon":       "the reconciliation",
    "flux":        "flux analysis",
    "bank_match":  "the bank match",
    "assistant":   "NDVX Copilot",
    "gl_accuracy": "Risk Radar",
    "schedule":    "a schedule",
    "manual":      "a person",
}


async def resolve_entry(
    db: AsyncSession,
    tenant_id: uuid.UUID,  # noqa: ARG001 — scoping is enforced by the session
    entry_id: str,
    period_end: date,      # noqa: ARG001 — the entry carries its own period
) -> dict | None:
    """One proposed adjusting entry, whole.

    The Adjustments queue is a DECISION surface — the person looking at this is
    deciding whether to approve it — so the preamble carries the entire entry,
    every line, the rationale and the memo. Nothing about "is this right"
    should cost a lookup when the thing being judged is forty characters of
    JSON.
    """
    from decimal import Decimal as D

    from sqlalchemy import select

    from models.proposed_entry import ProposedEntry

    try:
        eid = uuid.UUID(entry_id)
    except (ValueError, AttributeError, TypeError):
        return None

    row = (await db.execute(
        select(ProposedEntry).where(ProposedEntry.id == eid)
    )).scalar_one_or_none()
    if row is None:
        return None

    lines = []
    total = D("0")
    for ln in (row.lines or []):
        if not isinstance(ln, dict):
            continue
        acct = " ".join(str(x) for x in (
            ln.get("account_number"), ln.get("account_name")) if x).strip()
        lines.append({
            "account": acct or ln.get("account_qbo_id") or "?",
            "debit":   str(ln.get("debit") or "0"),
            "credit":  str(ln.get("credit") or "0"),
        })
        total += _dec(ln.get("debit"))

    return {
        "kind":           "entry",
        "id":             entry_id,
        "label":          row.description,
        "period_end":     row.period_end.isoformat() if row.period_end else None,
        "status":         row.status,
        "source":         row.source,
        "source_label":   _SOURCE_LABEL.get(row.source, row.source),
        "confidence":     row.confidence,
        "amount":         f"{total:.2f}",
        "lines":          lines,
        "rationale":      (row.rationale or "").strip()[:600] or None,
        "memo":           (row.memo or "").strip()[:300] or None,
        "dismiss_reason": (row.dismiss_reason or "").strip()[:300] or None,
        "posted_doc":     row.posted_qbo_doc,
    }


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
        if kind == "variance":
            return await resolve_variance(db, tenant_id, subject_id, period_end)
        if kind == "entry":
            return await resolve_entry(db, tenant_id, subject_id, period_end)
    except Exception:
        logger.exception("subject: resolve failed for %s/%s", kind, subject_id)
    return None
