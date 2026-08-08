"""Cross-tenant authorization — who can reach which company.

This gates the deploy (`pytest -m invariant`, tagged by filename in
conftest.py). It is the control that decides whether one firm's staff can see
another firm's books, so a regression here is the worst class of bug this
product can have.

Membership comes from CLERK, not from local `User` rows. Those rows are created
LAZILY — on a member's first request inside a tenant — which broke both
directions:

  • An invited teammate had no row until they had already opened the company,
    so the firm view (whose job is listing the companies you can reach) showed
    them nothing. You had to be inside a company to discover it existed.
  • Nothing removes the row when someone is removed in Clerk, so revoking a
    person there left their access here intact.

The invariants:
  1. Membership is resolved from Clerk org ids, not local rows
  2. A member who has NEVER opened a company still sees it
  3. Someone removed in Clerk loses access, even with a local row still present
  4. Deleted tenants are excluded
  5. Clerk unreachable FAILS CLOSED — it raises, and never falls back to local
     rows, which is the behaviour being replaced

pytest isn't installed in every env, so this also runs standalone:
    python tests/test_cross_tenant_access.py
"""
import asyncio
import uuid

from modules.intercompany.router import (
    CrossTenantAccessUnavailable,
    _user_accessible_tenant_ids,
)

ORG_A, ORG_B, ORG_GONE = "org_aaa", "org_bbb", "org_deleted"
TENANT_A = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000000")
TENANT_B = uuid.UUID("bbbbbbbb-0000-0000-0000-000000000000")


class _FakeUser:
    clerk_user_id = "user_123"


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)


class _FakeDB:
    """Stands in for the session. Records that a query happened and returns the
    tenants whose clerk_org_id is in the requested set."""

    def __init__(self, org_to_tenant: dict[str, uuid.UUID]):
        self.org_to_tenant = org_to_tenant
        self.queried = False
        self.requested_orgs: list[str] = []

    async def execute(self, stmt, execution_options=None):  # noqa: ARG002
        self.queried = True
        # Pull the IN(...) values out of the compiled parameters. SQLAlchemy 2
        # renders IN as an *expanding* bindparam, so the value is a list under
        # one key rather than one key per element.
        orgs: list[str] = []
        for v in stmt.compile().params.values():
            if isinstance(v, str):
                orgs.append(v)
            elif isinstance(v, (list, tuple)):
                orgs.extend(x for x in v if isinstance(x, str))
        self.requested_orgs = orgs
        return _FakeResult([
            self.org_to_tenant[o] for o in orgs if o in self.org_to_tenant
        ])


def _patch_clerk(monkeypatch_target, value):
    """Replace list_user_org_ids with a stub returning `value`."""
    import core.auth.clerk_users as cu

    async def _stub(clerk_user_id, *, force=False):  # noqa: ARG001
        return value

    original = cu.list_user_org_ids
    cu.list_user_org_ids = _stub
    return original


def _restore_clerk(original):
    import core.auth.clerk_users as cu
    cu.list_user_org_ids = original


# ── 1 & 2. Membership comes from Clerk, not from having visited ──────────────

def test_member_sees_company_they_have_never_opened():
    """The reported bug: an invited teammate saw nothing in the firm view.

    They have no local User row until their first request INSIDE the company —
    so resolving access from those rows meant you had to already be in a company
    to discover it. Clerk knows they're a member the moment they're invited.
    """
    db = _FakeDB({ORG_A: TENANT_A, ORG_B: TENANT_B})
    original = _patch_clerk(None, [ORG_A, ORG_B])
    try:
        got = asyncio.run(_user_accessible_tenant_ids(db, _FakeUser()))
    finally:
        _restore_clerk(original)

    assert got == {TENANT_A, TENANT_B}
    # Resolved by clerk_org_id — no dependency on a User row existing.
    assert sorted(db.requested_orgs) == [ORG_A, ORG_B]


# ── 3. Revocation in Clerk takes effect here ─────────────────────────────────

def test_removed_in_clerk_loses_access():
    """A person removed from the Clerk organization must lose access even though
    their local User row is still sitting there — nothing deletes it."""
    db = _FakeDB({ORG_A: TENANT_A, ORG_B: TENANT_B})
    original = _patch_clerk(None, [ORG_A])          # removed from B in Clerk
    try:
        got = asyncio.run(_user_accessible_tenant_ids(db, _FakeUser()))
    finally:
        _restore_clerk(original)

    assert got == {TENANT_A}
    assert TENANT_B not in got


def test_no_memberships_means_no_access():
    db = _FakeDB({ORG_A: TENANT_A})
    original = _patch_clerk(None, [])
    try:
        got = asyncio.run(_user_accessible_tenant_ids(db, _FakeUser()))
    finally:
        _restore_clerk(original)

    assert got == set()
    # Nothing to look up — don't even hit the database.
    assert db.queried is False


# ── 4. Deleted tenants stay out ──────────────────────────────────────────────

def test_deleted_tenant_is_excluded():
    """A Clerk org can outlive the workspace. Only live tenants map through."""
    db = _FakeDB({ORG_A: TENANT_A})                 # ORG_GONE has no live tenant
    original = _patch_clerk(None, [ORG_A, ORG_GONE])
    try:
        got = asyncio.run(_user_accessible_tenant_ids(db, _FakeUser()))
    finally:
        _restore_clerk(original)

    assert got == {TENANT_A}


# ── 5. Fail CLOSED ───────────────────────────────────────────────────────────

def test_clerk_unreachable_fails_closed_and_never_uses_local_rows():
    """None means "we don't know", which must not be read as "belongs to
    nothing" and must never fall back to local User rows.

    Falling back is exactly the bug this replaces: a stale local row would
    reinstate access for someone already revoked. Raising lets the app answer
    503 (retry) instead of silently widening or narrowing access.
    """
    db = _FakeDB({ORG_A: TENANT_A})
    original = _patch_clerk(None, None)             # Clerk down
    try:
        raised = False
        try:
            asyncio.run(_user_accessible_tenant_ids(db, _FakeUser()))
        except CrossTenantAccessUnavailable:
            raised = True
        assert raised, "a Clerk outage must fail closed, not return a guess"
        assert db.queried is False, "must not consult local rows on a Clerk error"
    finally:
        _restore_clerk(original)


# ── 6. Cross-tenant handlers must run on the SYSTEM engine ───────────────────

def test_cross_tenant_endpoints_run_on_the_system_engine():
    """RLS is a second wall, and it fails SILENTLY.

    `skip_tenant_filter` lifts the SQLAlchemy filter only. Postgres RLS is
    enforced independently on the request login: migration 059 gives `tenants` a
    `tenant_self` policy (own row only) and every tenant table a
    `tenant_isolation` policy. A cross-tenant handler on the request session
    therefore returns just the ACTIVE company — no error, no warning, simply
    fewer rows. That is precisely how the firm view broke at the Tier 2 cutover
    and why nobody noticed for months.

    So the engine choice is a control, not a detail. Any handler that reads
    other companies must depend on get_system_db, with app-layer membership as
    its access check.
    """
    import os

    os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:x@localhost/x")
    from core.db.session import get_system_db
    from main import app

    # Paths that read ACROSS companies by design.
    must_bypass = {"/api/workspace/command-center"}

    seen = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        if path not in must_bypass:
            continue
        seen.add(path)
        deps = [d.call for d in getattr(route, "dependant", None).dependencies]
        assert get_system_db in deps, (
            f"{path} reads other companies but doesn't use get_system_db — "
            "RLS will silently clamp it to the active tenant."
        )

    assert seen == must_bypass, f"route(s) not found: {must_bypass - seen}"


if __name__ == "__main__":
    test_member_sees_company_they_have_never_opened()
    test_removed_in_clerk_loses_access()
    test_no_memberships_means_no_access()
    test_deleted_tenant_is_excluded()
    test_clerk_unreachable_fails_closed_and_never_uses_local_rows()
    test_cross_tenant_endpoints_run_on_the_system_engine()
    print("CROSS_TENANT_ACCESS_OK")
