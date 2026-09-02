"""The same thing going wrong every month is a different problem.

Risk Radar catches instances. "Adobe Creative Cloud, $3,240, posted to Office
Supplies" is a correction: someone re-codes it and the month closes. Next month
it happens again, and the month after, and each time the product reports it as
though it were new — because to the scanner it is. Every scan starts from the
transactions in front of it.

A vendor miscoded four months running is not four corrections. It is ONE
problem — a bank-feed rule pointing at the wrong account, a default on the
vendor record, a habit in whoever enters the bills — and fixing the cause stops
the finding recurring forever. That is the difference between a product that
catches things and one that solves them.

Grouped by (vendor, wrong account) rather than by `finding_key`, deliberately.
The key is per-period and per-transaction, so it is exactly what makes each
month's occurrence look unique; grouping on it would count every repeat as a
first offence.

Pure over rows the caller loads, so the judgement is testable without a
database and without a scan.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

# How many DISTINCT periods a pattern has to appear in before it is called a
# pattern. Two is a coincidence a reviewer can hold in their head; three is a
# habit, and the point at which "fix the cause" beats "fix the instance".
REPEAT_AFTER_PERIODS = 3

# What is reported at all. A pattern the firm has already confirmed as correct
# is not a repeat offender — it is a convention Client Memory should be holding,
# and re-raising it monthly is how a watchlist teaches people to ignore it.
_COUNTS_AS_UNRESOLVED = {"open", "accepted"}


@dataclass(frozen=True)
class Occurrence:
    """One finding, reduced to what pattern detection needs."""
    period_end: date
    vendor: str
    posted_account_name: str | None
    suggested_account_name: str | None
    amount: Decimal
    status: str


def pattern_key(o: Occurrence) -> tuple[str, str]:
    """What makes two months' findings the same problem.

    The vendor and the account it keeps landing in. NOT the suggested account:
    where it SHOULD go can shift as a chart of accounts is tidied, and a
    pattern that re-keys itself when the fix changes would restart its own
    count and never reach the threshold.
    """
    return (o.vendor.strip().lower(), (o.posted_account_name or "").strip().lower())


def find_repeats(
    occurrences: list[Occurrence], *, min_periods: int = REPEAT_AFTER_PERIODS,
) -> list[dict]:
    """Patterns that have recurred across at least `min_periods` closes.

    Counted in DISTINCT PERIODS, not occurrences. Twelve Adobe charges in one
    month is one month's problem — possibly a single bad import — while the
    same charge in three consecutive months is a rule nobody fixed. Counting
    rows instead would rank a busy month above a persistent habit, which is the
    opposite of what this is for.

    Resolved occurrences still COUNT toward the pattern but a pattern with
    nothing outstanding is not reported: it recurred, someone fixed it each
    time, and the history is what proves the cause is still unaddressed. What
    makes it worth surfacing is that it is unresolved AGAIN.
    """
    groups: dict[tuple[str, str], list[Occurrence]] = defaultdict(list)
    for o in occurrences:
        if not o.vendor or not o.vendor.strip():
            continue
        groups[pattern_key(o)].append(o)

    out: list[dict] = []
    for (vendor_key, _acct), items in groups.items():
        periods = sorted({o.period_end for o in items})
        if len(periods) < min_periods:
            continue
        unresolved = [o for o in items if o.status in _COUNTS_AS_UNRESOLVED]
        if not unresolved:
            continue

        # Display values from the most recent occurrence — a vendor's name
        # casing or the suggested account may have changed, and the newest one
        # is what the reviewer will recognise.
        latest = max(items, key=lambda o: o.period_end)
        total = sum((abs(o.amount) for o in items), Decimal("0"))
        out.append({
            "vendor": latest.vendor,
            "posted_account_name": latest.posted_account_name,
            "suggested_account_name": latest.suggested_account_name,
            "period_count": len(periods),
            "occurrence_count": len(items),
            "unresolved_count": len(unresolved),
            "first_seen": periods[0].isoformat(),
            "last_seen": periods[-1].isoformat(),
            "periods": [p.isoformat() for p in periods],
            "total_amount": str(total),
            "_sort": (len(periods), float(total)),
            "key": vendor_key,
        })

    # Most persistent first, then largest. A four-month pattern outranks a
    # three-month one whatever the money — recurrence is the finding here.
    out.sort(key=lambda r: r["_sort"], reverse=True)
    for r in out:
        r.pop("_sort")
    return out


def summarise(repeats: list[dict]) -> str | None:
    """One sentence for the rail, or None when there is nothing to say.

    Says how many patterns and how long the worst one has run, because "3
    repeat issues" is a number and "one vendor has been miscoded five months
    running" is a reason to go and look.
    """
    if not repeats:
        return None
    worst = repeats[0]
    n = len(repeats)
    lead = f"{n} recurring issue{'' if n == 1 else 's'}"
    return (
        f"{lead} — {worst['vendor']} has landed in "
        f"{worst['posted_account_name'] or 'the same account'} "
        f"{worst['period_count']} months running."
    )
