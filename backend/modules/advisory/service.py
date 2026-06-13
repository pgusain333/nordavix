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
_VALID_KEYS = {k["key"] for k in KPI_CATALOG}
_COMPARATORS = {"gte", "lte", "between"}
_REC_STATUSES = {"open", "in_progress", "done", "dismissed"}


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
    # Only the canonical calendar-month snapshot (period_start IS NULL) — the
    # custom-range snapshots compute P&L over arbitrary windows, so mixing them
    # in would compare a 7-day revenue against a full month. period_start NULL
    # also guarantees exactly one row per period_end (deterministic trend).
    rows = list((await db.execute(
        select(InsightsSnapshot)
        .where(
            InsightsSnapshot.period_end <= period_end,
            InsightsSnapshot.period_start.is_(None),
        )
        .order_by(desc(InsightsSnapshot.period_end))
        .limit(n)
    )).scalars().all())
    ordered = sorted(rows, key=lambda r: r.period_end)

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
        "status":        r.status,
        "client_action": r.client_action,
        "outcome_note":  r.outcome_note,
        "status_changed_at": r.status_changed_at.isoformat() if r.status_changed_at else None,
        "created_at":    r.created_at.isoformat() if r.created_at else None,
    }


async def list_recommendations(db, *, status: str | None = None) -> list[dict]:
    q = select(TrackedRecommendation).order_by(
        desc(TrackedRecommendation.period_end), desc(TrackedRecommendation.created_at),
    )
    if status:
        q = q.where(TrackedRecommendation.status == status)
    return [serialize_rec(r) for r in (await db.execute(q)).scalars().all()]


async def update_recommendation(db, rec_id, *, status=None, client_action=None,
                                outcome_note=None, user_id) -> dict | None:
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
    if client_action is not None:
        r.client_action = (client_action[:2000] or None)
    if outcome_note is not None:
        r.outcome_note = (outcome_note[:2000] or None)
    # Router writes the audit event and commits once (atomic with this change).
    await db.flush()
    return serialize_rec(r)


async def persist_exec_recommendations(db, tenant_id, period_end, recs: list[str]) -> int:
    """Upsert one TrackedRecommendation per AI exec-report recommendation, keyed
    on (tenant, period_end, title) so regenerating the report never duplicates
    and never clobbers a row's status/notes."""
    existing = {
        r.title for r in (await db.execute(
            select(TrackedRecommendation).where(
                TrackedRecommendation.period_end == period_end,
                TrackedRecommendation.source == "exec_report_ai",
            )
        )).scalars().all()
    }
    added = 0
    for rec in recs or []:
        title = (rec or "").strip()[:300]
        if not title or title in existing:
            continue
        db.add(TrackedRecommendation(
            id=uuid.uuid4(), tenant_id=tenant_id, period_end=period_end,
            source="exec_report_ai", priority="medium", title=title, status="open",
        ))
        existing.add(title)
        added += 1
    if added:
        await db.commit()
    return added
