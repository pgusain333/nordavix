"""
Longitudinal advisory — KPI trends vs firm-set targets + tracked recommendations.

KPI trends read the CACHED InsightsSnapshot.payload across periods (no live QBO
calls — compute_overview is expensive and hits QBO, so we never fan it out).
Targets grade each KPI met/missed. Tracked recommendations turn the exec
report's ephemeral advice into a status-tracked workflow ("advised X; did Y").
"""
import logging
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import delete as sa_delete
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.advisory import KpiTarget, TrackedRecommendation
from models.insights_snapshot import InsightsSnapshot

logger = logging.getLogger(__name__)

# Canonical KPI catalog. section/field address the cached insights payload
# (confirmed keys in modules/insights/service.py). higher_better drives both
# the trend arrow and the default target comparator.
KPI_CATALOG: list[dict] = [
    {"key": "runway_months",    "label": "Cash runway",            "section": "liquidity",     "field": "runway_months",    "unit": "months", "higher_better": True},
    {"key": "cash_balance",     "label": "Cash on hand",           "section": "liquidity",     "field": "cash_balance",     "unit": "$",      "higher_better": True},
    {"key": "current_ratio",    "label": "Current ratio",          "section": "liquidity",     "field": "current_ratio",    "unit": "x",      "higher_better": True},
    {"key": "gross_margin_pct", "label": "Gross margin",           "section": "profitability", "field": "gross_margin_pct", "unit": "%",      "higher_better": True},
    {"key": "net_margin_pct",   "label": "Net margin",             "section": "profitability", "field": "net_margin_pct",   "unit": "%",      "higher_better": True},
    {"key": "revenue",          "label": "Revenue",                "section": "profitability", "field": "revenue",          "unit": "$",      "higher_better": True},
    {"key": "net_income",       "label": "Net income",             "section": "profitability", "field": "net_income",       "unit": "$",      "higher_better": True},
    {"key": "dso",              "label": "Days sales outstanding", "section": "receivables",   "field": "dso_days",         "unit": "days",   "higher_better": False},
]
KPI_BY_KEY = {k["key"]: k for k in KPI_CATALOG}
_VALID_KEYS = set(KPI_BY_KEY)
_COMPARATORS = {"gte", "lte", "between"}
_REC_STATUSES = {"open", "in_progress", "done", "dismissed"}
_PRIORITIES = {"high", "medium", "low"}

# How far a metric must move off its baseline before the movement is called
# anything. Relative, because these KPIs are not in the same units — two
# percent of a current ratio and two percent of cash are different sizes of
# fact, and a fixed threshold would call one noisy and the other frozen.
MOVE_TOLERANCE = 0.02


def grade_progress(
    *, baseline: float | None, current: float | None,
    target: float | None, higher_better: bool,
) -> str:
    """Has the metric this advice was meant to move actually moved?

    The whole point of the module, and the one thing it could not previously
    say. Five answers, and the boring ones matter most:

      "achieved"   the target was set and the metric has reached it.
      "working"    moving the right way by more than MOVE_TOLERANCE.
      "worsening"  moving the wrong way by more than that. Advice that made
                   things worse is the most valuable row on the page and it is
                   never going to be shown if the grader rounds it to "flat".
      "flat"       inside the tolerance. Not a failure — most advice takes a
                   period or two — but not progress either, and it says so.
      "unknown"    no baseline or no current reading. Recommendations written
                   before the metric was ever captured land here, and honestly
                   reporting that is better than grading against a number
                   nobody set.

    `higher_better` comes from KPI_CATALOG, so direction is a property of the
    metric rather than a guess: rising DSO is worse, rising runway is better,
    and the caller never has to know which.

    Pure, so the judgement can be argued with instead of trusted.
    """
    if baseline is None or current is None:
        return "unknown"

    if target is not None:
        reached = current >= target if higher_better else current <= target
        if reached:
            return "achieved"

    delta = current - baseline
    improvement = delta if higher_better else -delta
    # Scale the tolerance to the baseline. A baseline at (or near) zero has no
    # meaningful percentage, so any real movement counts.
    floor = abs(baseline) * MOVE_TOLERANCE
    if floor == 0:
        return "working" if improvement > 0 else "worsening" if improvement < 0 else "flat"
    if improvement > floor:
        return "working"
    if improvement < -floor:
        return "worsening"
    return "flat"


def progress_for(rec, series: list[dict]) -> dict:
    """A recommendation's grade, plus the readings behind it.

    `series` is the KPI's own history from kpi_overview — the same points the
    chart draws, so the grade and the line can never tell different stories.
    Only readings AT OR AFTER the baseline count: a recommendation cannot claim
    credit for a month that happened before anyone gave the advice.
    """
    spec = KPI_BY_KEY.get(rec.kpi_key or "")
    if spec is None:
        return {"grade": "unlinked", "since": [], "current": None}

    baseline_day = rec.baseline_at.date() if rec.baseline_at else rec.period_end
    since = [p for p in series if date.fromisoformat(p["period"]) >= baseline_day]
    current = since[-1]["value"] if since else None
    baseline = float(rec.baseline_value) if rec.baseline_value is not None else None
    target = float(rec.target_value) if rec.target_value is not None else None

    return {
        "grade": grade_progress(
            baseline=baseline, current=current, target=target,
            higher_better=spec["higher_better"],
        ),
        "since": since,
        "current": current,
        "unit": spec["unit"],
        "kpi_label": spec["label"],
        "higher_better": spec["higher_better"],
    }


def _num(v) -> float | None:
    """Coerce a payload value to float, tolerating money/percent strings the
    insights blob may store (e.g. '$1,234.00', '(500)', '12.5%')."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").replace("$", "").replace("%", "")
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        f = float(s)
        return -f if neg else f
    except ValueError:
        return None


def _extract(payload: dict, spec: dict) -> float | None:
    section = payload.get(spec["section"]) if isinstance(payload, dict) else None
    if not isinstance(section, dict):
        return None
    return _num(section.get(spec["field"]))


def _grade(value: float, target: KpiTarget) -> str:
    tv = float(target.target_value)
    if target.comparator == "lte":
        return "met" if value <= tv else "missed"
    if target.comparator == "between":
        up = float(target.target_value_upper) if target.target_value_upper is not None else tv
        lo, hi = min(tv, up), max(tv, up)
        return "met" if lo <= value <= hi else "missed"
    return "met" if value >= tv else "missed"   # gte (default)


async def kpi_overview(db: AsyncSession, tenant_id, period_end: date, n: int = 6) -> dict:
    # The trend is one point per CALENDAR MONTH. A "monthly" snapshot is one
    # whose window spans a full month: period_start is the 1st of the period_end's
    # month (how Insights "Month mode" saves them today) OR NULL (legacy snapshots
    # saved before Month mode began sending period_start). Custom date-range
    # snapshots (an arbitrary period_start) are excluded so we never compare, say,
    # a 10-day revenue against a full month. Among multiple snapshots for the same
    # month we keep the freshest (most recently computed). We fetch recent rows
    # and reduce to the newest n months. (Tenant snapshot counts are small, so a
    # broad fetch + in-Python reduce is cheaper than per-month SQL date math.)
    rows = list((await db.execute(
        select(InsightsSnapshot)
        .where(InsightsSnapshot.period_end <= period_end)
        .order_by(desc(InsightsSnapshot.period_end), desc(InsightsSnapshot.computed_at))
    )).scalars().all())

    # Drop any snapshot that no longer describes the period it was computed
    # from. The Insights read path recomputes a stale month when someone opens
    # it, but a KPI trend reads these rows directly and would otherwise plot a
    # month at figures superseded by a later re-sync — a wrong line on a chart
    # a partner reads, with nothing to say so. A month that has gone stale and
    # not been re-opened is omitted rather than drawn.
    from models.period_sync import PeriodSync
    from modules.insights.service import cache_is_fresh

    sync_by_pe = {
        ps.period_end: (ps.synced_at.isoformat() if ps.synced_at else None)
        for ps in (await db.execute(
            select(PeriodSync).where(PeriodSync.period_end <= period_end)
        )).scalars().all()
    }
    rows = [
        r for r in rows
        if r.period_end not in sync_by_pe
        or cache_is_fresh(dict(r.payload or {}), sync_by_pe[r.period_end])
    ]

    def _is_full_month(r: InsightsSnapshot) -> bool:
        if r.period_start is None:
            return True
        return r.period_start == date(r.period_end.year, r.period_end.month, 1)

    seen: set[tuple[int, int]] = set()
    monthly: list[InsightsSnapshot] = []
    for r in rows:  # newest first (period_end desc, then computed_at desc)
        if not _is_full_month(r):
            continue
        month_key = (r.period_end.year, r.period_end.month)
        if month_key in seen:
            continue
        seen.add(month_key)
        monthly.append(r)
        if len(monthly) >= n:
            break
    ordered = sorted(monthly, key=lambda r: r.period_end)

    targets = {t.kpi_key: t for t in (await db.execute(select(KpiTarget))).scalars().all()}

    kpis: list[dict] = []
    for spec in KPI_CATALOG:
        series = []
        for r in ordered:
            val = _extract(r.payload or {}, spec)
            if val is not None:
                series.append({
                    "period": r.period_end.isoformat(),
                    "label":  r.period_end.strftime("%b %y"),
                    "value":  val,
                })
        current = series[-1]["value"] if series else None
        prior = series[-2]["value"] if len(series) >= 2 else None
        t = targets.get(spec["key"])
        status = _grade(current, t) if (t is not None and current is not None) else None
        kpis.append({
            "key": spec["key"], "label": spec["label"], "unit": spec["unit"],
            "higher_better": spec["higher_better"],
            "current": current, "prior": prior, "series": series,
            "target": None if t is None else {
                "comparator":  t.comparator,
                "value":       float(t.target_value),
                "value_upper": float(t.target_value_upper) if t.target_value_upper is not None else None,
                "note":        t.note,
            },
            "status": status,
        })
    return {
        "period_end": period_end.isoformat(),
        "kpis": kpis,
        "periods": [r.period_end.isoformat() for r in ordered],
    }


def serialize_target(t: KpiTarget) -> dict:
    return {
        "kpi_key": t.kpi_key, "comparator": t.comparator,
        "value": float(t.target_value),
        "value_upper": float(t.target_value_upper) if t.target_value_upper is not None else None,
        "note": t.note,
    }


async def upsert_target(db, tenant_id, kpi_key, comparator, value, value_upper, note, user_id) -> KpiTarget:
    if kpi_key not in _VALID_KEYS:
        raise ValueError("Unknown KPI.")
    if comparator not in _COMPARATORS:
        raise ValueError("comparator must be gte, lte, or between.")
    t = (await db.execute(select(KpiTarget).where(KpiTarget.kpi_key == kpi_key))).scalar_one_or_none()
    if t is None:
        t = KpiTarget(id=uuid.uuid4(), tenant_id=tenant_id, kpi_key=kpi_key)
        db.add(t)
    t.comparator = comparator
    t.target_value = value
    t.target_value_upper = value_upper if comparator == "between" else None
    t.note = (note or None)
    t.updated_by = user_id
    # NOTE: no commit here — the router writes the audit event and commits once
    # so the target change and its audit row land in the same transaction.
    await db.flush()
    await db.refresh(t)
    return t


async def delete_target(db, tenant_id, kpi_key) -> None:
    await db.execute(sa_delete(KpiTarget).where(
        KpiTarget.tenant_id == tenant_id, KpiTarget.kpi_key == kpi_key,
    ))
    # Router commits (with the audit event) in the same transaction.


def serialize_rec(r: TrackedRecommendation) -> dict:
    return {
        "id":            str(r.id),
        "period_end":    r.period_end.isoformat(),
        "period_label":  r.period_end.strftime("%b %Y"),
        "source":        r.source,
        "priority":      r.priority,
        "title":         r.title,
        "detail":        r.detail,
        "kpi_key":       r.kpi_key,
        "kpi_label":     (KPI_BY_KEY.get(r.kpi_key or "") or {}).get("label"),
        "baseline_value": float(r.baseline_value) if r.baseline_value is not None else None,
        "baseline_at":   r.baseline_at.isoformat() if r.baseline_at else None,
        "target_value":  float(r.target_value) if r.target_value is not None else None,
        "due_date":      r.due_date.isoformat() if r.due_date else None,
        "expected_impact": float(r.expected_impact) if r.expected_impact is not None else None,
        "impact_note":   r.impact_note,
        "owner":         r.owner,
        "status":        r.status,
        "client_action": r.client_action,
        "outcome_note":  r.outcome_note,
        "status_changed_at": r.status_changed_at.isoformat() if r.status_changed_at else None,
        "created_at":    r.created_at.isoformat() if r.created_at else None,
    }


async def list_recommendations(
    db, *, status: str | None = None, period_end: date | None = None,
) -> list[dict]:
    """Every recommendation, each carrying its own grade.

    The grade is computed here rather than stored, from the same KPI series the
    trend chart draws — so a recommendation's verdict and the line above it can
    never disagree. One kpi_overview call feeds all of them.
    """
    q = select(TrackedRecommendation).order_by(
        desc(TrackedRecommendation.period_end), desc(TrackedRecommendation.created_at),
    )
    if status:
        q = q.where(TrackedRecommendation.status == status)
    rows = list((await db.execute(q)).scalars().all())
    if not rows:
        return []

    latest = period_end or max(r.period_end for r in rows)
    overview = await kpi_overview(db, None, latest, n=24)
    series_by_key = {k["key"]: k["series"] for k in overview["kpis"]}

    return [
        {**serialize_rec(r), "progress": progress_for(r, series_by_key.get(r.kpi_key or "", []))}
        for r in rows
    ]


async def create_recommendation(
    db, tenant_id, *, period_end: date, title: str, detail: str | None,
    kpi_key: str | None, priority: str, target_value: float | None,
    due_date: date | None, expected_impact: float | None,
    impact_note: str | None, owner: str | None,
) -> TrackedRecommendation:
    """Advice a human is giving — the path that did not exist.

    `source` declared three values and only exec_report_ai was reachable, so
    the module could hold what the AI said in a monthly report and nothing a
    partner noticed in a meeting. That is backwards: the best advice in the
    building is in someone's head.

    The baseline is captured HERE, at the moment of advising, by reading the
    metric's current value. That reading is what every later grade is measured
    from, so it has to be taken now — not reconstructed afterwards from a
    series that may since have been re-synced.
    """
    if kpi_key and kpi_key not in _VALID_KEYS:
        raise ValueError("Unknown KPI.")
    if priority not in _PRIORITIES:
        raise ValueError("priority must be high, medium or low.")
    title = (title or "").strip()
    if not title:
        raise ValueError("A recommendation needs a title.")

    baseline = await _current_kpi_value(db, kpi_key, period_end) if kpi_key else None
    rec = TrackedRecommendation(
        id=uuid.uuid4(), tenant_id=tenant_id, period_end=period_end,
        source="manual", priority=priority, title=title[:300],
        detail=(detail or None), kpi_key=kpi_key or None,
        baseline_value=baseline,
        baseline_at=datetime.now(UTC) if baseline is not None else None,
        target_value=target_value, due_date=due_date,
        expected_impact=expected_impact, impact_note=(impact_note or None)[:300] if impact_note else None,
        owner=(owner or None), status="open",
    )
    db.add(rec)
    await db.flush()
    await db.refresh(rec)
    return rec


async def _current_kpi_value(db, kpi_key: str, period_end: date) -> float | None:
    """The metric's latest reading at the moment advice is given."""
    if kpi_key not in _VALID_KEYS:
        return None
    overview = await kpi_overview(db, None, period_end, n=2)
    for k in overview["kpis"]:
        if k["key"] == kpi_key:
            return k["current"]
    return None


async def scorecard(db, period_end: date) -> dict:
    """What the firm's advice has been worth.

    The argument for an advisory fee, assembled from the client's own numbers
    rather than asserted. Counts only what can be counted: a recommendation
    with no metric attached is reported as unlinked instead of being quietly
    dropped from the denominator, because a scorecard that omits its own
    ungradable rows flatters itself.
    """
    recs = await list_recommendations(db, period_end=period_end)
    grades: dict[str, int] = {}
    impact_realised = 0.0
    for r in recs:
        g = r["progress"]["grade"]
        grades[g] = grades.get(g, 0) + 1
        if g in ("achieved", "working") and r.get("expected_impact"):
            impact_realised += float(r["expected_impact"])

    acted_on = sum(1 for r in recs if r["status"] in ("in_progress", "done"))
    graded = sum(v for k, v in grades.items() if k in ("achieved", "working", "flat", "worsening"))
    return {
        "period_end": period_end.isoformat(),
        "total": len(recs),
        "acted_on": acted_on,
        "graded": graded,
        "unlinked": grades.get("unlinked", 0) + grades.get("unknown", 0),
        "by_grade": grades,
        # The money attached to advice that is landing. Deliberately NOT
        # "value delivered": these are the impacts the firm estimated when it
        # advised, on the items that are moving — an expectation being met, not
        # a measured saving. The label has to say that.
        "impact_in_motion": round(impact_realised, 2),
    }


async def update_recommendation(db, rec_id, *, status=None, client_action=None,
                                outcome_note=None, priority=None, owner=None,
                                target_value=None, due_date=None, user_id) -> dict | None:
    r = (await db.execute(
        select(TrackedRecommendation).where(TrackedRecommendation.id == rec_id)
    )).scalar_one_or_none()
    if r is None:
        return None
    if status is not None:
        if status not in _REC_STATUSES:
            raise ValueError("Invalid status.")
        r.status = status
        r.status_changed_by = user_id
        r.status_changed_at = datetime.now(UTC)
    # Priority was hardcoded "medium" on every row and nothing could change it,
    # so the page told every reader "medium priority" forever.
    if priority is not None:
        if priority not in _PRIORITIES:
            raise ValueError("priority must be high, medium or low.")
        r.priority = priority
    if owner is not None:
        r.owner = (owner.strip()[:120] or None)
    if target_value is not None:
        r.target_value = target_value
    if due_date is not None:
        r.due_date = due_date
    if client_action is not None:
        r.client_action = (client_action[:2000] or None)
    if outcome_note is not None:
        r.outcome_note = (outcome_note[:2000] or None)
    # Router writes the audit event and commits once (atomic with this change).
    await db.flush()
    return serialize_rec(r)


def normalize_rec_spec(raw) -> dict | None:
    """One AI recommendation, whatever shape it arrived in.

    The model is now asked for objects — a title, the metric it moves, a
    priority, the money it is worth. It used to be asked for a sentence, and
    plenty of sentences are already cached, so both shapes have to parse or a
    contract change would silently blank a month of advice.

    A kpi_key outside KPI_CATALOG is DROPPED rather than stored. The point of
    constraining the model to the catalog is that the link can be trusted; a
    key nothing can resolve would grade against nothing while looking linked.
    """
    if isinstance(raw, str):
        title = raw.strip()
        return {"title": title[:300]} if title else None
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or "").strip()
    if not title:
        return None

    key = str(raw.get("kpi_key") or "").strip()
    priority = str(raw.get("priority") or "").strip().lower()
    impact = _num(raw.get("expected_impact"))
    return {
        "title": title[:300],
        "detail": (str(raw.get("detail")).strip() or None) if raw.get("detail") else None,
        "kpi_key": key if key in _VALID_KEYS else None,
        "priority": priority if priority in _PRIORITIES else "medium",
        "expected_impact": impact,
        "impact_note": (str(raw.get("impact_note")).strip()[:300] or None)
                       if raw.get("impact_note") else None,
    }


async def persist_exec_recommendations(db, tenant_id, period_end, recs: list) -> int:
    """Upsert one TrackedRecommendation per AI exec-report recommendation, keyed
    on (tenant, period_end, title) so regenerating the report never duplicates
    and never clobbers a row's status/notes.

    Accepts the structured specs the model now returns, or bare strings from an
    older cached narrative. Where a spec names a KPI, the metric's value is read
    NOW and stored as the baseline — that reading is what every later grade is
    measured against, so it has to be taken at the moment of advising.
    """
    existing = {
        r.title for r in (await db.execute(
            select(TrackedRecommendation).where(
                TrackedRecommendation.period_end == period_end,
                TrackedRecommendation.source == "exec_report_ai",
            )
        )).scalars().all()
    }
    specs = [s for s in (normalize_rec_spec(r) for r in (recs or [])) if s]
    # One overview for the whole batch rather than one read per recommendation.
    baselines: dict[str, float | None] = {}
    keys = {s["kpi_key"] for s in specs if s.get("kpi_key")}
    if keys:
        overview = await kpi_overview(db, tenant_id, period_end, n=2)
        baselines = {k["key"]: k["current"] for k in overview["kpis"]}

    added = 0
    now = datetime.now(UTC)
    for spec in specs:
        title = spec["title"]
        if title in existing:
            continue
        key = spec.get("kpi_key")
        base = baselines.get(key) if key else None
        db.add(TrackedRecommendation(
            id=uuid.uuid4(), tenant_id=tenant_id, period_end=period_end,
            source="exec_report_ai", priority=spec.get("priority") or "medium",
            title=title, detail=spec.get("detail"), kpi_key=key,
            baseline_value=base, baseline_at=now if base is not None else None,
            expected_impact=spec.get("expected_impact"),
            impact_note=spec.get("impact_note"), status="open",
        ))
        existing.add(title)
        added += 1
    if added:
        await db.commit()
    return added
