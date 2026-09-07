"""Cross-period arithmetic for the Copilot — trend, forecast, and the bridge to a target.

Every one of the Copilot's other tools answers "what is X, in this one month."
A controller's questions almost never have that shape: they are across time
("is the burn widening?"), forward ("do we make it?"), or against a goal ("how
do we get there?"). None of those could be answered at all, because nothing
could see two periods at once.

Everything here is a pure function over a list of numbers so it can be tested
directly, and so the honesty rules below are enforced in one place rather than
re-argued by a language model each time it answers:

  - Three points minimum. A line through two points is not a trend, it is a
    line through two points.
  - A volatile series does not get a point forecast. If the swing is wide the
    answer is a range with its width stated, because a single number implies a
    precision the data does not have.
  - A target is measured against what the client has ACTUALLY achieved. "You
    need $80k a month" is arithmetic; "your best month in this window was $62k"
    is the part that makes it advice.
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

# Window sizing. Six months is enough to see a direction without reaching back
# into a period the business no longer resembles.
MONTHS_DEFAULT = 6
MONTHS_MAX = 24

# Fewer than three points and we decline to call it a trend at all.
MIN_POINTS = 3

# A move smaller than this reads as flat. Month-to-month noise in a real ledger
# is routinely 1-2%; calling that "rising" would make every account a story.
FLAT_BAND_PCT = 3.0

# Coefficient of variation above which a straight line through the series is a
# lie. Beyond this the forecast is reported as a range, not a point.
VOLATILE_CV = 0.35


def _f(v) -> float | None:
    """Best-effort float. Returns None for anything that isn't a number — a
    missing month must stay missing rather than become a zero that drags a
    trend down."""
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError, InvalidOperation):
        return None


def prior_month_end(d: date) -> date:
    """Last day of the month before d."""
    return d.replace(day=1) - timedelta(days=1)


def month_ends_back(latest: date, count: int) -> list[date]:
    """`count` month-end dates ending at `latest`, oldest first."""
    count = max(1, min(int(count or MONTHS_DEFAULT), MONTHS_MAX))
    out = [latest]
    cur = latest
    for _ in range(count - 1):
        cur = prior_month_end(cur)
        out.append(cur)
    return list(reversed(out))


# ── Descriptive statistics ────────────────────────────────────────────────────

def mean(values: list[float]) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def stdev(values: list[float]) -> float | None:
    """Population standard deviation. Population rather than sample because we
    are describing the months we have, not inferring about months we don't."""
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return None
    m = sum(vals) / len(vals)
    return (sum((v - m) ** 2 for v in vals) / len(vals)) ** 0.5


def cv(values: list[float]) -> float | None:
    """Coefficient of variation — spread relative to size. Dimensionless, so a
    $2k swing on $10k of revenue and a $200k swing on $1M read the same."""
    m = mean(values)
    s = stdev(values)
    if m is None or s is None or abs(m) < 1e-9:
        return None
    return s / abs(m)


def slope(values: list[float]) -> float | None:
    """Least-squares slope per step. None below MIN_POINTS."""
    vals = [v for v in values if v is not None]
    n = len(vals)
    if n < MIN_POINTS:
        return None
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(vals) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom < 1e-12:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, vals, strict=True)) / denom


def total_change_pct(values: list[float]) -> float | None:
    """First point to last, as a percentage of the first."""
    vals = [v for v in values if v is not None]
    if len(vals) < 2 or abs(vals[0]) < 1e-9:
        return None
    return (vals[-1] - vals[0]) / abs(vals[0]) * 100.0


def direction(values: list[float]) -> str:
    """One word for where the series is going.

    "volatile" outranks a direction: a series that swings 40% either way is not
    rising even when its endpoints happen to sit higher, and describing it as
    rising invites a decision the data does not support.
    """
    vals = [v for v in values if v is not None]
    if len(vals) < MIN_POINTS:
        return "insufficient_data"
    spread = cv(vals)
    if spread is not None and spread > VOLATILE_CV:
        return "volatile"
    pct = total_change_pct(vals)
    if pct is None:
        return "flat"
    if abs(pct) < FLAT_BAND_PCT:
        return "flat"
    return "rising" if pct > 0 else "falling"


# ── Forecast ──────────────────────────────────────────────────────────────────

def forecast(values: list[float], ahead: int = 3) -> dict:
    """Project the series forward, with the width of what we don't know.

    Two methods, chosen by the data rather than by preference:
      - "trend"    — least-squares extrapolation, used when the series is
                     stable enough for a line to mean something.
      - "average"  — the mean, used when it isn't. A flat projection is not a
                     worse forecast for a volatile series; it is the honest one.
    Either way the band comes from the residuals, so a noisy history produces a
    visibly wide answer instead of a confident wrong one.
    """
    vals = [v for v in values if v is not None]
    ahead = max(1, min(int(ahead or 3), 12))
    if len(vals) < MIN_POINTS:
        return {
            "ok": False,
            "points": [],
            "method": None,
            "reason": (
                f"Only {len(vals)} month(s) of data. A forecast needs at least "
                f"{MIN_POINTS} to be worth anything."
            ),
        }

    m = mean(vals) or 0.0
    spread = cv(vals)
    volatile = spread is not None and spread > VOLATILE_CV
    b = slope(vals)

    if volatile or b is None:
        method = "average"
        base = [m] * ahead
        residuals = [v - m for v in vals]
    else:
        method = "trend"
        n = len(vals)
        intercept = m - b * ((n - 1) / 2.0)
        base = [intercept + b * (n - 1 + k) for k in range(1, ahead + 1)]
        residuals = [v - (intercept + b * i) for i, v in enumerate(vals)]

    rmse = (sum(r * r for r in residuals) / len(residuals)) ** 0.5

    points = [
        {
            "step": k + 1,
            "value": round(base[k], 2),
            # The band widens with distance: month three is a guess about a
            # guess. sqrt keeps it from exploding into a uselessly wide range.
            "low": round(base[k] - rmse * ((k + 1) ** 0.5), 2),
            "high": round(base[k] + rmse * ((k + 1) ** 0.5), 2),
        }
        for k in range(ahead)
    ]
    return {
        "ok": True,
        "method": method,
        "points": points,
        "monthly_change": round(b, 2) if b is not None and method == "trend" else 0.0,
        "volatility": round(spread, 3) if spread is not None else None,
        "confidence": "low" if volatile else ("medium" if rmse > abs(m) * 0.15 else "high"),
        "basis": (
            f"{len(vals)} months of actuals; "
            + ("too volatile for a trend line, so this is the average with a wide band"
               if volatile else "least-squares trend")
        ),
    }


# ── The bridge to a target ────────────────────────────────────────────────────

def _reachability(required: float, current: float, best: float | None) -> str:
    """How hard the required run-rate is, judged against what the client has
    actually done — not against zero."""
    if required <= current:
        return "on_track"
    if best is None:
        return "unknown"
    if required <= best:
        return "stretch"
    if required > best * 2:
        return "unprecedented_by_far"
    return "unprecedented"


def bridge_to_target(
    *,
    target: Decimal | float,
    current_monthly: Decimal | float,
    months_remaining: int,
    achieved_to_date: Decimal | float | None = None,
    best_month: Decimal | float | None = None,
    target_kind: str = "total",
) -> dict:
    """What has to happen, per month, for the client to hit a number.

    `target_kind="total"` is a cumulative goal by a date (annual net income,
    revenue for the year). `target_kind="monthly"` is a run-rate to reach (get
    monthly revenue to $200k).

    The verdict is the point of the whole function. Anyone can divide a gap by
    the months left; the controller's contribution is saying whether the answer
    is a plan or a wish, and the only honest way to do that is against the
    client's own best month.
    """
    tgt = _f(target)
    cur = _f(current_monthly)
    if tgt is None or cur is None:
        return {"ok": False, "reason": "A target and a current run-rate are both required."}

    months = int(months_remaining or 0)
    done = _f(achieved_to_date) or 0.0
    best = _f(best_month)

    if target_kind == "monthly":
        required = tgt
        gap_total = (tgt - cur) * max(months, 1)
        at_pace = cur
        shortfall = max(0.0, tgt - cur)
    else:
        gap_total = tgt - done
        at_pace = done + cur * months
        shortfall = max(0.0, tgt - at_pace)
        if months <= 0:
            return {
                "ok": True,
                "target": round(tgt, 2),
                "target_kind": target_kind,
                "months_remaining": 0,
                "achieved_to_date": round(done, 2),
                "gap": round(gap_total, 2),
                "reachable": "no_time" if gap_total > 0 else "on_track",
                "verdict": (
                    f"No months left in the window and {gap_total:,.0f} still to find."
                    if gap_total > 0
                    else "The target is already met."
                ),
            }
        required = gap_total / months

    reach = "on_track" if gap_total <= 0 else _reachability(required, cur, best)
    delta = required - cur
    delta_pct = (delta / abs(cur) * 100.0) if abs(cur) > 1e-9 else None

    verdicts = {
        "on_track": "The current run-rate already gets there — protect it rather than chase it.",
        "stretch": (
            f"It needs {required:,.0f} a month against {cur:,.0f} today. The business has "
            f"hit {best:,.0f} before, so this is a stretch, not a fantasy — but it has to "
            f"be every month, not once."
            if best is not None else ""
        ),
        "unprecedented": (
            f"It needs {required:,.0f} a month. The best month in this window was "
            f"{best:,.0f}, so the plan requires beating the client's own record and then "
            f"repeating it. Either the target moves, the window extends, or something "
            f"structural changes."
            if best is not None else ""
        ),
        "unprecedented_by_far": (
            f"It needs {required:,.0f} a month against a best-ever {best:,.0f} — more than "
            f"double. This is not a run-rate problem; it would take a different business. "
            f"Worth re-checking the target before planning against it."
            if best is not None else ""
        ),
        "unknown": (
            f"It needs {required:,.0f} a month against {cur:,.0f} today. There isn't enough "
            f"history here to say whether that pace has ever been achieved."
        ),
    }

    return {
        "ok": True,
        "target": round(tgt, 2),
        "target_kind": target_kind,
        "months_remaining": months,
        "achieved_to_date": round(done, 2),
        "current_monthly": round(cur, 2),
        "best_month": round(best, 2) if best is not None else None,
        "gap": round(gap_total, 2),
        "required_monthly": round(required, 2),
        "monthly_delta": round(delta, 2),
        "delta_pct": round(delta_pct, 1) if delta_pct is not None else None,
        "at_current_pace": round(at_pace, 2),
        "shortfall_at_pace": round(shortfall, 2),
        "reachable": reach,
        "verdict": verdicts.get(reach, ""),
    }


# ── Levers ────────────────────────────────────────────────────────────────────

# Lines a business cannot meaningfully cut inside a quarter. Naming them keeps
# the copilot from proposing "reduce rent by 30%" as though it were a decision
# someone could take on a Tuesday.
_STRUCTURAL_HINTS = (
    "rent", "lease", "insurance", "depreciation", "amortization", "amortisation",
    "interest", "tax", "licen", "utilit",
)


def _is_structural(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in _STRUCTURAL_HINTS)


def rank_levers(levers: list[dict], monthly_gap: float | Decimal) -> list[dict]:
    """Rank expense lines by how much of the gap each could actually carry.

    Each lever comes back with the percentage cut it would take to close the
    gap on its own. That number is what makes the list useful: a line needing a
    9% trim and a line needing a 140% trim look identical when ranked by size
    alone, and only one of them is a plan.
    """
    gap = _f(monthly_gap) or 0.0
    out: list[dict] = []
    for lv in levers or []:
        if not isinstance(lv, dict):
            continue
        name = str(lv.get("name") or "").strip()
        amt = _f(lv.get("monthly_amount"))
        if not name or amt is None or amt <= 0:
            continue
        needed_pct = (gap / amt * 100.0) if gap > 0 else 0.0
        structural = bool(lv.get("structural")) or _is_structural(name)
        if needed_pct > 100:
            feasibility = "cannot_close_alone"
        elif structural:
            feasibility = "structural"
        elif needed_pct > 25:
            feasibility = "hard"
        else:
            feasibility = "plausible"
        out.append({
            "name": name,
            "monthly_amount": round(amt, 2),
            "pct_cut_to_close_gap": round(needed_pct, 1),
            "structural": structural,
            "feasibility": feasibility,
        })
    # Largest line first — the only lever worth discussing is one big enough to
    # matter, and the pct field says whether it is also realistic.
    out.sort(key=lambda r: r["monthly_amount"], reverse=True)
    return out
