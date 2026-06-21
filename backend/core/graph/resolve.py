"""
Resolve knowledge-graph nodes (type, id) to human-readable views for the UI.

The graph stores edges between polymorphic (type, id) pairs; the "Related" panel
needs each endpoint shown as a real name ("1400 · Prepaid Expenses", not a
qbo_account_id). This batch-resolves nodes grouped by type (no N+1) and is
best-effort: an unresolvable node (e.g. a dangling edge whose row was deleted)
falls back to a generic label rather than disappearing or erroring.

Tenant scoping comes from the ambient request context (the SELECT auto-filter),
same as every other read.
"""
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.graph.service import Node
from models.gl_accuracy_finding import GlAccuracyFinding
from models.gl_balance_snapshot import GlBalanceSnapshot
from models.proposed_entry import ProposedEntry

_SCHEDULE_HUMAN = {
    "prepaid": "Prepaid",
    "accrual": "Accrual",
    "fixed_asset": "Fixed asset",
    "lease": "Lease",
    "loan": "Loan",
}


@dataclass
class NodeView:
    type: str
    id: str
    label: str
    sublabel: str | None = None
    href: str | None = None
    status: str | None = None

    def as_dict(self) -> dict:
        return {
            "type": self.type,
            "id": self.id,
            "label": self.label,
            "sublabel": self.sublabel,
            "href": self.href,
            "status": self.status,
        }


def _fmt_period(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%b %Y")
    except ValueError:
        return iso


async def resolve_nodes(db: AsyncSession, nodes: list[Node]) -> dict[tuple[str, str], NodeView]:
    """Map each (type, id) to a NodeView. Unknown/dangling nodes get a generic
    fallback so the panel degrades gracefully."""
    by_type: dict[str, set[str]] = {}
    for n in nodes:
        by_type.setdefault(n.type, set()).add(n.id)

    out: dict[tuple[str, str], NodeView] = {}

    # ── account: chart label from the GL snapshot (any period) ──────────────
    acct_ids = by_type.get("account") or set()
    if acct_ids:
        labels: dict[str, tuple[str | None, str | None]] = {}
        rows = (await db.execute(
            select(
                GlBalanceSnapshot.qbo_account_id,
                GlBalanceSnapshot.account_number,
                GlBalanceSnapshot.account_name,
            ).where(GlBalanceSnapshot.qbo_account_id.in_(acct_ids))
        )).all()
        for qid, num, name in rows:
            labels.setdefault(qid, (num, name))
        for qid in acct_ids:
            num, name = labels.get(qid, (None, None))
            label = f"{num} · {name}" if num and name else (name or f"Account {qid}")
            # account / reconciliation / period are context (the recon subject),
            # not navigation targets — only findings, entries, schedules link out.
            out[("account", qid)] = NodeView("account", qid, label, "Account")

    # ── journal_entry: ProposedEntry description + lifecycle status ──────────
    je_ids = by_type.get("journal_entry") or set()
    if je_ids:
        uuids = []
        for s in je_ids:
            try:
                uuids.append(uuid.UUID(s))
            except ValueError:
                continue
        if uuids:
            for pe in (await db.execute(
                select(ProposedEntry).where(ProposedEntry.id.in_(uuids))
            )).scalars():
                out[("journal_entry", str(pe.id))] = NodeView(
                    "journal_entry", str(pe.id),
                    pe.description or "Adjusting entry", "Journal entry",
                    href="/app/adjustments", status=pe.status,
                )
        for s in je_ids:
            out.setdefault(("journal_entry", s), NodeView(
                "journal_entry", s, "Adjusting entry", "Journal entry", href="/app/adjustments"))

    # ── finding: GlAccuracyFinding by stable finding_key (latest period) ─────
    f_keys = by_type.get("finding") or set()
    if f_keys:
        rows = (await db.execute(
            select(GlAccuracyFinding)
            .where(GlAccuracyFinding.finding_key.in_(f_keys))
            .order_by(GlAccuracyFinding.period_end.desc())
        )).scalars()
        for f in rows:
            key = ("finding", f.finding_key)
            if key in out:
                continue  # first (latest) wins
            label = f.title or (
                f"{f.vendor}: {f.posted_account_name} → {f.suggested_account_name}"
                if f.posted_account_name else (f.vendor or "GL accuracy finding")
            )
            out[key] = NodeView("finding", f.finding_key, label[:160], "Finding",
                                href="/app/gl-accuracy", status=f.status)
        for k in f_keys:
            out.setdefault(("finding", k), NodeView(
                "finding", k, "GL accuracy finding", "Finding", href="/app/gl-accuracy"))

    # ── schedule: parse the composite id "type:qid:period" ──────────────────
    for sid in by_type.get("schedule") or set():
        stype = sid.split(":", 1)[0]
        human = _SCHEDULE_HUMAN.get(stype, stype.replace("_", " ").title())
        out[("schedule", sid)] = NodeView("schedule", sid, f"{human} schedule",
                                          "Schedule", href="/app/schedules")

    # ── reconciliation: "qid:period" (the account label is the recon subject) ─
    for rid in by_type.get("reconciliation") or set():
        out[("reconciliation", rid)] = NodeView("reconciliation", rid, "Reconciliation",
                                                "Reconciliation")

    # ── period ──────────────────────────────────────────────────────────────
    for pid in by_type.get("period") or set():
        out[("period", pid)] = NodeView("period", pid, _fmt_period(pid), "Period")

    # ── flux_variance (generic — rarely surfaced in the recon context) ───────
    for vid in by_type.get("flux_variance") or set():
        out[("flux_variance", vid)] = NodeView("flux_variance", vid, "Flux variance",
                                               "Variance", href="/app/flux")

    return out
