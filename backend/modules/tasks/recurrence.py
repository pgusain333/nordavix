"""When a recurring manual task comes back.

Pure date arithmetic, deliberately kept out of the router so the rule can be
tested directly rather than through an endpoint.

THE RULE. A recurring task advances only when it is completed. Nothing runs on
a schedule and nothing back-fills: if September's task is still open in
November, there is one open task, not three. That matches how a close list is
actually worked — the point of the task is the work, and duplicating it while
the work is outstanding makes the list lie about how much is left.

THE ANCHOR. A close task is anchored to a PERIOD when it has one, and the
period is what advances (September → October); the due date follows by the same
number of months so a "10 days after period end" habit survives the roll. With
no period, the due date is the anchor and advances on its own. With neither
there is nothing to advance, so recurrence is refused at creation — a recurring
task that can't say when it next happens is a bug wearing a feature's clothes.
"""
from datetime import date

# NULL is one-time. These are the only other accepted values.
VALID_RECURRENCE = {"monthly", "quarterly", "annually"}

_MONTHS_PER = {"monthly": 1, "quarterly": 3, "annually": 12}


def months_for(recurrence: str | None) -> int | None:
    """How many months one step of `recurrence` advances. None if not recurring."""
    return _MONTHS_PER.get(recurrence or "")


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - date(year, month, 1)).days


def add_months(d: date, months: int) -> date:
    """`d` advanced by whole months, clamped to the target month's length.

    Jan 31 + 1 month is Feb 28 (or 29), not an error and not Mar 3. Clamping
    also means the step is not reversible, which is fine — a series only ever
    walks forward, one completion at a time.
    """
    total = (d.year * 12 + (d.month - 1)) + months
    year, month = divmod(total, 12)
    month += 1
    return date(year, month, min(d.day, _days_in_month(year, month)))


def is_month_end(d: date) -> bool:
    return d.day == _days_in_month(d.year, d.month)


def next_occurrence(
    recurrence: str | None,
    period_end: date | None,
    due_date: date | None,
) -> tuple[date | None, date | None] | None:
    """The (period_end, due_date) of the occurrence after this one.

    Returns None when the task does not recur, the recurrence is unrecognised,
    or there is no anchor to advance.
    """
    months = months_for(recurrence)
    if months is None:
        return None

    if period_end is not None:
        nxt = add_months(period_end, months)
        # A period end is a month end. Clamping Jan 31 → Feb 28 already lands
        # there, but an anchor of e.g. Feb 28 must roll to Mar 31, not Mar 28,
        # or a monthly series started in February drifts off month-end forever.
        if is_month_end(period_end):
            nxt = nxt.replace(day=_days_in_month(nxt.year, nxt.month))
        # The due date keeps its distance from the period end rather than being
        # re-derived, so an explicit override survives the roll.
        nxt_due = add_months(due_date, months) if due_date is not None else None
        return nxt, nxt_due

    if due_date is not None:
        return None, add_months(due_date, months)

    return None


def anchor_error(
    recurrence: str | None,
    period_end: date | None,
    due_date: date | None,
) -> str | None:
    """Why this task can't recur, or None if it can. Used to 400 at creation."""
    if recurrence is None:
        return None
    if recurrence not in VALID_RECURRENCE:
        return f"recurrence must be one of {', '.join(sorted(VALID_RECURRENCE))}."
    if period_end is None and due_date is None:
        return "A recurring task needs a period or a due date to repeat from."
    return None
