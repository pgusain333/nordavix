"""
Seed the read-only "sample company" demo tenant — Northwind Trading Co.

Idempotent: deletes any existing demo data and re-inserts, keyed on the fixed
`settings.demo_clerk_org_id`. The tenancy middleware serves this tenant
read-only when a request carries `X-Nordavix-Demo: 1`.

Run once after deploy (safe to re-run):
    fly ssh console -C "python scripts/seed_demo.py"

What it builds:
  - Tenant (is_demo=True, books seeded) + an admin User + a QboConnection
  - 12 trailing month-ends of GlBalanceSnapshot (~20 accounts, every type),
    each period a balanced trial balance (retained earnings is the plug)
  - PeriodSync per period (AR/AP aging = AR/AP GL magnitude → recons tie out)
  - AccountReviewStatus for the latest period (mostly approved, a couple in
    progress, AI commentary on two)
  - One flux TrialBalance + Accounts + Variances (with AI commentary + Narrative)
The Financial Package (IS/BS/CF) and Insights build automatically from the
GL snapshots — no extra seed needed.
"""
from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import delete, select

from core.config import settings
from core.db.base import current_tenant_id
from core.db.session import AsyncSessionLocal
from models.account import Account
from models.account_review_status import AccountReviewStatus
from models.gl_balance_snapshot import GlBalanceSnapshot
from models.narrative import Narrative
from models.period_sync import PeriodSync
from models.qbo_connection import QboConnection
from models.tenant import Tenant
from models.trial_balance import TrialBalance
from models.user import User
from models.variance import Variance

# Deterministic ids so re-runs replace cleanly. (Fixed, valid namespace UUID.)
_NS = uuid.uuid5(uuid.NAMESPACE_URL, "nordavix-sample-company-demo")
def _id(key: str) -> uuid.UUID:
    return uuid.uuid5(_NS, key)

DEMO_TENANT_ID = _id("tenant")
DEMO_USER_ID   = _id("user")
N_PERIODS = 12


def _q2(d: Decimal) -> Decimal:
    return d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _month_ends(n: int) -> list[date]:
    """Most-recent-first list of the last `n` completed month-ends."""
    today = date.today()
    y, m = today.year, today.month
    out: list[date] = []
    for i in range(n):
        mm, yy = m - 1 - i, y
        while mm <= 0:
            mm += 12
            yy -= 1
        first_next = date(yy + 1, 1, 1) if mm == 12 else date(yy, mm + 1, 1)
        out.append(first_next - timedelta(days=1))
    return out


# qbo_id, number, name, qbo_type, fs_category, fs_line, base signed balance (debit +)
ACCOUNTS: list[tuple[str, str, str, str, str, str, Decimal]] = [
    ("1",  "1010", "Operating Cash",        "Bank",                   "Assets",      "Current Assets",      Decimal("182500")),
    ("2",  "1020", "Payroll Cash",          "Bank",                   "Assets",      "Current Assets",      Decimal("24800")),
    ("3",  "1200", "Accounts Receivable",   "Accounts Receivable",    "Assets",      "Current Assets",      Decimal("241300")),
    ("4",  "1300", "Inventory",             "Other Current Asset",    "Assets",      "Current Assets",      Decimal("318900")),
    ("5",  "1400", "Prepaid Expenses",      "Other Current Asset",    "Assets",      "Current Assets",      Decimal("17600")),
    ("6",  "1500", "Equipment",             "Fixed Asset",            "Assets",      "Fixed Assets",        Decimal("150000")),
    ("7",  "1510", "Accumulated Depreciation","Fixed Asset",          "Assets",      "Fixed Assets",        Decimal("-46500")),
    ("8",  "2000", "Accounts Payable",      "Accounts Payable",       "Liabilities", "Current Liabilities", Decimal("-158200")),
    ("9",  "2100", "Company Credit Card",   "Credit Card",            "Liabilities", "Current Liabilities", Decimal("-11400")),
    ("10", "2200", "Accrued Liabilities",   "Other Current Liability","Liabilities", "Current Liabilities", Decimal("-27300")),
    ("11", "2300", "Sales Tax Payable",     "Other Current Liability","Liabilities", "Current Liabilities", Decimal("-14800")),
    ("12", "2700", "Long-Term Loan",        "Long Term Liability",    "Liabilities", "Long-Term Liabilities", Decimal("-195000")),
    ("13", "3000", "Common Stock",          "Equity",                 "Equity",      "Equity",              Decimal("-100000")),
    # Retained Earnings (qbo_id 14) is the plug — computed per period.
    ("15", "4000", "Product Sales",         "Income",                 "Revenue",     "Revenue",             Decimal("-1284000")),
    ("16", "4100", "Service Revenue",       "Income",                 "Revenue",     "Revenue",             Decimal("-176000")),
    ("17", "5000", "Cost of Goods Sold",    "Cost of Goods Sold",     "Expenses",    "Cost of Revenue",     Decimal("731000")),
    ("18", "6000", "Salaries & Wages",      "Expense",                "Expenses",    "Operating Expenses",  Decimal("286500")),
    ("19", "6100", "Marketing",             "Expense",                "Expenses",    "Operating Expenses",  Decimal("97200")),
    ("20", "6200", "Rent & Utilities",      "Expense",                "Expenses",    "Operating Expenses",  Decimal("66000")),
    ("21", "6300", "Software & Subscriptions","Expense",              "Expenses",    "Operating Expenses",  Decimal("43800")),
    ("22", "7000", "Interest Expense",      "Other Expense",          "Expenses",    "Other Expense",       Decimal("11900")),
]
_RE = ("14", "3900", "Retained Earnings", "Equity", "Equity", "Equity")
_BS_CATEGORIES = {"Assets", "Liabilities", "Equity"}


def _period_balances(period_idx: int, latest_idx: int) -> list[tuple]:
    """Return per-account signed balances for a period, with retained earnings
    plugged so the trial balance sums to zero. period_idx ascending (0=oldest)."""
    factor = Decimal(1) - Decimal("0.011") * (latest_idx - period_idx)
    rows = []
    running = Decimal(0)
    for qid, num, name, typ, cat, line, base in ACCOUNTS:
        bal = _q2(base * factor)
        running += bal
        rows.append((qid, num, name, typ, cat, line, bal))
    # Retained earnings plug → total signed balance == 0 (debits == credits).
    rows.append((_RE[0], _RE[1], _RE[2], _RE[3], _RE[4], _RE[5], _q2(-running)))
    return rows


async def main() -> None:
    me_dates = _month_ends(N_PERIODS)          # most-recent-first
    periods = list(reversed(me_dates))         # oldest-first
    latest = me_dates[0]
    prior = me_dates[1]
    earliest = periods[0]
    now = datetime.now(UTC)

    async with AsyncSessionLocal() as s:
        skip = {"skip_tenant_filter": True}

        # ── Tenant (upsert) ──────────────────────────────────────────────
        tenant = (await s.execute(
            select(Tenant).where(Tenant.clerk_org_id == settings.demo_clerk_org_id),
            execution_options=skip,
        )).scalar_one_or_none()
        if tenant is None:
            tenant = Tenant(id=DEMO_TENANT_ID, clerk_org_id=settings.demo_clerk_org_id)
            s.add(tenant)
        tenant.name = "Northwind Trading Co."
        tenant.is_demo = True
        tenant.books_start_date = date(earliest.year, earliest.month, 1)
        tenant.books_seeded_at = now
        tenant.deleted_at = None
        await s.flush()
        tid = tenant.id
        current_tenant_id.set(tid)

        # ── Demo admin user (upsert) ─────────────────────────────────────
        user = (await s.execute(
            select(User).where(User.tenant_id == tid, User.role == "admin"),
            execution_options=skip,
        )).scalars().first()
        if user is None:
            user = User(id=DEMO_USER_ID, tenant_id=tid,
                        clerk_user_id="demo_user_nordavix", email="demo@nordavix.com",
                        role="admin")
            s.add(user)
        user.welcomed_at = now
        await s.flush()
        uid = user.id

        # ── QBO connection (so the app looks connected) ──────────────────
        await s.execute(delete(QboConnection).where(QboConnection.tenant_id == tid))
        s.add(QboConnection(
            tenant_id=tid, realm_id="DEMO-REALM-0001",
            company_name="Northwind Trading Co.",
            access_token="demo-not-a-real-token", refresh_token="demo-not-a-real-token",
            token_expires_at=now + timedelta(days=3650),
        ))

        # ── Wipe prior demo data (idempotent) ────────────────────────────
        for model in (Narrative, Variance, Account, TrialBalance,
                      AccountReviewStatus, GlBalanceSnapshot, PeriodSync):
            await s.execute(delete(model).where(model.tenant_id == tid))

        # ── GL snapshots + PeriodSync per period ─────────────────────────
        latest_idx = len(periods) - 1
        latest_rows: list[tuple] = []
        for i, pe in enumerate(periods):
            rows = _period_balances(i, latest_idx)
            if pe == latest:
                latest_rows = rows
            ar = ap = ni_signed = Decimal(0)
            for qid, num, name, typ, cat, _line, bal in rows:
                s.add(GlBalanceSnapshot(
                    tenant_id=tid, qbo_account_id=qid, period_end=pe,
                    account_number=num, account_name=name, account_type=typ,
                    balance=bal, captured_at=now,
                ))
                if typ == "Accounts Receivable":
                    ar += bal
                elif typ == "Accounts Payable":
                    ap += -bal  # credit → natural-positive magnitude
                if cat in ("Revenue", "Expenses"):
                    ni_signed += bal
            s.add(PeriodSync(
                tenant_id=tid, period_end=pe,
                ar_aging_total=_q2(ar), ap_aging_total=_q2(ap),
                actual_net_income=_q2(-ni_signed), synced_at=now,
            ))

        # ── Reconciliation review status (latest period, BS accounts) ────
        ai_recon = {
            "generated_at": now.isoformat(),
            "confidence": 0.94,
            "checks": [
                {"label": "Subledger ties to GL", "passed": True},
                {"label": "No stale items > 60 days", "passed": True},
            ],
            "recommendation": "approve",
            "narrative": ("Balance ties to the supporting subledger with no "
                          "reconciling items. Movement is consistent with normal "
                          "monthly activity."),
        }
        in_progress = {"4": "pending", "10": "reviewed"}  # Inventory open, Accruals prepared
        for qid, _num, _name, _typ, cat, _line, _bal in latest_rows:
            if cat not in _BS_CATEGORIES:
                continue
            status = in_progress.get(qid, "approved")
            ars = AccountReviewStatus(
                tenant_id=tid, qbo_account_id=qid, period_end=latest, status=status,
            )
            if status in ("approved", "reviewed"):
                ars.prepared_by, ars.prepared_at = uid, now
            if status == "approved":
                ars.reviewed_by, ars.reviewed_at = uid, now
                ars.approved_by, ars.approved_at = uid, now
            if qid in ("3", "1"):  # AR + Operating Cash → AI-prepared
                ars.ai_commentary = ai_recon
            s.add(ars)

        # ── Flux analysis (latest vs prior) ──────────────────────────────
        prior_by_qid = {r[0]: r[6] for r in _period_balances(latest_idx - 1, latest_idx)}
        tb = TrialBalance(
            tenant_id=tid, name=f"Monthly flux — {latest.strftime('%B %Y')}",
            period_current=latest, period_prior=prior, status="complete",
            materiality_threshold=Decimal("5000"), created_by=uid,
            approved_by=uid, approved_at=now,
        )
        s.add(tb)
        await s.flush()
        flux_ai = {
            "15": ("Product sales rose on stronger Q-end volume with two enterprise "
                   "orders shipping in-month.", "low"),
            "19": ("Marketing increased with the new campaign launch; spend is within "
                   "the approved quarterly budget.", "low"),
            "4":  ("Inventory grew ahead of seasonal demand; turnover remains in range.",
                   "medium"),
        }
        for qid, num, name, _typ, cat, line, cur in latest_rows:
            prior_bal = prior_by_qid.get(qid, Decimal(0))
            acct = Account(
                tenant_id=tid, trial_balance_id=tb.id, account_number=num,
                account_name=name, current_balance=cur, prior_balance=prior_bal,
                fs_category=cat, fs_line=line, qbo_account_id=qid,
            )
            s.add(acct)
            await s.flush()
            dollar = cur - prior_bal
            if abs(dollar) < Decimal("5000"):
                continue
            pct = (dollar / abs(prior_bal) * 100) if prior_bal else None
            commentary = flux_ai.get(qid)
            var = Variance(
                tenant_id=tid, account_id=acct.id,
                dollar_variance=_q2(dollar),
                pct_variance=_q2(pct) if pct is not None else None,
                is_material=True, anomaly_flags=[],
                status="approved" if commentary else "generated",
                approved_by=uid if commentary else None,
                approved_at=now if commentary else None,
            )
            if commentary:
                text, risk = commentary
                var.ai_commentary = {
                    "narrative": text, "risk_level": risk, "justified": True,
                    "key_entities": [], "recommendations": [],
                }
            s.add(var)
            await s.flush()
            if commentary:
                s.add(Narrative(
                    tenant_id=tid, variance_id=var.id, content=commentary[0],
                    cache_key=hashlib.sha256(f"demo:{qid}:{cur}:{prior_bal}".encode()).hexdigest(),
                    confidence_score=Decimal("0.92"), input_tokens=0, output_tokens=0,
                    generated_at=now,
                ))

        await s.commit()

    print(f"✓ Seeded demo tenant {tid}  ({N_PERIODS} periods, latest {latest})")
    print(f"  accounts={len(ACCOUNTS) + 1}  org={settings.demo_clerk_org_id}")


if __name__ == "__main__":
    asyncio.run(main())
