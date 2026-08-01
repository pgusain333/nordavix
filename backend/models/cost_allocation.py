"""Nordavix Allocate — IRC §471(c) cost allocation (cannabis practice product).

A standalone product surface, NOT part of the month-end close. Practice staff
run a monthly cost allocation for each cannabis client: expenses are classified
into pools, indirect pools are apportioned to production by payroll and/or
occupancy drivers, and the production share is capitalized into inventory and
released to COGS via a period roll-forward.

Why this exists: §280E denies deductions to cannabis businesses, but COGS is a
reduction of gross receipts rather than a deduction. §471(c) lets a small
business taxpayer (no applicable financial statement) inventory costs per its
books and records — so the allocation method IS the tax position. That makes
*defensibility* the product requirement: every run snapshots the drivers and the
account→pool mapping it used, so a workpaper issued in March still reproduces
byte-identically in October after the maps have moved on.

Eight tables:
    alloc_settings      per-client method election + eligibility posture
    alloc_pool          the cost pools + their driver (CONFIGURABLE per client)
    alloc_account_map   GL account → pool
    alloc_space         occupancy registry (square footage by function)
    alloc_employee      payroll classification (who is production)
    alloc_payroll_entry monthly wages per employee (payroll-register import)
    alloc_run           one monthly run + its snapshotted drivers and totals
    alloc_run_line      per-account allocation detail (all names snapshotted)

Percentage conventions — deliberately split, because mixing them is a classic
source of 100× errors:
    * Human-entered percentages are 0–100   (production_pct, fixed_pct, blend_*_wt)
    * Engine-computed factors are fractions 0–1 (payroll_factor, occupancy_factor,
      run_line.driver_pct)

Money is Numeric(18, 2) throughout; the engine works in Decimal and allocates
with a largest-remainder method so pool lines sum exactly to the pool total.

Migration: 064_cost_allocation.py (creates the tables, indexes, CHECK
constraints, and the Tier-2 `tenant_isolation` RLS policy on all eight).
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from core.db.base import TenantBase


class AllocSettings(TenantBase):
    """One row per client — the §471(c) method election and eligibility posture.

    `method` records WHICH prong of §471(c)(1)(B) the client relies on:
    `books_records` (no AFS — the common cannabis case) or `afs` (conform to the
    applicable financial statement). `has_afs` is the gate: a client WITH an AFS
    cannot use the books-and-records prong, and the run must block rather than
    quietly produce an unusable workpaper.
    """

    __tablename__ = "alloc_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # books_records | afs
    method:   Mapped[str] = mapped_column(String(20), nullable=False, default="books_records")
    has_afs:  Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # rollforward (v1). Per-batch absorption would be a future value here.
    inventory_method: Mapped[str] = mapped_column(String(20), nullable=False, default="rollforward")

    # Who signed off on the method election, and when. Part of the exam file.
    election_attested_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    election_attested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # The inventory account the monthly reclass entry DEBITS (capitalized cost
    # moving out of expense and into inventory). Without it the run still
    # completes and the workpaper is still produced — only the proposed journal
    # entry is withheld, because guessing the debit target would be worse than
    # asking. Name is snapshotted for display alongside the id.
    inventory_account_id:   Mapped[str | None] = mapped_column(String(50))
    inventory_account_name: Mapped[str | None] = mapped_column(String(200))

    # "MM-DD" — most cannabis clients are calendar-year, but not all.
    fiscal_year_end: Mapped[str | None] = mapped_column(String(5))
    # Override the statutory §448(c) gross-receipts threshold (indexed annually).
    # NULL = use the platform default for the run's tax year.
    gross_receipts_threshold: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))

    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AllocPool(TenantBase):
    """A cost pool and how it maps to a driver — configurable per client.

    `treatment` decides the shape of the math:
        direct     → 100% capitalized (cultivation labor, nutrients, packaging)
        allocated  → capitalized = gross × driver_pct   (rent, utilities, mgmt)
        excluded   → 0% capitalized; stays disallowed under §280E (retail, selling)

    `driver` is REQUIRED when treatment='allocated' and MUST be NULL otherwise —
    enforced by a CHECK constraint in migration 064 so an inconsistent pool can
    never reach the engine.

    `blended` uses blend_payroll_wt / blend_occupancy_wt (0–100, summing to 100);
    `fixed` uses fixed_pct (0–100) for the rare pool with a negotiated or
    study-supported rate that isn't driven by either factor.
    """

    __tablename__ = "alloc_pool"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    # direct | allocated | excluded
    treatment: Mapped[str] = mapped_column(String(20), nullable=False)
    # payroll | occupancy | blended | fixed   (NULL unless treatment='allocated')
    driver: Mapped[str | None] = mapped_column(String(20))

    # Human-entered percentages, 0–100.
    blend_payroll_wt:   Mapped[Decimal | None] = mapped_column(Numeric(7, 4))
    blend_occupancy_wt: Mapped[Decimal | None] = mapped_column(Numeric(7, 4))
    fixed_pct:          Mapped[Decimal | None] = mapped_column(Numeric(7, 4))

    sort_order: Mapped[int]  = mapped_column(Integer, nullable=False, default=0)
    active:     Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notes:      Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AllocAccountMap(TenantBase):
    """GL account → cost pool, with effective dating.

    account_number / account_name are denormalized copies of the QBO values so a
    historical workpaper still renders a recognizable account even if the client
    later renames or renumbers its chart.

    At most one LIVE mapping per account (partial unique WHERE effective_to IS
    NULL) — re-pooling an account closes the old row and opens a new one, so the
    history of "which pool did this account sit in last March" is preserved.
    """

    __tablename__ = "alloc_account_map"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    account_number: Mapped[str | None] = mapped_column(String(50))
    account_name:   Mapped[str | None] = mapped_column(String(200))

    pool_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("alloc_pool.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to:   Mapped[date | None] = mapped_column(Date)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AllocSpace(TenantBase):
    """The occupancy registry — square footage by function.

    QuickBooks has no concept of square footage, so this table is the sole
    source of the occupancy driver. `production_pct` is an optional override for
    genuinely shared areas (a hallway serving both cultivation and retail);
    NULL means "derive from `function`" (production functions = 100, others = 0).

    Effective-dated: expansions and build-outs mid-year must not retroactively
    change an already-issued workpaper.
    """

    __tablename__ = "alloc_space"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # cultivation | processing | curing | packaging | retail | office | storage | shared
    function: Mapped[str] = mapped_column(String(24), nullable=False)
    square_feet: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    # 0–100 override; NULL = derive from `function`.
    production_pct: Mapped[Decimal | None] = mapped_column(Numeric(7, 4))

    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to:   Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AllocEmployee(TenantBase):
    """Payroll classification — which employees are production, and how much.

    QBO won't tell us a grower from a budtender, so the classification lives
    here. `production_pct` (0–100) handles the working owner who spends 60% of
    their time in the grow: the split is stated once and applied consistently,
    which is exactly what an examiner wants to see.

    Wages are NOT stored here — they arrive monthly in alloc_payroll_entry, so
    the classification stays stable while the dollars change.
    """

    __tablename__ = "alloc_employee"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    name: Mapped[str] = mapped_column(String(160), nullable=False)
    # Payroll-register identifier (ADP/Gusto/Paychex employee id) — the join key
    # used by the monthly import to match rows to a classification.
    external_id:     Mapped[str | None] = mapped_column(String(80), index=True)
    qbo_employee_id: Mapped[str | None] = mapped_column(String(50))

    # The client's OWN labels, carried straight from the payroll register (ADP
    # "Home Department", Gusto "Department", plus job title). Kept because they
    # are the books-and-records basis for the classification below — an examiner
    # asking "why is this person production?" gets "their employer's own payroll
    # department says Cultivation", which is far stronger than a preparer's
    # unsourced judgement.
    department: Mapped[str | None] = mapped_column(String(120))
    job_title:  Mapped[str | None] = mapped_column(String(120))

    # cultivation | processing | packaging | retail | admin | management | shared
    function: Mapped[str] = mapped_column(String(24), nullable=False)
    production_pct: Mapped[Decimal] = mapped_column(Numeric(7, 4), nullable=False, default=0)

    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to:   Mapped[date | None] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AllocPayrollEntry(TenantBase):
    """One employee's wages for one period — the payroll factor's numerator.

    Sourced from a payroll-register import (every provider exports one), manual
    entry for small clients, or QBO where payroll is reliably class-tagged.
    Employer taxes and benefits are captured separately so the firm can choose
    whether the factor runs on gross wages or fully-loaded labor cost.

    Unique per (employee, period) so re-importing the same register is
    idempotent rather than double-counting.
    """

    __tablename__ = "alloc_payroll_entry"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    employee_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("alloc_employee.id", ondelete="CASCADE"), nullable=False, index=True
    )
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end:   Mapped[date] = mapped_column(Date, nullable=False, index=True)

    gross_wages:    Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    employer_taxes: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    benefits:       Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)

    # import | manual | qbo
    source:       Mapped[str] = mapped_column(String(12), nullable=False, default="import")
    import_batch: Mapped[str | None] = mapped_column(String(64))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AllocRun(TenantBase):
    """One monthly allocation for one client — and the frozen evidence behind it.

    `driver_basis` is the whole point: a JSONB snapshot of the numerator and
    denominator of each factor plus the space/employee rows as they stood when
    the run executed. Reproduce the workpaper years later and the arithmetic is
    all still here, independent of what the registries look like today.

    Eligibility (§448(c) three-year average gross receipts + AFS status) is
    snapshotted too, because whether the client qualified is a fact about the
    run, not a fact about the client's current state.

    At most one live run per period — re-running supersedes rather than deletes,
    so the audit trail keeps every version that was ever issued.
    """

    __tablename__ = "alloc_run"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end:   Mapped[date] = mapped_column(Date, nullable=False, index=True)
    # draft | in_review | approved | superseded
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)

    # ── Drivers (fractions 0–1, engine-computed) ────────────────────────
    payroll_factor:   Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    occupancy_factor: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    driver_basis:     Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    # ── Totals ──────────────────────────────────────────────────────────
    total_expenses:    Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    direct_total:      Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    allocated_total:   Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    capitalized_total: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    disallowed_total:  Mapped[Decimal | None] = mapped_column(Numeric(18, 2))

    # ── Inventory roll-forward → COGS ───────────────────────────────────
    beginning_inventory: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    additions_purchases: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    ending_inventory:    Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    cogs:                Mapped[Decimal | None] = mapped_column(Numeric(18, 2))

    # ── Eligibility snapshot (§448(c) small business taxpayer test) ──────
    eligible:           Mapped[bool | None] = mapped_column(Boolean)
    gross_receipts_3yr: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    threshold_used:     Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    has_afs:            Mapped[bool | None] = mapped_column(Boolean)
    # Why the run can't proceed (missing sq ft, no payroll, over threshold…).
    blocked_reason:     Mapped[str | None] = mapped_column(String(300))

    # ── Maker-checker ───────────────────────────────────────────────────
    prepared_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    prepared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # The reclass JE this run emitted into the Adjustments queue
    # (proposed_entries.source='allocation', source_ref=<run id>).
    proposed_entry_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    # ── Book conformity ─────────────────────────────────────────────────
    # §471(c) is a BOOKS-and-records method: if the entry never posts, the
    # ledger shows ordinary expense while the return claims COGS, and the
    # position fails on its own terms. `posting_checked_at` is deliberately
    # separate from `posted_at` so "we haven't looked" can never be displayed
    # as "it's fine".
    posted_at:          Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    posted_doc_number:  Mapped[str | None] = mapped_column(String(60))
    posting_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_pulled_at:  Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AllocRunLine(TenantBase):
    """Per-account allocation detail for a run — the workpaper's body.

    Pool name, treatment, driver and driver_pct are all SNAPSHOTTED rather than
    joined, so re-pooling an account next quarter cannot silently rewrite an
    issued workpaper.

    Engine invariant (blocking test): gross == capitalized + disallowed on every
    single line, exactly — no rounding leak.
    """

    __tablename__ = "alloc_run_line"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("alloc_run.id", ondelete="CASCADE"), nullable=False, index=True
    )

    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False)
    account_number: Mapped[str | None] = mapped_column(String(50))
    account_name:   Mapped[str | None] = mapped_column(String(200))

    # Snapshotted pool context — deliberately not a FK.
    pool_name:  Mapped[str] = mapped_column(String(80), nullable=False)
    treatment:  Mapped[str] = mapped_column(String(20), nullable=False)
    driver:     Mapped[str | None] = mapped_column(String(20))
    # Fraction 0–1 actually applied to this line.
    driver_pct: Mapped[Decimal] = mapped_column(Numeric(9, 6), nullable=False, default=0)

    gross_amount:       Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    capitalized_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)
    disallowed_amount:  Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AllocTxnOverride(TenantBase):
    """One GL transaction a preparer allocated by hand.

    The pool driver is an estimate for a whole account. Where somebody has
    actually read the ledger, the specific answer is stronger evidence — and
    §471(c) is a books-and-records method, so stronger evidence is the point.

    Transaction details are SNAPSHOTTED rather than re-fetched: the workpaper
    must still read correctly if the transaction is later edited in QuickBooks,
    and the override list has to render without a QBO round-trip.

    Scoped to a period, because the same recurring cost can be production one
    month and not the next.

    Migration: 068_alloc_txn_override.py.
    """

    __tablename__ = "alloc_txn_override"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    qbo_account_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    qbo_txn_id:     Mapped[str] = mapped_column(String(64), nullable=False)
    period_end:     Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # 0-100, entered by a human. This is the judgement being recorded.
    production_pct: Mapped[Decimal] = mapped_column(Numeric(7, 4), nullable=False)

    amount:      Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    txn_date:    Mapped[date | None] = mapped_column(Date)
    txn_type:    Mapped[str | None] = mapped_column(String(60))
    txn_number:  Mapped[str | None] = mapped_column(String(60))
    memo:        Mapped[str | None] = mapped_column(String(300))
    entity_name: Mapped[str | None] = mapped_column(String(200))
    # Why this split — the sentence that answers an examiner.
    note:        Mapped[str | None] = mapped_column(String(300))

    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
