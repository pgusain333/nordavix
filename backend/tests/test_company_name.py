"""The workspace's name, exactly as the person who owns it typed it.

`Tenant.name` is seeded with the raw Clerk org id, and exactly one endpoint —
the firm dashboard — ever healed it. So what a caller got depended on whether
anyone had happened to open that screen, and three callers each patched around
it separately: "Your company", "Your accountant", "Workspace". The Copilot's
PDF had no patch and fell back to "Nordavix", printing the vendor's name where
the client's belonged, on a page the client reads.

These pin the two halves that matter: a real name is returned untouched, and a
placeholder is never returned as though it were a name.
"""
import uuid

import pytest

from core.tenancy.company import company_name, is_placeholder

# ── Recognising a placeholder ─────────────────────────────────────────────────

def test_a_raw_clerk_org_id_is_a_placeholder():
    assert is_placeholder("org_2abc123XYZ") is True


def test_an_empty_or_blank_name_is_a_placeholder():
    assert is_placeholder(None) is True
    assert is_placeholder("") is True
    assert is_placeholder("   ") is True


def test_a_real_company_name_is_not_a_placeholder():
    assert is_placeholder("Smith CPA") is False


def test_a_company_whose_name_merely_starts_with_org_is_not_a_placeholder():
    """The check is an exact prefix on "org_", not a substring or a word match.
    "Organic Foods" and "Organization for X" are real names people have."""
    for real in ("Organic Foods Ltd", "Organization for Trade", "Orgo Labs", "ORG Partners"):
        assert is_placeholder(real) is False, real


# ── Verbatim ──────────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _FakeDb:
    """Just enough AsyncSession to answer the one SELECT the accessor makes."""
    def __init__(self, row):
        self._row = row

    async def execute(self, *_a, **_kw):
        return _Result(self._row)


class _Tenant:
    def __init__(self, name, clerk_org_id="org_x"):
        self.name = name
        self.clerk_org_id = clerk_org_id


@pytest.mark.asyncio
@pytest.mark.parametrize("name", [
    "smith cpa",                    # lower case, deliberately
    "SMITH CPA",                    # upper case, deliberately
    "Ãcme & Co.",                   # non-ASCII and an ampersand
    "O'Brien, Nolan & Partners",    # apostrophe and commas
    "Numbers 123 LLC",
    "  Padded Name  ",              # whatever they typed, including the padding
])
async def test_a_real_name_comes_back_byte_for_byte(name):
    """No title-casing, no ASCII-folding, no trimming, no truncation. Whatever
    the admin set is what prints on the cover of a document their client reads.
    Callers that need a FILENAME sanitise a copy; the displayed name is never
    touched."""
    assert await company_name(_FakeDb(_Tenant(name)), uuid.uuid4()) == name


@pytest.mark.asyncio
async def test_a_missing_tenant_falls_back_rather_than_crashing_an_export():
    assert await company_name(_FakeDb(None), uuid.uuid4(), fallback="Workspace") == "Workspace"


@pytest.mark.asyncio
async def test_the_caller_chooses_the_fallback_wording():
    """The PBC magic link wants "Your accountant"; an export cover wants
    "Workspace". What none of them should ever say is "Nordavix" — the vendor's
    name where the client's belongs, which is what the Copilot PDF did."""
    assert await company_name(_FakeDb(None), uuid.uuid4(),
                              fallback="Your accountant") == "Your accountant"


@pytest.mark.asyncio
async def test_a_placeholder_is_never_returned_as_though_it_were_a_name(monkeypatch):
    """The whole point. With Clerk unreachable the answer is the fallback —
    printing "org_2abc123" on a client's PDF is the failure being fixed."""
    async def _no_clerk(_org_id):
        return None
    monkeypatch.setattr("core.auth.clerk_users.get_clerk_org_name", _no_clerk)
    out = await company_name(_FakeDb(_Tenant("org_2abc123")), uuid.uuid4(),
                             fallback="Workspace")
    assert out == "Workspace"
    assert "org_" not in out


@pytest.mark.asyncio
async def test_a_placeholder_resolves_against_clerk_when_it_can(monkeypatch):
    async def _clerk(_org_id):
        return "Smith CPA"
    monkeypatch.setattr("core.auth.clerk_users.get_clerk_org_name", _clerk)
    assert await company_name(_FakeDb(_Tenant("org_2abc123")), uuid.uuid4()) == "Smith CPA"


@pytest.mark.asyncio
async def test_resolving_a_placeholder_never_writes_to_the_callers_session(monkeypatch):
    """It is called from inside an autopilot run and from export handlers that
    own their transactions. A read accessor that commits their in-flight work —
    or leaves the session dirty so their next commit writes something they
    never asked for — is a worse bug than an extra cached lookup."""
    async def _clerk(_org_id):
        return "Smith CPA"
    monkeypatch.setattr("core.auth.clerk_users.get_clerk_org_name", _clerk)

    tenant = _Tenant("org_2abc123")
    db = _FakeDb(tenant)
    db.commit = None  # calling it would raise TypeError rather than pass quietly

    assert await company_name(db, uuid.uuid4()) == "Smith CPA"
    # The row is left exactly as found; persisting stays with the firm view.
    assert tenant.name == "org_2abc123"
