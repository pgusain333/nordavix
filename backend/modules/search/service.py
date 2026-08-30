"""Workspace search — one query across everything a person might be looking for.

The command palette has always been a route launcher: every entry ended in
`navigate(...)`, and there was no search endpoint behind it at all. In a
workspace holding thousands of accounts, findings, tasks and entries, typing
"AWS" or "1010 Operating Cash" returned a list of page names.

This is the other half. Seven sources, one ranked list, everything tenant-scoped
by the session's automatic filter — the palette never has to know which module
an answer lives in, which is the whole point of a palette.

Design notes that matter:

  * Each source is capped independently BEFORE ranking, so one noisy table (a
    thousand findings for one vendor) can't crowd out the single account row
    that was actually being looked for.
  * Ranking is a pure function on (label, sublabel, query) — extracted so it is
    testable without a database, and so the endpoint and the tests exercise the
    same rule rather than two similar ones.
  * Queries run sequentially. An AsyncSession is not safe for concurrent use,
    and the tables are small per tenant; the client debounces instead.
"""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass
from datetime import date

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import links

# Below this, a query matches most of the workspace and the result list is
# noise. One character is not an intent.
MIN_QUERY = 2
# Per-source cap, applied before ranking. See the module docstring.
PER_SOURCE = 6
DEFAULT_LIMIT = 20


@dataclass
class Hit:
    type: str            # account | finding | review | task | adjustment | schedule | period
    id: str
    label: str
    sublabel: str | None
    link: str
    score: int
    period_end: str | None = None


def rank(label: str, sublabel: str | None, q: str) -> int:
    """How well this row answers the query. 0 means don't show it.

    Deliberately coarse — four tiers, not a similarity score. A palette is read
    at a glance and the order only has to be defensible: what you typed the
    start of, then what contains it, then what it's filed under.

      4  the label starts with the query        "1010" -> "1010 Operating Cash"
      3  a word in the label starts with it     "cash" -> "1010 Operating Cash"
      2  the label contains it anywhere
      1  only the sublabel matches
      0  no match
    """
    needle = (q or "").strip().lower()
    if not needle:
        return 0
    lab = (label or "").lower()
    sub = (sublabel or "").lower()
    if lab.startswith(needle):
        return 4
    if any(w.startswith(needle) for w in lab.replace("-", " ").split()):
        return 3
    if needle in lab:
        return 2
    if needle and needle in sub:
        return 1
    return 0


def _like(q: str) -> str:
    """A contains-pattern with LIKE's own wildcards neutralised.

    Without this, a query containing % matches every row in the table and one
    containing _ matches a character the user didn't type — so searching for a
    literal "100%" would quietly return the whole ledger.
    """
    safe = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{safe}%"


def _keep(hits: list[Hit], label: str, sublabel: str | None, q: str, **kw) -> None:
    """Score a candidate and keep it if it matched at all."""
    s = rank(label, sublabel, q)
    if s > 0:
        hits.append(Hit(label=label, sublabel=sublabel, score=s, **kw))


async def _accounts(db: AsyncSession, q: str) -> list[Hit]:
    """The chart of accounts, from the most recent balance snapshot.

    Most recent only: the same account appears in every period's snapshot, and
    searching all of them would return the same account twelve times and push
    everything else off the list.
    """
    from models.gl_balance_snapshot import GlBalanceSnapshot

    latest = (await db.execute(
        select(GlBalanceSnapshot.period_end)
        .order_by(GlBalanceSnapshot.period_end.desc()).limit(1)
    )).scalar_one_or_none()
    if latest is None:
        return []
    rows = (await db.execute(
        select(
            GlBalanceSnapshot.qbo_account_id, GlBalanceSnapshot.account_name,
            GlBalanceSnapshot.account_number, GlBalanceSnapshot.account_type,
        )
        .where(
            GlBalanceSnapshot.period_end == latest,
            or_(
                GlBalanceSnapshot.account_name.ilike(_like(q)),
                GlBalanceSnapshot.account_number.ilike(_like(q)),
            ),
        )
        .limit(PER_SOURCE)
    )).all()
    hits: list[Hit] = []
    for qid, name, number, atype in rows:
        label = f"{number} {name}".strip() if number else (name or qid)
        _keep(hits, label, atype or "Account", q,
              type="account", id=str(qid),
              link=links.recon_account(latest, qid), period_end=latest.isoformat())
    return hits


async def _risk_findings(db: AsyncSession, q: str) -> list[Hit]:
    from models.gl_accuracy_finding import GlAccuracyFinding

    rows = (await db.execute(
        select(GlAccuracyFinding)
        .where(or_(
            GlAccuracyFinding.title.ilike(_like(q)),
            GlAccuracyFinding.vendor.ilike(_like(q)),
            GlAccuracyFinding.posted_account_name.ilike(_like(q)),
        ))
        .order_by(GlAccuracyFinding.period_end.desc())
        .limit(PER_SOURCE)
    )).scalars().all()
    hits: list[Hit] = []
    for f in rows:
        label = f.title or f"{f.vendor}: review"
        _keep(hits, label, f"Risk Radar · {f.period_end.strftime('%b %Y')}", q,
              type="finding", id=str(f.id),
              link=links.risk_radar(f.period_end), period_end=f.period_end.isoformat())
    return hits


async def _review_findings(db: AsyncSession, q: str) -> list[Hit]:
    from models.close_review import CloseReviewFinding

    rows = (await db.execute(
        select(CloseReviewFinding)
        .where(or_(
            CloseReviewFinding.title.ilike(_like(q)),
            CloseReviewFinding.account_label.ilike(_like(q)),
        ))
        .order_by(CloseReviewFinding.period_end.desc())
        .limit(PER_SOURCE)
    )).scalars().all()
    hits: list[Hit] = []
    for f in rows:
        _keep(hits, f.title, f"Close Review · {f.period_end.strftime('%b %Y')}", q,
              type="review", id=str(f.id),
              link=links.close_review(f.period_end),
              period_end=f.period_end.isoformat())
    return hits


async def _tasks(db: AsyncSession, q: str) -> list[Hit]:
    from models.task_action import TaskAction

    rows = (await db.execute(
        select(TaskAction)
        .where(or_(
            TaskAction.subject.ilike(_like(q)),
            TaskAction.description.ilike(_like(q)),
        ))
        .order_by(TaskAction.created_at.desc())
        .limit(PER_SOURCE)
    )).scalars().all()
    hits: list[Hit] = []
    for t in rows:
        label = t.subject or (t.description or "")[:80]
        if not label:
            continue
        done = t.completed_at is not None
        _keep(hits, label, "Task · done" if done else "Task", q,
              type="task", id=str(t.id), link=links.tasks(),
              period_end=t.period_end.isoformat() if t.period_end else None)
    return hits


async def _adjustments(db: AsyncSession, q: str) -> list[Hit]:
    from models.proposed_entry import ProposedEntry

    rows = (await db.execute(
        select(ProposedEntry)
        .where(or_(
            ProposedEntry.description.ilike(_like(q)),
            ProposedEntry.memo.ilike(_like(q)),
        ))
        .order_by(ProposedEntry.period_end.desc())
        .limit(PER_SOURCE)
    )).scalars().all()
    hits: list[Hit] = []
    for e in rows:
        _keep(hits, e.description, f"Adjustment · {e.status} · {e.period_end.strftime('%b %Y')}", q,
              type="adjustment", id=str(e.id), link=links.adjustments(),
              period_end=e.period_end.isoformat())
    return hits


# Schedule table -> the URL kind the schedules page expects.
_SCHEDULE_KINDS = (
    ("SchedulePrepaid", "prepaids", "Prepaid"),
    ("ScheduleAccrual", "accruals", "Accrual"),
    ("ScheduleFixedAsset", "fixed-assets", "Fixed asset"),
    ("ScheduleLease", "leases", "Lease"),
    ("ScheduleLoan", "loans", "Loan"),
)


async def _schedules(db: AsyncSession, q: str) -> list[Hit]:
    import models.schedule as S

    hits: list[Hit] = []
    for cls_name, kind, human in _SCHEDULE_KINDS:
        cls = getattr(S, cls_name, None)
        if cls is None:
            continue
        rows = (await db.execute(
            select(cls)
            .where(or_(
                cls.description.ilike(_like(q)),
                cls.vendor.ilike(_like(q)),
                cls.reference.ilike(_like(q)),
            ))
            .limit(PER_SOURCE)
        )).scalars().all()
        for r in rows:
            _keep(hits, r.description, f"{human} schedule" + (f" · {r.vendor}" if r.vendor else ""), q,
                  type="schedule", id=str(r.id), link=links.schedules(None, kind))
    return hits


_MONTHS = ("january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december")


async def _periods(db: AsyncSession, q: str) -> list[Hit]:
    """Months, by name or year — "july", "jul 2026", "2026".

    Matched in Python rather than SQL: a period is a formatted date, not a
    stored string, so there is nothing to ILIKE against.
    """
    from models.gl_balance_snapshot import GlBalanceSnapshot

    rows = (await db.execute(
        select(GlBalanceSnapshot.period_end)
        .distinct()
        .order_by(GlBalanceSnapshot.period_end.desc())
        .limit(24)
    )).scalars().all()
    needle = q.strip().lower()
    hits: list[Hit] = []
    for pe in rows:
        label = pe.strftime("%B %Y")
        # "jul" should find July: match the abbreviation as well as the name.
        abbr = pe.strftime("%b %Y").lower()
        month_name = _MONTHS[pe.month - 1]
        matched = (needle in label.lower() or needle in abbr
                   or month_name.startswith(needle) or needle == str(pe.year))
        if not matched:
            continue
        hits.append(Hit(type="period", id=pe.isoformat(), label=label,
                        sublabel="Period", link=links.dashboard(pe),
                        score=3, period_end=pe.isoformat()))
        if len(hits) >= PER_SOURCE:
            break
    return hits


_SOURCES = (_accounts, _risk_findings, _review_findings, _tasks,
            _adjustments, _schedules, _periods)


async def search(db: AsyncSession, tenant_id: uuid.UUID, q: str,
                 limit: int = DEFAULT_LIMIT) -> list[dict]:
    """Everything matching `q`, best first.

    One failing source must not take the whole palette down — a search that
    returns nothing because the schedules table hiccuped is worse than one that
    returns six results and quietly omits a seventh.
    """
    query = (q or "").strip()
    if len(query) < MIN_QUERY:
        return []
    hits: list[Hit] = []
    for source in _SOURCES:
        try:
            hits.extend(await source(db, query))
        except Exception:  # noqa: BLE001
            import logging
            logging.getLogger(__name__).exception("search source %s failed", source.__name__)
    # Best score first; then most recent, so "rent" surfaces this month's before
    # last year's. Rows with no period sort last within their score.
    hits.sort(key=lambda h: (-h.score, h.period_end or "", h.label), reverse=False)
    hits.sort(key=lambda h: (-h.score, _recency_key(h)))
    return [asdict(h) for h in hits[:limit]]


def _recency_key(h: Hit) -> str:
    """Descending by period, with undated rows last.

    An ISO date sorts lexically, so inverting it gives newest-first; the
    sentinel keeps undated rows (schedules, tasks with no period) below dated
    ones of the same score rather than above them.
    """
    return "0" + _invert_iso(h.period_end) if h.period_end else "1"


def _invert_iso(iso: str) -> str:
    """'2026-08-31' -> a string that sorts the reverse way."""
    return "".join(chr(ord("9") - int(c)) if c.isdigit() else c for c in iso)


def month_end_hint(d: date) -> str:
    return d.strftime("%b %Y")
