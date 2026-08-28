"""In-app destinations, in one place.

Notifications, tasks and digests all hand the frontend a route. Those routes
were spelled out as string literals at each call site, and they drifted the way
duplicated strings always do: a notification whose body read "marked account
{qbo_account_id} ({period_end}) prepared" linked to `/app/reconciliations` — the
module root. It named the object and pointed at the neighbourhood, leaving the
reader to find a single account among forty, in a period the link didn't select
either.

Every builder here takes the context the caller already holds and puts it in the
URL. Two conventions the frontend implements:

  * `?period=YYYY-MM-DD` — read by useSelectedPeriod ahead of the stored
    default, so a link naming a month lands on that month. Honoured by the
    dashboard, Close Workflow, Risk Radar and every schedule page.
  * `#acct=<qbo_account_id>` — read by the reconciliations dashboard on mount,
    which opens that account's drawer.

Routes are declared in frontend/src/App.tsx; tests/test_app_links.py parses that
file and asserts every builder here resolves to one, because a link that reads
as a fix and goes nowhere is worse than no link.
"""
from __future__ import annotations

from datetime import date

# Schedule kind -> its page. Mirrors the routes in App.tsx.
_SCHEDULE_PAGES = {
    "prepaid":     "/app/schedules/prepaids",
    "accrual":     "/app/schedules/accruals",
    "fixed_asset": "/app/schedules/fixed-assets",
    "lease":       "/app/schedules/leases",
    "loan":        "/app/schedules/loans",
}


def _iso(d: date | str) -> str:
    return d.isoformat() if isinstance(d, date) else str(d)


def dashboard(period: date | str | None = None) -> str:
    return f"/app?period={_iso(period)}" if period else "/app"


def recon_period(period: date | str) -> str:
    """The reconciliations dashboard for one period."""
    return f"/app/reconciliations/period/{_iso(period)}"


def recon_account(period: date | str, qbo_account_id: str | None) -> str:
    """One account's reconciliation, with its drawer open.

    Falls back to the period when there is no account id — still far better
    than the module root, and never produces `#acct=None`.
    """
    base = recon_period(period)
    return f"{base}#acct={qbo_account_id}" if qbo_account_id else base


def recon_ar() -> str:
    return "/app/reconciliations/ar"


def recon_ap() -> str:
    return "/app/reconciliations/ap"


def schedules(period: date | str | None = None, kind: str | None = None) -> str:
    base = _SCHEDULE_PAGES.get(kind or "", "/app/schedules")
    return f"{base}?period={_iso(period)}" if period else base


def close_workflow(period: date | str | None = None) -> str:
    return f"/app/close?period={_iso(period)}" if period else "/app/close"


def risk_radar(period: date | str | None = None) -> str:
    return f"/app/gl-accuracy?period={_iso(period)}" if period else "/app/gl-accuracy"


def flux_analysis(tb_id) -> str:
    return f"/app/flux/{tb_id}"


def tasks() -> str:
    """The task list. No period: TasksPage owns its own year/period filters and
    does not read the shared param, so adding one would be a lie in the URL."""
    return "/app/tasks"
