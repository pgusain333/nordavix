"""Transaction-level forensics on cash.

The scanner's twelve detectors have never seen a bank account. `scan_period`
built its account list from `_EXPENSE_TYPES = ("expense", "cost of goods")`, so
every transaction-level check ran on the spend side of the ledger and stopped
there. Cash got balance-level reconciliation — does the GL agree with the
statement — and nothing about the transactions themselves.

That is backwards for the risk. A misclassified subscription is a presentation
error. Money leaving the bank is money gone, and the bank account is where
duplicate payments, structured withdrawals and fictitious vendors actually show
up. It is the one account where being wrong costs cash rather than tidiness.

These detectors are deliberately built on the SAME contract as the existing
twelve — pure functions over transactions, returning flags the existing
pipeline turns into findings. That is the whole design: a bank finding then
inherits every downstream behaviour the module already has, for free. It can be
dispositioned, it teaches Client Memory when confirmed, it can raise a proposed
adjusting entry, it appears in Risk Radar and in the continuous-close watch, it
lands in the review memo, and it writes graph edges to its account and period.
Building a parallel "fraud module" would have meant re-earning all of that.

Two principles, because a fraud detector that cries wolf is worse than none —
people stop reading the list, and then the real one is invisible too:

  * every flag names the specific transactions behind it, so a reviewer can
    disagree with the evidence rather than the verdict;
  * anything that is merely UNUSUAL says so, and is separated from what is
    genuinely irregular. "Paid on a Saturday" is a question. "Left the bank
    with no entry in the books" is a finding.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Any

ZERO = Decimal("0")

# ── Thresholds, in one place so they can be argued with ───────────────────

# A payment repeated to the same payee for the same amount inside this window
# is a duplicate worth asking about. Wider than a few days because invoice
# runs and month-end batches legitimately cluster, and a genuine double-pay is
# usually days apart rather than minutes.
DUPLICATE_WINDOW_DAYS = 10

# Below this, a duplicate is a rounding annoyance rather than money worth a
# reviewer's afternoon.
DUPLICATE_MIN = Decimal("250")

# Round-dollar payments at or above this are worth a look. Real invoices carry
# tax and odd cents; invented ones are typed by a human, and humans type round
# numbers.
ROUND_DOLLAR_MIN = Decimal("1000")

# Common internal approval limits. A cluster of payments landing just beneath
# one of these is the classic signature of structuring — splitting a payment to
# stay under the level that would need a second signature.
APPROVAL_THRESHOLDS = [Decimal(x) for x in (1000, 5000, 10000, 25000, 50000)]
# How far below a threshold still counts as "just under".
STRUCTURING_BAND = Decimal("0.05")     # within 5%
STRUCTURING_MIN_COUNT = 3              # a habit, not a coincidence

# A first payment to a brand-new payee at or above this is worth confirming
# before it becomes a standing arrangement.
NEW_PAYEE_MIN = Decimal("5000")

# Cheque-number gaps larger than this are usually a different book or a range
# nobody used, not a missing cheque.
MAX_SEQUENCE_GAP = 20


def _d(v: Any) -> Decimal:
    try:
        return Decimal(str(v or 0))
    except Exception:
        return ZERO


def _payee(t: dict) -> str:
    return (t.get("entity_name") or "").strip()


def _outflow(t: dict) -> Decimal:
    """How much cash LEFT on this transaction, as a positive number.

    Bank balances are debit-positive, so money leaving is a credit — a negative
    amount. Every detector here is about outflow: cash arriving is a
    reconciliation question, not a fraud one, and mixing the two would flag
    every customer receipt as unusual.
    """
    amt = _d(t.get("amount"))
    return -amt if amt < ZERO else ZERO


def _ref(t: dict) -> str:
    return str(t.get("txn_number") or "").strip()


def _evidence(txns: list[dict]) -> list[dict]:
    """The transactions behind a flag, in the shape the finding stores.

    Always attached. A forensic flag a reviewer cannot inspect is one they can
    only accept or ignore, and the ones they ignore are the ones that mattered.
    """
    return [
        {
            "qbo_txn_id": t.get("qbo_txn_id"),
            "txn_date": (t["txn_date"].isoformat()
                         if isinstance(t.get("txn_date"), date) else str(t.get("txn_date") or "")),
            "txn_number": _ref(t),
            "payee": _payee(t),
            "amount": str(_outflow(t)),
            "memo": (t.get("memo") or "")[:200],
        }
        for t in txns[:12]
    ]


# ── Detector: the same payment made twice ─────────────────────────────────

KIND_DUPLICATE_PAYMENT = "bank_duplicate_payment"


def detect_duplicate_payments(txns: list[dict]) -> list[dict]:
    """Same payee, same amount, days apart.

    The single most money-recovering test in accounts payable, and it needs no
    cleverness: an invoice paid twice looks exactly like an invoice paid twice.
    Grouped on (payee, exact amount) because a near-miss is a different
    invoice, and loosening it to "about the same" would bury the real ones
    under every recurring bill.
    """
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for t in txns:
        out = _outflow(t)
        payee = _payee(t)
        if out < DUPLICATE_MIN or not payee:
            continue
        groups[(payee.lower(), str(out))].append(t)

    flags: list[dict] = []
    for (_p, _a), items in groups.items():
        if len(items) < 2:
            continue
        dated = sorted((t for t in items if isinstance(t.get("txn_date"), date)),
                       key=lambda t: t["txn_date"])
        if len(dated) < 2:
            continue
        # Only pairs inside the window. A quarterly bill of the same amount is
        # not a duplicate, and calling it one teaches people to ignore the list.
        close = [
            dated[i] for i in range(len(dated))
            if any(abs((dated[i]["txn_date"] - dated[j]["txn_date"]).days) <= DUPLICATE_WINDOW_DAYS
                   for j in range(len(dated)) if j != i)
        ]
        if len(close) < 2:
            continue
        amount = _outflow(close[0])
        flags.append({
            "kind": KIND_DUPLICATE_PAYMENT,
            "severity": "high",
            "vendor": _payee(close[0]),
            "qbo_account_id": close[0].get("qbo_account_id"),
            "account_name": close[0].get("qbo_account_name"),
            "amount": amount,
            "title": f"{_payee(close[0])} paid {len(close)}× for {amount:,.2f}",
            "detail": (
                f"{len(close)} payments of {amount:,.2f} to {_payee(close[0])} within "
                f"{DUPLICATE_WINDOW_DAYS} days. If this is one invoice paid more than "
                f"once, {amount:,.2f} is recoverable."
            ),
            "evidence": _evidence(close),
        })
    return flags


# ── Detector: money left the bank with no entry in the books ──────────────

KIND_UNRECORDED_WITHDRAWAL = "bank_unrecorded_withdrawal"


def detect_unrecorded_withdrawals(statement_lines: list[dict]) -> list[dict]:
    """Cash out on the statement that the general ledger has no record of.

    The strongest signal available here and the reason bank reconciliation
    exists at all. A payment the books do not know about is either an error
    nobody caught or a payment nobody authorised, and both are worth stopping
    the close for.

    Reads the STATEMENT side rather than the GL, deliberately: the GL cannot
    report a transaction it never had. Anything Nordavix already matched to a
    GL transaction is excluded — this is only what remains unexplained.
    """
    flags: list[dict] = []
    for line in statement_lines:
        if str(line.get("match_status") or "").lower() == "matched":
            continue
        amount = _d(line.get("amount"))
        if amount >= ZERO:      # deposits are a completeness question, not this one
            continue
        out = -amount
        desc = (line.get("description") or "").strip() or "Unidentified withdrawal"
        flags.append({
            "kind": KIND_UNRECORDED_WITHDRAWAL,
            "severity": "high",
            "vendor": desc[:120],
            "qbo_account_id": line.get("qbo_account_id"),
            "amount": out,
            "title": f"{out:,.2f} left the bank with no entry in the books",
            "detail": (
                f"The statement shows {out:,.2f} paid out ({desc}) and the general "
                f"ledger has nothing matching it. Either an entry is missing or the "
                f"payment was not authorised."
            ),
            "evidence": [{
                "txn_date": str(line.get("txn_date") or ""),
                "amount": str(out),
                "memo": desc[:200],
                "bank_ref": line.get("bank_ref"),
            }],
        })
    return flags


# ── Detector: payments arranged to stay under an approval limit ───────────

KIND_STRUCTURING = "bank_structuring"


def detect_structuring(txns: list[dict]) -> list[dict]:
    """Repeated payments landing just beneath a round approval threshold.

    One payment of 4,900 is a payment. Five payments of 4,900 when authority
    runs out at 5,000 is a pattern, and it is the shape of someone splitting
    spend to avoid a second signature.

    Says PATTERN, never intent. The product cannot know whether a limit was
    being avoided or a supplier simply invoices in that range, and a detector
    that accuses is one a firm cannot show a client.
    """
    flags: list[dict] = []
    for threshold in APPROVAL_THRESHOLDS:
        floor = threshold * (Decimal("1") - STRUCTURING_BAND)
        by_payee: dict[str, list[dict]] = defaultdict(list)
        for t in txns:
            out = _outflow(t)
            if floor <= out < threshold and _payee(t):
                by_payee[_payee(t).lower()].append(t)
        for _payee_key, items in by_payee.items():
            if len(items) < STRUCTURING_MIN_COUNT:
                continue
            total = sum((_outflow(t) for t in items), ZERO)
            flags.append({
                "kind": KIND_STRUCTURING,
                "severity": "high",
                "vendor": _payee(items[0]),
                "qbo_account_id": items[0].get("qbo_account_id"),
                "account_name": items[0].get("qbo_account_name"),
                "amount": total,
                "title": (f"{len(items)} payments to {_payee(items[0])} just under "
                          f"{threshold:,.0f}"),
                "detail": (
                    f"{len(items)} payments totalling {total:,.2f}, each between "
                    f"{floor:,.0f} and {threshold:,.0f}. Worth confirming this is how "
                    f"the supplier invoices rather than spend arranged to stay below "
                    f"an approval limit."
                ),
                "evidence": _evidence(items),
            })
    return flags


# ── Detector: round-dollar payments ───────────────────────────────────────

KIND_ROUND_DOLLAR = "bank_round_dollar"


def detect_round_dollar(txns: list[dict]) -> list[dict]:
    """Cash out at exact round amounts.

    Real invoices carry tax and odd cents. Round numbers are typed by people,
    which is why they cluster in invented transactions — and also why they
    cluster in perfectly ordinary transfers, rent and loan repayments. Reported
    as UNUSUAL rather than irregular for exactly that reason.
    """
    flags: list[dict] = []
    for t in txns:
        out = _outflow(t)
        if out < ROUND_DOLLAR_MIN or out % Decimal("1000") != ZERO:
            continue
        flags.append({
            "kind": KIND_ROUND_DOLLAR,
            "severity": "low",
            "vendor": _payee(t) or "Unnamed payee",
            "qbo_account_id": t.get("qbo_account_id"),
            "account_name": t.get("qbo_account_name"),
            "amount": out,
            "title": f"Round payment of {out:,.0f} to {_payee(t) or 'an unnamed payee'}",
            "detail": (
                f"An exact {out:,.0f} left the bank. Round amounts are normal for "
                f"transfers, rent and loan repayments — worth a glance only if this "
                f"is supposed to be an invoice."
            ),
            "evidence": _evidence([t]),
        })
    return flags


# ── Detector: a large first payment to someone new ────────────────────────

KIND_NEW_PAYEE = "bank_new_payee"


def detect_new_payee_payments(txns: list[dict], history: list[dict]) -> list[dict]:
    """A payee the bank has never paid before, receiving a significant sum.

    Every fictitious-vendor scheme has a first payment. This will also catch
    every genuine new supplier, which is the point — confirming a new payee
    once is cheap, and the confirmation teaches Client Memory to stop asking.
    """
    known = {_payee(t).lower() for t in history if _payee(t)}
    seen: set[str] = set()
    flags: list[dict] = []
    for t in sorted((t for t in txns if isinstance(t.get("txn_date"), date)),
                    key=lambda t: t["txn_date"]):
        payee = _payee(t)
        out = _outflow(t)
        key = payee.lower()
        if not payee or key in known or key in seen or out < NEW_PAYEE_MIN:
            continue
        seen.add(key)
        flags.append({
            "kind": KIND_NEW_PAYEE,
            "severity": "medium",
            "vendor": payee,
            "qbo_account_id": t.get("qbo_account_id"),
            "account_name": t.get("qbo_account_name"),
            "amount": out,
            "title": f"First payment to {payee} — {out:,.2f}",
            "detail": (
                f"{out:,.2f} paid to {payee}, who has not been paid from this account "
                f"before. Worth confirming the payee and the bank details once."
            ),
            "evidence": _evidence([t]),
        })
    return flags


# ── Detector: paid when nobody was in the office ──────────────────────────

KIND_WEEKEND = "bank_weekend_payment"


def detect_weekend_payments(txns: list[dict]) -> list[dict]:
    """Cash out dated on a Saturday or Sunday.

    Direct debits and card settlements fall on weekends all the time, so this
    is UNUSUAL, not irregular — and it is only raised above a size worth
    someone's attention. A manual payment dated when the office was shut is a
    reasonable thing to ask one question about.
    """
    flags: list[dict] = []
    for t in txns:
        d = t.get("txn_date")
        out = _outflow(t)
        if not isinstance(d, date) or d.weekday() < 5 or out < NEW_PAYEE_MIN:
            continue
        flags.append({
            "kind": KIND_WEEKEND,
            "severity": "low",
            "vendor": _payee(t) or "Unnamed payee",
            "qbo_account_id": t.get("qbo_account_id"),
            "account_name": t.get("qbo_account_name"),
            "amount": out,
            "title": (f"{out:,.2f} paid on a "
                      f"{'Saturday' if d.weekday() == 5 else 'Sunday'}"),
            "detail": (
                f"{out:,.2f} to {_payee(t) or 'an unnamed payee'} dated {d.isoformat()}, "
                f"a weekend. Normal for direct debits and card settlements; worth a "
                f"question if it was raised by hand."
            ),
            "evidence": _evidence([t]),
        })
    return flags


# ── Detector: a cheque that is missing ────────────────────────────────────

KIND_SEQUENCE_GAP = "bank_sequence_gap"


def detect_sequence_gaps(txns: list[dict]) -> list[dict]:
    """Numbers missing from an otherwise continuous cheque run.

    A cheque written and never recorded leaves a hole in the sequence, and the
    hole is the only trace it leaves anywhere.

    Only continuous runs are considered, and only small gaps: a jump of
    hundreds is a new cheque book or a different account, and reporting it
    would bury the single missing number that matters.
    """
    by_account: dict[str, list[int]] = defaultdict(list)
    labels: dict[str, dict] = {}
    for t in txns:
        ref = _ref(t)
        if not ref.isdigit() or len(ref) > 8:
            continue
        acct = str(t.get("qbo_account_id") or "")
        by_account[acct].append(int(ref))
        labels.setdefault(acct, t)

    flags: list[dict] = []
    for acct, numbers in by_account.items():
        uniq = sorted(set(numbers))
        if len(uniq) < 3:            # too short a run to call anything a gap
            continue
        missing: list[int] = []
        for a, b in zip(uniq, uniq[1:], strict=False):
            gap = b - a - 1
            if 0 < gap <= MAX_SEQUENCE_GAP:
                missing.extend(range(a + 1, b))
        if not missing:
            continue
        sample = labels[acct]
        flags.append({
            "kind": KIND_SEQUENCE_GAP,
            "severity": "medium",
            "vendor": "Cheque sequence",
            "qbo_account_id": acct or None,
            "account_name": sample.get("qbo_account_name"),
            "amount": ZERO,
            "title": (f"{len(missing)} number{'' if len(missing) == 1 else 's'} missing "
                      f"from the cheque run"),
            "detail": (
                f"Numbers {', '.join(str(m) for m in missing[:8])}"
                + (" and others" if len(missing) > 8 else "")
                + " are absent between "
                f"{uniq[0]} and {uniq[-1]}. A cheque written and never recorded leaves "
                f"exactly this trace — worth accounting for each one as void, unused, "
                f"or outstanding."
            ),
            "evidence": [{"missing": [str(m) for m in missing[:20]]}],
        })
    return flags


# ── The suite ─────────────────────────────────────────────────────────────

# Everything here is scored as a QUESTION about cash unless it is genuinely
# unexplained. `severity` drives how it reads on screen, and the two "high"
# kinds are the only ones that assert something is wrong rather than odd.
BANK_DETECTORS = [
    {"kind": KIND_DUPLICATE_PAYMENT,     "label": "Duplicate payment"},
    {"kind": KIND_UNRECORDED_WITHDRAWAL, "label": "Unrecorded withdrawal"},
    {"kind": KIND_STRUCTURING,           "label": "Payments under an approval limit"},
    {"kind": KIND_NEW_PAYEE,             "label": "First payment to a new payee"},
    {"kind": KIND_SEQUENCE_GAP,          "label": "Missing cheque number"},
    {"kind": KIND_ROUND_DOLLAR,          "label": "Round-dollar payment"},
    {"kind": KIND_WEEKEND,               "label": "Weekend payment"},
]
BANK_KINDS = {d["kind"] for d in BANK_DETECTORS}


def run_bank_detectors(
    txns: list[dict],
    history: list[dict],
    statement_lines: list[dict] | None = None,
) -> list[dict]:
    """Every bank check, over one period's cash transactions.

    `txns` are the period's GL transactions on bank accounts; `history` is the
    same for the lookback window, used only to decide who is new; and
    `statement_lines` are the bank's own records, which is the only place an
    unrecorded withdrawal can possibly be seen.

    Ordered so the two that assert something is wrong come first — a reviewer
    reading top-down meets the money before the curiosities.
    """
    flags: list[dict] = []
    flags += detect_duplicate_payments(txns)
    flags += detect_unrecorded_withdrawals(statement_lines or [])
    flags += detect_structuring(txns)
    flags += detect_new_payee_payments(txns, history)
    flags += detect_sequence_gaps(txns)
    flags += detect_round_dollar(txns)
    flags += detect_weekend_payments(txns)
    return suppress_weaker_overlaps(flags)


# Severity as a number, so "which of these two says more" is comparable.
_RANK = {"high": 3, "medium": 2, "low": 1}


def suppress_weaker_overlaps(flags: list[dict]) -> list[dict]:
    """Drop the faint observation when a louder one already covers the same money.

    A 9,000 payment to a brand-new payee on a Saturday is one thing worth
    asking about, and it was producing three findings: new payee, round dollar,
    weekend. Each true, and together they are noise — the reviewer reads the
    same payment three times and starts skimming, which is precisely how the
    one that mattered gets missed.

    So a LOW-severity flag is dropped when a higher-severity flag already names
    one of its transactions. Only downward: two high findings on the same money
    are two genuine questions (paid twice, AND arranged under a limit) and a
    reviewer wants both. This only removes the curiosities that a real finding
    has already brought to their attention.
    """
    covered: set[str] = set()
    for f in flags:
        if _RANK.get(str(f.get("severity")), 1) <= 1:
            continue
        for e in f.get("evidence") or []:
            if e.get("qbo_txn_id"):
                covered.add(str(e["qbo_txn_id"]))

    kept: list[dict] = []
    for f in flags:
        if _RANK.get(str(f.get("severity")), 1) > 1:
            kept.append(f)
            continue
        ids = {str(e.get("qbo_txn_id")) for e in (f.get("evidence") or []) if e.get("qbo_txn_id")}
        # Kept only when nothing louder has already raised this transaction.
        if not ids or not (ids & covered):
            kept.append(f)
    return kept


def as_finding_flag(flag: dict) -> dict:
    """One bank flag, in the shape `_replace_open_findings` already stores.

    The point of this function is that there ISN'T a bank-findings table. A
    bank flag becomes an ordinary GlAccuracyFinding, so it inherits
    dispositions, Client Memory exceptions, proposed adjusting entries, Risk
    Radar, the continuous-close watch, the review memo and the graph edges —
    every one of which would otherwise have to be built again.

    `action_kind` uses the vocabulary the UI already speaks. "flag" means
    review-only — acknowledge it, no journal entry — which is right for a
    duplicate payment: the answer is to recover the money, not to recode it.
    The exception is an unrecorded withdrawal, where the books ARE missing an
    entry and "reclass" gets the reviewer the draft they need.

    Inventing a third word here would have produced a finding the page could
    not offer the right action for — copy promising a control that does not
    exist, which is a defect this codebase has already produced twice.
    """
    return {
        **flag,
        "dedupe_key": bank_finding_key(flag),
        "action_kind": ("reclass" if flag.get("kind") == KIND_UNRECORDED_WITHDRAWAL
                        else "flag"),
        "posted_account_id": flag.get("qbo_account_id"),
        "posted_account_name": flag.get("account_name"),
        "confidence": flag.get("severity") or "medium",
    }


def bank_finding_key(flag: dict) -> str:
    """Stable across re-scans, so a re-run updates a finding instead of
    creating a second one and a disposition survives the next scan.

    Keyed on what makes the finding the same problem — kind, account, payee and
    amount — never on a transaction id, because several of these are about a
    GROUP of transactions and the group's membership can grow.
    """
    return "|".join([
        str(flag.get("kind") or ""),
        str(flag.get("qbo_account_id") or ""),
        (flag.get("vendor") or "").strip().lower()[:80],
        f"{_d(flag.get('amount')):.2f}",
    ])
