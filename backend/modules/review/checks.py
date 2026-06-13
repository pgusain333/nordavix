"""
Close Review check battery — deterministic, pure, snapshot-based.

Each check reads already-loaded data off a ReviewContext and returns a list of
raw finding dicts (the engine persists them). No I/O here, so the battery is
fast and unit-testable. Anything needing a live QuickBooks pull (transaction-
level manual-JE anomalies: round-dollar, backdated, weekend) is intentionally
NOT here — that's the fast-follow, since txn-level data isn't persisted.

A finding dict has the shape of the CloseReviewFinding columns:
  code, category, severity, title, detail, recommended_action,
  qbo_account_id, account_label, entity_ref, link_hint
"""
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

# Severities
HIGH = "high"
REVIEW = "review"
INFO = "info"

_ZERO = Decimal("0")
_DOLLAR = Decimal("1.00")           # near-zero floor; matches RECON_TOLERANCE
_BANK_TYPES = {"Bank", "Credit Card"}
_SUSPENSE_KEYWORDS = ("ask my accountant", "suspense", "clearing", "uncategori")


def _dec(v) -> Decimal:
    try:
        return Decimal(str(v))
    except Exception:
        return _ZERO


def _label(account_number: str | None, account_name: str | None) -> str:
    return f"{account_number or ''} {account_name or ''}".strip() or "(unnamed account)"


def _f(code, category, severity, title, detail, *, action=None,
       qbo_account_id=None, account_label=None, entity_ref=None, link_hint=None) -> dict:
    return {
        "code": code, "category": category, "severity": severity,
        "title": title, "detail": detail, "recommended_action": action,
        "qbo_account_id": qbo_account_id, "account_label": account_label,
        "entity_ref": entity_ref, "link_hint": link_hint,
    }


@dataclass
class ReviewContext:
    period_end: date
    overview: dict                          # read_overview_from_snapshots payload
    review_status: dict                     # qbo_account_id -> {approved_at, subledger_entered_at, status}
    tb_balanced: bool | None
    tb_diff: Decimal | None
    cur: dict                               # qbo_account_id -> GlBalanceSnapshot (current period)
    prior_month: dict                       # qbo_account_id -> GlBalanceSnapshot
    prior_id_sets: list                     # list[set[qbo_account_id]] for prior periods (recency desc)
    flux: list = field(default_factory=list)        # [(Variance, Account, has_explanation: bool)]
    schedule_gaps: list = field(default_factory=list)  # precomputed schedule interest/amort gaps
    open_adjustments: int = 0               # count of open ProposedEntry for the period
    is_signed: dict = field(default_factory=dict)   # helper not currently used


# ── Reconciliation / control ──────────────────────────────────────────────────

def check_tb_balanced(ctx: ReviewContext) -> list[dict]:
    if ctx.tb_balanced is False:
        diff = ctx.tb_diff if ctx.tb_diff is not None else _ZERO
        return [_f(
            "control.tb_unbalanced", "control", HIGH,
            "Trial balance does not tie",
            f"The synced trial balance is out of balance by ${abs(diff):,.2f} (debits ≠ credits).",
            action="Re-sync from QuickBooks and resolve the imbalance before closing.",
            link_hint="sync",
        )]
    return []


def check_reconciliations(ctx: ReviewContext) -> list[dict]:
    from modules.recons.overview import is_reconciled
    out: list[dict] = []
    unapproved = 0
    total = 0
    for a in ctx.overview.get("accounts", []):
        total += 1
        qid = a.get("qbo_id")
        label = _label(a.get("account_number"), a.get("account_name"))
        gl = _dec(a.get("gl_balance"))
        sub = _dec(a.get("subledger_balance"))
        tied = is_reconciled(gl, sub)
        status = a.get("review_status")
        diff = gl - sub
        if status == "approved" and not tied:
            out.append(_f(
                "control.approved_not_tied", "control", HIGH,
                f"Approved but not tied — {label}",
                f"Signed off with a ${abs(diff):,.2f} unreconciled difference (GL ${gl:,.2f} vs subledger ${sub:,.2f}).",
                action="Re-open the reconciliation and resolve the difference, or document why it stands.",
                qbo_account_id=qid, account_label=label, link_hint="recon",
            ))
        elif not tied:
            out.append(_f(
                "control.not_reconciled", "control", REVIEW,
                f"Reconciliation not tied — {label}",
                f"GL ${gl:,.2f} vs subledger ${sub:,.2f} — off by ${abs(diff):,.2f}.",
                action="Investigate and reconcile before close.",
                qbo_account_id=qid, account_label=label, link_hint="recon",
            ))
        if status == "flagged":
            out.append(_f(
                "control.flagged", "control", REVIEW,
                f"Account flagged for attention — {label}",
                "A preparer flagged this account during reconciliation.",
                action="Review the flag and resolve before close.",
                qbo_account_id=qid, account_label=label, link_hint="recon",
            ))
        if status != "approved":
            unapproved += 1
    if unapproved and total:
        out.append(_f(
            "control.unapproved_rollup", "control", REVIEW,
            f"{unapproved} of {total} reconciliations not yet signed off",
            "These accounts still need reviewer approval before the period can close.",
            action="Approve the remaining reconciliations.",
            link_hint="recon",
        ))
    return out


def check_missing_evidence(ctx: ReviewContext) -> list[dict]:
    out: list[dict] = []
    for a in ctx.overview.get("accounts", []):
        if a.get("account_type") not in _BANK_TYPES:
            continue
        if int(a.get("evidence_count") or 0) > 0:
            continue
        label = _label(a.get("account_number"), a.get("account_name"))
        out.append(_f(
            "control.missing_evidence", "control", REVIEW,
            f"No statement on file — {label}",
            "This bank or credit-card account has no statement attached for the period.",
            action="Upload the statement, or request it from the client.",
            qbo_account_id=a.get("qbo_id"), account_label=label, link_hint="recon",
        ))
    return out


def check_stale_approvals(ctx: ReviewContext) -> list[dict]:
    """Approved before the underlying data last changed — time-based staleness
    (the recon module only detects variance-based staleness)."""
    out: list[dict] = []
    for a in ctx.overview.get("accounts", []):
        qid = a.get("qbo_id")
        rs = ctx.review_status.get(qid)
        if not rs:
            continue
        approved_at: datetime | None = rs.get("approved_at")
        if approved_at is None:
            continue
        snap = ctx.cur.get(qid)
        captured_at = getattr(snap, "captured_at", None)
        sub_at: datetime | None = rs.get("subledger_entered_at")
        changed = None
        if captured_at and captured_at > approved_at:
            changed = "the GL balance was re-synced"
        elif sub_at and sub_at > approved_at:
            changed = "the subledger was edited"
        if changed:
            label = _label(a.get("account_number"), a.get("account_name"))
            out.append(_f(
                "control.stale_approval", "control", REVIEW,
                f"Approval may be stale — {label}",
                f"This account was approved, but {changed} afterward. The sign-off predates the latest data.",
                action="Re-check the reconciliation and re-approve.",
                qbo_account_id=qid, account_label=label, link_hint="recon",
            ))
    return out


# ── Completeness ──────────────────────────────────────────────────────────────

def check_schedule_gaps(ctx: ReviewContext) -> list[dict]:
    out: list[dict] = []
    for g in ctx.schedule_gaps:
        label = g.get("account_label") or "(schedule account)"
        kind = g.get("schedule_type", "schedule")
        gap = _dec(g.get("gap"))
        sl = _dec(g.get("sl"))
        # The signal is a balance gap between the schedule and the GL — the
        # period's journal entry (interest + principal, or amortization) is
        # missing or incomplete. Keep the wording balance-based, not "interest",
        # since the loan-liability gap is driven by principal, not interest.
        out.append(_f(
            "completeness.schedule_gap", "completeness", HIGH,
            f"{kind.title()} schedule entry likely not booked — {label}",
            f"The {kind} schedule expects this account at ${abs(sl):,.2f}, but the GL is off by ${abs(gap):,.2f} — the period's journal entry looks missing or incomplete.",
            action="Book the proposed schedule journal entry in QuickBooks.",
            qbo_account_id=g.get("qbo_account_id"), account_label=label,
            entity_ref=g.get("schedule_id"), link_hint="schedules",
        ))
    return out


def check_open_adjustments(ctx: ReviewContext) -> list[dict]:
    if ctx.open_adjustments > 0:
        n = ctx.open_adjustments
        return [_f(
            "completeness.open_adjustments", "completeness", REVIEW,
            f"{n} proposed adjustment{'s' if n != 1 else ''} not yet posted",
            "AI-drafted adjusting entries are waiting in the Adjustments queue and have not been booked.",
            action="Review the queue and post or dismiss each entry.",
            link_hint="adjustments",
        )]
    return []


# ── Analytical review ─────────────────────────────────────────────────────────

def check_flux_unexplained(ctx: ReviewContext) -> list[dict]:
    out: list[dict] = []
    for var, acct, has_expl in ctx.flux:
        if not getattr(var, "is_material", False) or has_expl:
            continue
        label = _label(getattr(acct, "account_number", None), getattr(acct, "account_name", None))
        dv = _dec(getattr(var, "dollar_variance", 0))
        pct = getattr(var, "pct_variance", None)
        pct_txt = f" ({float(pct):+.0f}%)" if pct is not None else ""
        out.append(_f(
            "analytical.flux_unexplained", "analytical", REVIEW,
            f"Material variance with no explanation — {label}",
            f"Moved ${dv:+,.2f}{pct_txt} versus the prior period, with no flux commentary on file.",
            action="Add commentary or investigate the driver.",
            qbo_account_id=getattr(acct, "qbo_account_id", None), account_label=label,
            entity_ref=str(getattr(var, "id", "")), link_hint="flux",
        ))
    return out


def check_balance_anomalies(ctx: ReviewContext) -> list[dict]:
    """Sign flips, new accounts, and dropped recurring accounts vs prior periods."""
    out: list[dict] = []
    cur_ids = set(ctx.cur.keys())

    for qid, snap in ctx.cur.items():
        cur_bal = _dec(getattr(snap, "balance", 0))
        label = _label(getattr(snap, "account_number", None), getattr(snap, "account_name", None))
        prior = ctx.prior_month.get(qid)
        # New account this period (no prior-month row, non-trivial balance).
        if prior is None and abs(cur_bal) > _DOLLAR and ctx.prior_month:
            out.append(_f(
                "analytical.new_account", "analytical", INFO,
                f"New account this period — {label}",
                f"This account did not exist last period and now carries ${cur_bal:,.2f}.",
                action="Confirm the new account is expected and correctly classified.",
                qbo_account_id=qid, account_label=label, link_hint="recon",
            ))
            continue
        if prior is not None:
            pb = _dec(getattr(prior, "balance", 0))
            if abs(pb) > _DOLLAR and abs(cur_bal) > _DOLLAR and (pb > 0) != (cur_bal > 0):
                out.append(_f(
                    "analytical.sign_flip", "analytical", REVIEW,
                    f"Balance flipped sign — {label}",
                    f"Went from ${pb:,.2f} to ${cur_bal:,.2f} since last period.",
                    action="Confirm the sign change is correct (e.g. an account drawn negative).",
                    qbo_account_id=qid, account_label=label, link_hint="recon",
                ))

    # Dropped recurring account: present in ALL prior periods (need >= 2), gone now.
    if len(ctx.prior_id_sets) >= 2:
        recurring = set.intersection(*ctx.prior_id_sets)
        for qid in recurring - cur_ids:
            snap = ctx.prior_month.get(qid)   # best available label source
            label = _label(getattr(snap, "account_number", None), getattr(snap, "account_name", None)) if snap else qid
            out.append(_f(
                "analytical.dropped_recurring", "analytical", REVIEW,
                f"Recurring account missing this period — {label}",
                "This account had activity every prior month but has none this period — a recurring entry may have been missed.",
                action="Confirm the recurring entry (e.g. rent, depreciation) was booked.",
                qbo_account_id=qid, account_label=label, link_hint="recon",
            ))
    return out


# ── Hygiene ───────────────────────────────────────────────────────────────────

def check_suspense(ctx: ReviewContext) -> list[dict]:
    out: list[dict] = []
    for qid, snap in ctx.cur.items():
        name = (getattr(snap, "account_name", "") or "").lower()
        if not any(k in name for k in _SUSPENSE_KEYWORDS):
            continue
        bal = _dec(getattr(snap, "balance", 0))
        if abs(bal) <= _DOLLAR:
            continue
        label = _label(getattr(snap, "account_number", None), getattr(snap, "account_name", None))
        out.append(_f(
            "hygiene.suspense_balance", "hygiene", HIGH,
            f"Suspense account holds a balance — {label}",
            f"${abs(bal):,.2f} is sitting unallocated in a suspense / clearing account at period end.",
            action="Reclassify the balance to its proper accounts before close.",
            qbo_account_id=qid, account_label=label, link_hint="recon",
        ))
    return out


# ── Runner ────────────────────────────────────────────────────────────────────

_CHECKS = [
    check_tb_balanced,
    check_reconciliations,
    check_missing_evidence,
    check_stale_approvals,
    check_schedule_gaps,
    check_open_adjustments,
    check_flux_unexplained,
    check_balance_anomalies,
    check_suspense,
]


def run_all_checks(ctx: ReviewContext) -> tuple[list[dict], list[str], int]:
    """Returns (findings, passed_reassurance_strings, checks_run)."""
    findings: list[dict] = []
    for check in _CHECKS:
        try:
            findings.extend(check(ctx))
        except Exception:
            # A single check failing must never sink the whole review.
            import logging
            logging.getLogger(__name__).exception("Close Review check %s failed", check.__name__)

    codes = {f["code"] for f in findings}
    passed: list[str] = []
    if ctx.tb_balanced is True:
        passed.append("Trial balance ties")
    if "control.not_reconciled" not in codes and "control.approved_not_tied" not in codes and ctx.overview.get("accounts"):
        passed.append("All accounts reconcile")
    if "control.missing_evidence" not in codes:
        passed.append("Bank evidence on file")
    if "completeness.schedule_gap" not in codes and ctx.schedule_gaps == []:
        passed.append("Schedules booked")
    if "hygiene.suspense_balance" not in codes:
        passed.append("No stray suspense balances")

    return findings, passed, len(_CHECKS)
