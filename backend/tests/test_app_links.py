"""Every in-app link lands somewhere real.

A link that reads as a fix and goes nowhere is worse than no link: it spends the
reader's trust and returns nothing. These tests hold the builders in core.links
against the frontend itself — the Route table in App.tsx, and the two URL
conventions the pages implement — so a renamed route or a dropped param breaks
the backend suite instead of a user's click.

The bug they exist for: notifications named the object and linked to the
neighbourhood. "marked account 84 (2026-03-31) prepared" pointed at
/app/reconciliations, leaving the reader to find one account among forty in a
period the link didn't select either.
"""
import pathlib
import re
from datetime import date

import pytest

from core import links

FRONTEND = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "src"
APP_TSX = FRONTEND / "App.tsx"
PERIOD_HOOK = FRONTEND / "core" / "hooks" / "useSelectedPeriod.ts"
RECON_DRAWER = FRONTEND / "modules" / "recons" / "components" / "AccountDetailDrawer.tsx"

PE = date(2026, 3, 31)


def _declared_routes() -> set[str]:
    """Every `/app/...` path App.tsx declares, with :params stripped to a stem."""
    src = APP_TSX.read_text(encoding="utf-8")
    # The app shell mounts at path="/app/*" and its children are declared
    # relative, so "/app" itself never appears as a nested Route. It is the
    # dashboard's own address; add it explicitly.
    assert 'path="/app/*"' in src, "app shell route not found — parser needs updating"
    out = {"/app"}
    for path in re.findall(r'<Route\s+path="([^"]+)"', src):
        if path in ("*", "/") or path.startswith("/"):
            continue                      # top-level/public routes, not /app/*
        out.add(f"/app/{path}")
    return out


def _route_matches(url: str, routes: set[str]) -> bool:
    """Does `url` resolve to a declared route? Strips query + hash, then
    compares segment-wise so `:param` segments match anything."""
    path = url.split("#", 1)[0].split("?", 1)[0]
    want = path.strip("/").split("/")
    for r in routes:
        have = r.strip("/").split("/")
        if len(have) != len(want):
            continue
        if all(h.startswith(":") or h == w for h, w in zip(have, want, strict=True)):
            return True
    return False


ALL_LINKS = {
    "dashboard":            links.dashboard(PE),
    "dashboard_bare":       links.dashboard(),
    "recon_period":         links.recon_period(PE),
    "recon_account":        links.recon_account(PE, "84"),
    "recon_account_no_id":  links.recon_account(PE, None),
    "recon_ar":             links.recon_ar(),
    "recon_ap":             links.recon_ap(),
    "schedules":            links.schedules(),
    "schedules_period":     links.schedules(PE),
    "schedules_kind":       links.schedules(PE, "prepaid"),
    "close":                links.close_workflow(PE),
    "close_bare":           links.close_workflow(),
    "risk":                 links.risk_radar(PE),
    "risk_bare":            links.risk_radar(),
    "flux":                 links.flux_analysis("abc-123"),
    "tasks":                links.tasks(),
}


@pytest.mark.parametrize("name,url", sorted(ALL_LINKS.items()))
def test_every_builder_resolves_to_a_declared_route(name, url):
    routes = _declared_routes()
    assert "/app/reconciliations/period/:periodEnd" in routes, "route parse looks wrong"
    assert _route_matches(url, routes), f"{name}: {url} matches no declared route"


@pytest.mark.parametrize("name,url", sorted(ALL_LINKS.items()))
def test_no_builder_emits_a_none_or_empty_segment(name, url):
    """`#acct=None` and `?period=None` are the classic ways a builder
    "succeeds" and produces a dead link."""
    assert "None" not in url, f"{name}: {url}"
    assert "//" not in url.replace("://", ""), f"{name}: {url}"
    assert not url.endswith("="), f"{name}: {url}"


# ── The two conventions the frontend actually implements ────────────────────

def test_the_period_param_is_the_one_the_hook_reads():
    """useSelectedPeriod honours `?period=`. A builder emitting any other key
    silently loses the month."""
    hook = PERIOD_HOOK.read_text(encoding="utf-8")
    assert '.get("period")' in hook, "the hook no longer reads ?period="
    for name, url in ALL_LINKS.items():
        if "?" in url:
            key = url.split("?", 1)[1].split("=", 1)[0]
            assert key == "period", f"{name} uses ?{key}= which nothing reads"


def test_the_account_hash_is_the_one_the_drawer_reads():
    """The recon dashboard opens a drawer from `#acct=`."""
    drawer = RECON_DRAWER.read_text(encoding="utf-8")
    assert "acct=" in drawer, "the drawer no longer reads #acct="
    url = links.recon_account(PE, "84")
    assert url.endswith("#acct=84")


def test_a_missing_account_degrades_to_the_period_not_to_a_broken_hash():
    assert links.recon_account(PE, None) == links.recon_period(PE)


def test_period_is_rendered_as_iso_whether_a_date_or_a_string_is_passed():
    """Call sites hold a date in some places and a request-body string in
    others; both must produce the same URL."""
    assert links.recon_period(PE) == links.recon_period("2026-03-31")
    assert links.close_workflow(PE) == links.close_workflow("2026-03-31")


def test_tasks_takes_no_period_because_its_page_does_not_read_one():
    """TasksPage owns its own year/period filters and never reads the shared
    param. A ?period= there would be a claim the page doesn't honour."""
    assert "?" not in links.tasks()


# ── The regression this is all for ──────────────────────────────────────────

def test_no_notification_still_points_at_a_bare_module_root():
    """The reported shape: a notification that names an account and period, and
    links to /app/reconciliations. Scan the producers for the literal."""
    backend = pathlib.Path(__file__).resolve().parents[1]
    offenders = []
    for py in (backend / "modules").rglob("*.py"):
        if "__pycache__" in str(py):
            continue
        for i, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if re.search(r'link\s*=\s*"/app(/[a-z-]+)?"', stripped):
                offenders.append(f"{py.relative_to(backend)}:{i}: {stripped}")
    assert not offenders, "notification links must carry their context:\n" + "\n".join(offenders)
