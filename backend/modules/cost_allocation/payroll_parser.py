"""Payroll register parsing — the wages behind the payroll driver.

QuickBooks won't give per-employee wages through the API, so the register comes
from the payroll provider: ADP, Gusto, Paychex, KayaPush, Rippling. Every one of
them exports a CSV/XLSX with different column names for the same three things,
so the import detects the columns and lets the preparer correct the guess before
anything is written.

Two rules carried over from the rest of the module:

  * A row that can't be matched to a classified employee is REPORTED, never
    guessed at. A misattributed wage silently shifts the payroll factor, and
    with it how much cost gets capitalized — the tax position.
  * Auto-created employees start at 0% production (unclassified). Wrong in the
    conservative direction, and visible on the Employees tab for the preparer to
    correct, rather than quietly inflating the factor.

`detect_payroll_columns` is deliberately pandas-free so it can be covered by the
deploy-gating invariants; the file reading below it is not.
"""
from __future__ import annotations

import io
import re
from decimal import Decimal, InvalidOperation
from typing import Any

# Header hints, most specific first — the first hint that appears in a header
# claims that column. "gross pay" must beat a bare "pay", and employer-tax
# columns must be claimed before anything matching a loose "tax".
_HINTS: dict[str, tuple[str, ...]] = {
    "external_id": (
        "associate id", "employee id", "employee number", "emp id", "emp no",
        "file number", "payroll id", "worker id", "person id", "empl id", "id",
    ),
    "name": (
        "employee name", "employee full name", "full name", "worker name",
        "employee", "worker", "name",
    ),
    # Providers carry the client's own org structure — ADP "Home Department",
    # Gusto "Department", KayaPush "Location/Department". It's the client's own
    # classification of the person, which makes it the best available signal for
    # production vs retail vs admin.
    "department": (
        "home department", "department description", "department name",
        "department", "dept", "division", "cost center", "work location",
        "location",
    ),
    "job_title": (
        "job title", "position title", "position", "job description", "title",
        "role", "occupation", "job",
    ),
    "gross_wages": (
        "gross pay", "gross wages", "total gross", "gross earnings", "gross",
        "total earnings", "earnings", "wages", "salary",
    ),
    "employer_taxes": (
        "employer taxes", "employer tax", "er taxes", "er tax", "company taxes",
        "employer payroll tax", "payroll taxes", "payroll tax", "taxes - employer",
    ),
    "benefits": (
        "employer benefits", "er benefits", "company benefits", "benefits",
        "employer contribution", "health insurance", "401k match", "401(k) match",
    ),
}

# Order matters: a column is claimed once, by the first role that wants it, so
# roles whose hints are narrower are resolved first. `job_title` resolves before
# `name` so "Employee Name" vs "Job Title" can't cross-claim.
_ROLE_ORDER = (
    "external_id", "gross_wages", "employer_taxes", "benefits",
    "department", "job_title", "name",
)

# ── Department / title → suggested function ──────────────────────────────────
# Non-production groups are checked FIRST: when a department name is ambiguous,
# the suggestion must fall on the side that does NOT capitalize — same ordering
# principle as the COA template. Unknown → "shared" at 0%.
_FUNCTION_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("retail", (
        "retail", "dispensary", "budtend", "sales", "store", "front of house",
        "cashier", "delivery", "curbside",
    )),
    ("admin", (
        "admin", "office", "human resource", "hr", "finance", "account",
        "compliance", "legal", "marketing", "security",
    )),
    ("management", ("management", "executive", "general manager", "gm", "director")),
    ("cultivation", (
        "cultivat", "grow", "garden", "flower", "veg", "nursery", "propagation",
        "harvest", "trim", "post harvest",
    )),
    ("processing", (
        "process", "extract", "manufactur", "lab", "kitchen", "infusion",
        "production",
    )),
    ("packaging", ("packag", "labeling", "labelling")),
)

# Kept in step with engine.PRODUCTION_EMPLOYEE_FUNCTIONS.
_PRODUCTION_FUNCTIONS = frozenset({"cultivation", "processing", "packaging"})


def suggest_employee_function(
    department: str | None, job_title: str | None,
) -> tuple[str, int, str]:
    """(function, default production %, reason) from the register's own labels.

    The department is the CLIENT's classification of the person — their books
    and records — which is exactly what §471(c) keys off. Still a suggestion:
    the preview shows it per row and the preparer confirms before import.

    Department outranks title ("Retail — Inventory Specialist" is retail), and
    with nothing recognizable the person lands in "shared" at 0% production —
    counted against the payroll factor but never toward it.
    """
    for source, label in (("department", department), ("job title", job_title)):
        text = (label or "").strip().lower()
        if not text:
            continue
        for function, keywords in _FUNCTION_RULES:
            for kw in keywords:
                if kw in text:
                    pct = 100 if function in _PRODUCTION_FUNCTIONS else 0
                    return function, pct, f"{source} '{label}' matched '{kw}'"
    return "shared", 0, "no recognizable department or title — left unclassified"


def detect_payroll_columns(headers: list[str]) -> dict[str, str | None]:
    """Best guess at which column holds which field.

    Pure and provider-agnostic. Every role resolves to a header or None; the
    caller shows the guess and lets the preparer correct it before importing.
    """
    normalized = [(h, (h or "").strip().lower()) for h in headers]
    taken: set[str] = set()
    out: dict[str, str | None] = dict.fromkeys(_HINTS)

    for role in _ROLE_ORDER:
        for hint in _HINTS[role]:
            match = next(
                (h for h, low in normalized if h not in taken and hint in low),
                None,
            )
            if match is not None:
                out[role] = match
                taken.add(match)
                break

    return out


_NUM_RE = re.compile(r"[^0-9.\-]")


def to_decimal(value: Any) -> Decimal:
    """Parse a spreadsheet money cell. Blank, dashes and junk become 0.00.

    Handles the shapes registers actually contain: "$1,234.56", "(500.00)" for
    negatives, and stray whitespace.
    """
    if value is None:
        return Decimal("0.00")
    text = str(value).strip()
    if not text or text in {"-", "--", "—", "nan", "None"}:
        return Decimal("0.00")

    negative = text.startswith("(") and text.endswith(")")
    cleaned = _NUM_RE.sub("", text)
    if not cleaned or cleaned in {"-", ".", "-."}:
        return Decimal("0.00")
    try:
        amount = Decimal(cleaned)
    except InvalidOperation:
        return Decimal("0.00")
    return -amount if negative else amount


def parse_payroll_file(
    file_bytes: bytes, filename: str, mapping: dict[str, str | None] | None = None,
) -> tuple[list[str], dict[str, str | None], list[dict]]:
    """Read a register into (headers, mapping, rows).

    Rows carry name / external_id / gross_wages / employer_taxes / benefits.
    Rows with neither a name nor an id are dropped — they're subtotal or spacer
    lines, which every provider's export has.
    """
    import pandas as pd  # local: keeps this module importable without pandas

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    buf = io.BytesIO(file_bytes)
    if ext == "csv":
        df = pd.read_csv(buf, dtype=str, keep_default_na=False)
    elif ext in {"xlsx", "xls", "xlsm"}:
        df = pd.read_excel(buf, dtype=str, keep_default_na=False)
    else:
        raise ValueError("Upload a CSV or Excel payroll register (.csv, .xlsx).")

    df.dropna(how="all", inplace=True)
    headers = [str(c) for c in df.columns]
    resolved = mapping or detect_payroll_columns(headers)

    def cell(row, role: str) -> str:
        col = resolved.get(role)
        if not col or col not in df.columns:
            return ""
        return str(row.get(col) or "").strip()

    rows: list[dict] = []
    for _, raw in df.iterrows():
        name = cell(raw, "name")
        external_id = cell(raw, "external_id")
        if not name and not external_id:
            continue  # subtotal / blank / spacer line

        gross = to_decimal(cell(raw, "gross_wages"))
        taxes = to_decimal(cell(raw, "employer_taxes"))
        benefits = to_decimal(cell(raw, "benefits"))
        if gross == 0 and taxes == 0 and benefits == 0:
            continue  # nothing to allocate for this person this period

        department = cell(raw, "department")
        job_title = cell(raw, "job_title")
        function, pct, reason = suggest_employee_function(department, job_title)

        rows.append({
            "name": name or None,
            "external_id": external_id or None,
            "department": department or None,
            "job_title": job_title or None,
            "gross_wages": str(gross),
            "employer_taxes": str(taxes),
            "benefits": str(benefits),
            "suggested_function": function,
            "suggested_production_pct": pct,
            "suggestion_reason": reason,
        })

    return headers, resolved, aggregate_rows(rows)


def aggregate_rows(rows: list[dict]) -> list[dict]:
    """Combine repeated appearances of the same person into one row.

    Registers routinely list somebody more than once in a month — semi-monthly
    payroll is two runs, and some exports emit a row per earnings code. The
    month's wage for that person is the SUM of those rows.

    This is also what stops the import crashing: alloc_payroll_entry is UNIQUE
    on (tenant, employee, period), so two rows for one person meant two inserts
    for the same key, an IntegrityError, and a 500 the browser reported as a
    bare "Network Error".

    Identity is external_id when present, else the lower-cased name — the same
    precedence the matcher uses, so aggregation and matching can't disagree.
    """
    merged: dict[str, dict] = {}
    order: list[str] = []

    for row in rows:
        key = (row.get("external_id") or "").strip().lower()
        if not key:
            key = f"name:{(row.get('name') or '').strip().lower()}"
        if not key or key == "name:":
            continue

        if key not in merged:
            merged[key] = {**row, "pay_runs": 1}
            order.append(key)
            continue

        prior = merged[key]
        prior["pay_runs"] += 1
        for field in ("gross_wages", "employer_taxes", "benefits"):
            prior[field] = str(to_decimal(prior[field]) + to_decimal(row[field]))
        # Keep the first non-empty department/title — later rows for the same
        # person are the same job, and a blank on a later run shouldn't erase it.
        for field in ("department", "job_title"):
            if not prior.get(field) and row.get(field):
                prior[field] = row[field]
        if not prior.get("name") and row.get("name"):
            prior["name"] = row["name"]

    # Re-derive the suggestion once the department/title are fully populated.
    out: list[dict] = []
    for key in order:
        row = merged[key]
        function, pct, reason = suggest_employee_function(
            row.get("department"), row.get("job_title"),
        )
        row["suggested_function"] = function
        row["suggested_production_pct"] = pct
        row["suggestion_reason"] = reason
        out.append(row)
    return out


def match_rows(rows: list[dict], employees: list) -> list[dict]:
    """Attach the employee each row matches — external id first, then exact name.

    Never fuzzy-matches. Two people called "J. Smith" must not be silently
    merged into one wage figure, so an ambiguous or unknown row comes back
    unmatched for the preparer to resolve.
    """
    by_ext = {e.external_id: e for e in employees if e.external_id}
    by_name: dict[str, Any] = {}
    ambiguous: set[str] = set()
    for e in employees:
        key = e.name.strip().lower()
        if key in by_name:
            ambiguous.add(key)
        by_name[key] = e

    out: list[dict] = []
    for row in rows:
        emp = None
        if row.get("external_id"):
            emp = by_ext.get(row["external_id"])
        if emp is None and row.get("name"):
            key = row["name"].strip().lower()
            if key not in ambiguous:
                emp = by_name.get(key)
        out.append({
            **row,
            "matched_employee_id": str(emp.id) if emp else None,
            "matched_name": emp.name if emp else None,
            "matched_function": emp.function if emp else None,
        })
    return out
