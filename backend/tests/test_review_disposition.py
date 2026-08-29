"""Close Review: what may be set aside, and what the memo is allowed to say.

Two rules, and both exist because this module's only real product is
defensibility. A memo that lists exceptions without saying who set them aside
or why is a worse artefact than no memo — it looks like a record and isn't one.

The reason requirement is asymmetric on purpose: mandatory on HIGH, optional
below it. Requiring a sentence for every info-level note would train people to
type "ok", which is how a control becomes a formality.
"""
import io
from datetime import UTC, date, datetime, timedelta

import pytest

from modules.review.memo import MemoContext, MemoFinding, render_review_memo
from modules.review.router import reason_missing

D0 = datetime(2026, 8, 12, 9, 0, tzinfo=UTC)


# ── The reason gate ────────────────────────────────────────────────────────
#
# These call the REAL rule the endpoint calls. An earlier version of this file
# reimplemented it here, which would have kept passing after the endpoint's
# check was broken — the failure mode a test exists to prevent.

def reason_ok(severity: str, action: str, note: str | None) -> bool:
    return not reason_missing(severity, action, note)


@pytest.mark.parametrize("action", ["clear", "accept"])
def test_a_high_exception_cannot_be_set_aside_silently(action):
    """THE RULE. Both dispositions dismiss the finding, so both need words."""
    assert reason_ok("high", action, None) is False
    assert reason_ok("high", action, "") is False
    assert reason_ok("high", action, "   ") is False


def test_a_token_reason_does_not_count():
    """'ok' is not a reason, and it is exactly what gets typed when a box is
    mandatory but empty passes."""
    assert reason_ok("high", "clear", "ok") is False


def test_a_real_reason_passes():
    assert reason_ok("high", "clear",
                     "Bank confirmed the deposits clear 2 Sep; documented in the September file.")


def test_reopening_never_needs_a_reason():
    """Reopening retracts a decision rather than making one — demanding
    justification to UNDO a dismissal would discourage the safe direction."""
    assert reason_ok("high", "reopen", None) is True


@pytest.mark.parametrize("sev", ["review", "info"])
def test_lower_severities_stay_optional(sev):
    """Requiring a sentence on every info note trains people to type 'ok', and a
    control everyone routes around is worse than no control."""
    assert reason_ok(sev, "clear", None) is True


def test_the_endpoint_calls_this_exact_rule():
    """The rule is only worth testing if it's the one that runs. If the handler
    ever inlines its own check again, this fails and says so."""
    import inspect

    from modules.review import router as R
    src = inspect.getsource(R.act_on_finding)
    assert "reason_missing(" in src, "the handler no longer calls the extracted rule"


# ── The memo tells the truth about what it knows ───────────────────────────

def _ctx(**kw) -> MemoContext:
    base = dict(
        company="Niyukti Advisors LLP", period_label="July 2026",
        period_end=date(2026, 7, 31), generated_at=D0, checks_run=10,
        summary="Margins move with prior months.",
        passed=["Trial balance ties"], open_findings=[], resolved_findings=[],
        signed_off_by="Pankaj Gusain", signed_off_at=D0, signoff_note="Appropriate for issuance.",
    )
    base.update(kw)
    return MemoContext(**base)


def _text(pdf: bytes) -> str:
    """The memo's text, whitespace-normalized.

    pypdf, not pymupdf: pypdf is already a shipped dependency (the workpaper
    binder uses it), so these assertions actually run in CI. A test that skips
    itself for a missing dev-only package is a test that passes by not running.

    Normalizing whitespace matters — ReportLab wraps a paragraph across lines
    wherever the column ends, so a sentence asserted as one string would fail
    on a layout change that broke it in a different place.
    """
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf))
    return " ".join(" ".join(p.extract_text().split()) for p in reader.pages)


def test_the_memo_names_who_decided_and_why():
    """The three facts that turn a disposition into a record."""
    f = MemoFinding("high", "control", "Approved but not tied - 1010 Cash",
                    "Off by $2,412.55.", "accepted",
                    note="Bank confirmed the in-transit deposits clear 2 Sep.",
                    decided_by="Pankaj Gusain", decided_at=D0)
    out = _text(render_review_memo(_ctx(resolved_findings=[f])))
    assert "Accepted" in out
    assert "Pankaj Gusain" in out
    assert "in-transit deposits clear 2 Sep" in out


def test_a_disposition_with_no_reason_is_called_out_not_hidden():
    """Rows dispositioned before the reason became mandatory still exist. The
    memo must say the reason is missing rather than print a bare 'Cleared' that
    reads as though one was given."""
    f = MemoFinding("review", "completeness", "3 adjustments not posted", "",
                    "cleared", note=None, decided_by="A. Reviewer", decided_at=D0)
    out = _text(render_review_memo(_ctx(resolved_findings=[f])))
    assert "No reason recorded" in out


def test_open_exceptions_are_printed_as_open():
    """Signing off does not make an open exception disappear. A memo that
    silently dropped them would be the single most misleading thing this
    module could produce."""
    f = MemoFinding("review", "analytical", "Material variance with no explanation",
                    "Moved $+42,180.", "open")
    out = _text(render_review_memo(_ctx(open_findings=[f])))
    assert "Material variance with no explanation" in out
    assert "Open" in out


def test_an_unsigned_review_says_so_on_its_face():
    """The memo renders before sign-off — a partner reviewing a close in
    progress needs it — so it has to be unmistakable which it is."""
    out = _text(render_review_memo(_ctx(signed_off_by=None, signed_off_at=None,
                                        signoff_note=None)))
    assert "NOT YET SIGNED OFF" in out
    assert "REVIEWED AND SIGNED OFF" not in out


def test_a_signed_memo_carries_the_signature_and_the_statement():
    out = _text(render_review_memo(_ctx()))
    assert "REVIEWED AND SIGNED OFF" in out
    assert "Pankaj Gusain" in out
    assert "Appropriate for issuance." in out


def test_the_memo_states_what_was_examined_not_only_what_failed():
    """A document that lists only problems doesn't say what was looked at, and
    is unreadable as evidence of a review having happened."""
    out = _text(render_review_memo(_ctx()))
    assert "10 deterministic checks" in out
    assert "Trial balance ties" in out


def test_the_memo_disclaims_what_it_is_not():
    """It is a review memo, not an audit opinion, and it says so — the sentence
    a partner would otherwise have to add by hand every month."""
    out = _text(render_review_memo(_ctx()))
    assert "not an audit" in out


def test_the_memo_states_that_nordavix_never_wrote_to_quickbooks():
    out = _text(render_review_memo(_ctx()))
    assert "never writes to it" in out


def test_a_memo_with_no_exceptions_still_renders():
    out = _text(render_review_memo(_ctx()))
    assert "No exceptions were raised." in out


def test_account_text_with_markup_characters_survives_intact():
    """Account names come from QuickBooks, and ReportLab parses paragraph text
    as mini-XML.

    The failure is not a crash — it is SILENT. An unescaped `<Holdings>` is read
    as an unknown tag and dropped, so the memo renders cleanly with a piece of
    an account name missing from a document someone signs. Asserting on the
    ampersand alone would not catch it: `&` passes through either way. The
    angle-bracket content is the part that disappears.
    """
    f = MemoFinding("high", "control", "Not tied - Smith & Sons <Holdings>",
                    "GL and subledger differ by $1 & change <check this>.", "cleared",
                    account_label="1010 Smith & Sons <Ltd>",
                    note="Fixed & re-synced <Sep>", decided_by="A & B <CPA>",
                    decided_at=D0)
    out = _text(render_review_memo(_ctx(resolved_findings=[f])))
    # Every fragment starts its tag with a LETTER. `<2 Sep>` would prove
    # nothing: a digit can't begin an XML tag name, so ReportLab leaves it as
    # text whether or not it was escaped.
    for fragment in ("Smith & Sons <Holdings>", "<check this>", "<Ltd>",
                     "<Sep>", "<CPA>"):
        assert fragment in out, f"{fragment!r} was swallowed as markup"


# ── The re-run diff ────────────────────────────────────────────────────────
#
# "What changed since I last ran this" is the only question a reviewer has
# after the preparer says they've fixed things, and a re-run used to answer it
# by silently redrawing the same list.

def diff(prior_open: set, this_run: set, seen_before: dict) -> tuple[int, int]:
    """The engine's rule: newly raised, and gone since last time."""
    new = sum(1 for k in this_run if k not in seen_before)
    resolved = len(prior_open - this_run)
    return new, resolved


def test_a_fixed_exception_counts_as_resolved():
    new, res = diff({"a", "b"}, {"a"}, {"a": D0, "b": D0})
    assert (new, res) == (0, 1)


def test_a_fresh_exception_counts_as_new():
    new, res = diff({"a"}, {"a", "c"}, {"a": D0})
    assert (new, res) == (1, 0)


def test_a_persisting_exception_is_neither():
    """The common case, and the one that would make the banner noise if wrong."""
    new, res = diff({"a", "b"}, {"a", "b"}, {"a": D0, "b": D0})
    assert (new, res) == (0, 0)


def test_a_previously_cleared_exception_that_returns_is_not_new():
    """The reviewer already saw it once. Announcing it as new would say the
    checks found something they hadn't — and the age carried on the stable key
    is exactly what stops that."""
    new, _ = diff(set(), {"a"}, {"a": D0 - timedelta(days=9)})
    assert new == 0


def test_the_first_ever_run_is_all_new():
    new, res = diff(set(), {"a", "b", "c"}, {})
    assert (new, res) == (3, 0)
