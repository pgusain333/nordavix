"""The default cannabis chart-of-accounts template.

Pure, so it's testable and diffable in git rather than hidden in a table. This
is the firm's IP: a new client starts mostly mapped instead of facing 200 blank
rows, and the preparer only reviews the exceptions.

THE CONSERVATIVE DEFAULT — read before editing the keyword lists.

The risk here is asymmetric. Over-capitalizing moves cost into inventory that
§280E says should have stayed disallowed, which is the aggressive direction and
the one an examiner challenges. Under-capitalizing merely costs the client
deductions they could have defended.

So when the template is unsure it suggests EXCLUDED, never a production pool,
and marks the suggestion low confidence for review. A wrong "excluded" is a
missed opportunity the preparer will catch; a wrong "direct production" is an
overstated position they might not.

Nothing here is applied silently: suggestions land as a proposed mapping the
preparer confirms, and `confidence` drives what the UI asks them to look at.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

# ── Pools ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TemplatePool:
    name: str
    treatment: str
    driver: str | None = None
    blend_payroll_wt: Decimal | None = None
    blend_occupancy_wt: Decimal | None = None
    sort_order: int = 0
    notes: str | None = None


DEFAULT_POOLS: tuple[TemplatePool, ...] = (
    TemplatePool(
        "Direct production", "direct", sort_order=10,
        notes="Costs traceable to cultivation, processing or packaging. Fully inventoriable.",
    ),
    TemplatePool(
        "Facility overhead", "allocated", driver="occupancy", sort_order=20,
        notes="Rent, utilities, security, repairs — apportioned by production square footage.",
    ),
    TemplatePool(
        "Indirect labor", "allocated", driver="payroll", sort_order=30,
        notes="Supervision, payroll taxes and benefits — apportioned by production wages.",
    ),
    TemplatePool(
        "Shared operations", "allocated", driver="blended",
        blend_payroll_wt=Decimal("50"), blend_occupancy_wt=Decimal("50"), sort_order=40,
        notes="Costs serving the whole business (IT, general insurance) — blended 50/50.",
    ),
    TemplatePool(
        "Selling and admin", "excluded", sort_order=50,
        notes="Retail, marketing and administration. Disallowed under §280E.",
    ),
)

DIRECT = "Direct production"
FACILITY = "Facility overhead"
INDIRECT_LABOR = "Indirect labor"
SHARED = "Shared operations"
EXCLUDED = "Selling and admin"


# ── Keyword rules ─────────────────────────────────────────────────────────────
# Order matters: the first list whose keyword appears in the account name wins,
# so the more specific lists come first. Keywords are matched case-insensitively
# against "<number> <name>".

_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    # Unambiguously selling/admin — checked FIRST so "dispensary rent" and
    # "retail utilities" don't get captured by the facility rules below.
    (EXCLUDED, (
        "dispensary", "retail", "storefront", "budtender", "point of sale",
        "marketing", "advertis", "promotion", "branding", "social media",
        "selling", "sales commission", "commission", "delivery expense",
        "legal", "professional fee", "accounting fee", "audit fee", "consult",
        "office supplies", "meals", "entertainment", "travel", "donation",
        "charitable", "interest expense", "bank fee", "merchant fee",
        "penalt", "fine", "bad debt", "owner draw", "distribution",
    )),
    # Traceable production cost.
    (DIRECT, (
        "nutrient", "soil", "grow medium", "growing medium", "coco", "rockwool",
        "seed", "clone", "propagation", "mother plant", "cultivation supply",
        "cultivation supplies", "fertilizer", "pesticide", "fungicide",
        "harvest", "trimming", "trim labor", "curing", "drying",
        "packaging", "label", "jar", "vial", "child resistant",
        "lab test", "testing", "potency test", "compliance test",
        "extraction", "distillate", "solvent", "raw material", "direct labor",
        "cultivation wage", "cultivation payroll", "grow labor",
    )),
    # Facility — apportioned by square footage.
    (FACILITY, (
        "rent", "lease expense", "occupancy", "utilit", "electric", "power",
        "water", "sewer", "natural gas", "propane", "hvac", "climate",
        "security", "alarm", "surveillance", "camera", "guard",
        "repair", "maintenance", "janitorial", "cleaning", "waste",
        "property tax", "building insurance", "depreciation", "amortization",
        "leasehold", "facility",
    )),
    # Labor-driven overhead.
    (INDIRECT_LABOR, (
        "payroll tax", "employer tax", "fica", "futa", "suta",
        "benefit", "health insurance", "workers comp", "workers' comp",
        "retirement", "401", "training", "recruit", "human resource",
        "management salar", "supervisor", "supervision", "manager salar",
    )),
    # Genuinely shared services.
    (SHARED, (
        "software", "subscription", "saas", "information technology",
        " it ", "computer", "telephone", "phone", "internet", "communication",
        "general liability", "general insurance", "business insurance",
        "bookkeeping", "erp", "seed to sale", "metrc",
    )),
)

# High confidence when the match is decisive; these pools carry tax consequence
# in the aggressive direction, so a DIRECT suggestion is never high-confidence
# on a keyword alone — a human confirms every capitalized mapping.
_HIGH_CONFIDENCE_POOLS = frozenset({EXCLUDED, FACILITY, INDIRECT_LABOR})


@dataclass(frozen=True)
class Suggestion:
    pool_name: str
    confidence: str      # high | medium | low
    reason: str


def suggest_pool(
    account_name: str | None,
    account_number: str | None = None,
    account_type: str | None = None,
) -> Suggestion:
    """Suggest a pool for one expense account.

    Never raises, always returns something the preparer can accept or override.
    Unmatched accounts fall to EXCLUDED at low confidence — see the module
    docstring on why "unsure" must mean "not capitalized".
    """
    haystack = f" {(account_number or '').strip()} {(account_name or '').strip()} ".lower()

    for pool_name, keywords in _RULES:
        for kw in keywords:
            if kw in haystack:
                confidence = "high" if pool_name in _HIGH_CONFIDENCE_POOLS else "medium"
                return Suggestion(
                    pool_name=pool_name, confidence=confidence,
                    reason=f"matched '{kw.strip()}'",
                )

    # Cost of Goods Sold is already the client's own production classification,
    # so it's a strong signal — but still only a suggestion.
    if (account_type or "").strip() == "Cost of Goods Sold":
        return Suggestion(DIRECT, "medium", "QuickBooks account type is Cost of Goods Sold")

    return Suggestion(
        EXCLUDED, "low",
        "no rule matched — defaulted to disallowed, which is the conservative side",
    )


def suggest_mapping(accounts: list[dict]) -> list[dict]:
    """Suggest a pool for each expense account.

    `accounts` are dicts with qbo_account_id / account_number / account_name /
    account_type. Returns the same accounts with pool_name, confidence and
    reason attached, ready for the preparer to review.
    """
    out: list[dict] = []
    for a in accounts:
        s = suggest_pool(
            a.get("account_name"), a.get("account_number"), a.get("account_type"),
        )
        out.append({
            **a,
            "suggested_pool": s.pool_name,
            "confidence": s.confidence,
            "reason": s.reason,
        })
    return out
