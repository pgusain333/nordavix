"""The continuous-close digest email.

This is the one part of Nordavix that arrives uninvited, in an inbox, next to
the client's other mail. Two things have to hold or it does more harm than good:
it must look like Nordavix sent it, and it must never claim more than the scan
found.

The HTML itself is a hostile target (Gmail strips <style>, Outlook renders with
Word), so the shell is table-based and inline-styled and shared with the
notification email — these tests pin the parts that would silently rot: the
logo, the escaping, and the arithmetic in the subject line.
"""
from core.email.templates import render_notification_email, render_watch_digest_email

CTA = "https://app.nordavix.com/app/gl-accuracy?period=2026-08-31"


def _items(n=3):
    return [
        {"title": f"Vendor {i}: Office Supplies → Hosting", "detail": f"detail {i}",
         "severity": "high" if i == 0 else "medium", "amount": f"${i + 1},200"}
        for i in range(n)
    ]


def _render(**kw):
    args = {"period_label": "August 2026", "items": _items(), "new_count": 3,
            "scanned": 1847, "cta_url": CTA, "workspace_name": "Niyukti"}
    args.update(kw)
    return render_watch_digest_email(**args)


# ── It has to look like us ─────────────────────────────────────────────────

def test_the_email_carries_the_nordavix_brand():
    _s, html, _t = _render()
    assert "email-logo.png" in html, "no logo — the mail is anonymous"
    assert "#8B1538" in html, "missing the burgundy accent rule"
    assert "Nordavix" in html


def test_the_logo_and_settings_link_follow_the_app_origin():
    """Hard-coding a host means the logo 404s the moment the app moves, and a
    broken image in a monitoring email reads as a phishing attempt."""
    _s, html, _t = _render(cta_url="https://staging.example.com/app/gl-accuracy")
    assert "https://staging.example.com/email-logo.png" in html
    assert "https://staging.example.com/app/settings" in html


def test_it_uses_the_same_shell_as_the_notification_email():
    """One brand, not two. If the shells diverge, one of them gets updated and
    the other quietly becomes the old design."""
    _s, digest, _t = _render()
    _s2, notif, _t2 = render_notification_email(
        title="x", body=None, cta_url=CTA,
    )
    for marker in ("#8B1538", "email-logo.png", "Manage preferences",
                   "AI-native month-end close"):
        assert marker in digest and marker in notif, marker


def test_the_badge_names_the_feature():
    _s, html, _t = _render()
    assert "Continuous close" in html


# ── It has to be honest ────────────────────────────────────────────────────

def test_the_subject_states_the_count_and_the_month():
    subject, _h, _t = _render(new_count=3)
    assert "3 new items" in subject and "August 2026" in subject


def test_one_item_is_singular():
    subject, html, text = _render(new_count=1, items=_items(1))
    assert "1 new item " in subject + " "
    assert "new items" not in subject
    assert "new items" not in html


def test_it_says_nothing_was_written_to_quickbooks():
    """The product's whole stance, and the first question a client asks when an
    automated email says their books were examined overnight."""
    _s, html, text = _render()
    assert "Nothing was written to QuickBooks" in html
    assert "Nothing was written to QuickBooks" in text


def test_a_long_list_is_truncated_honestly_not_silently():
    """The caller passes the first few items and the true total. Showing 6 rows
    under a subject that says 20 without saying so would understate the day."""
    _s, html, text = _render(items=_items(6), new_count=20)
    assert "and 14 more" in html
    assert "and 14 more" in text


def test_the_counts_are_not_invented_when_there_are_no_items_to_list():
    """A findings lookup that comes back empty must not turn into a mail that
    claims zero — the count is what the scan reported."""
    subject, html, _t = _render(items=[], new_count=4)
    assert "4 new items" in subject
    assert "and 4 more" not in html   # nothing was listed, so nothing was elided


# ── It has to survive real data ────────────────────────────────────────────

def test_vendor_names_are_escaped():
    """Vendor names come from QuickBooks — user-supplied text on its way into an
    email body."""
    _s, html, _t = _render(items=[{
        "title": "<script>alert(1)</script> & Co",
        "detail": "a > b", "severity": "high", "amount": "$1",
    }])
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "a &gt; b" in html


def test_the_workspace_name_is_escaped_in_the_subject_path():
    subject, html, _t = _render(workspace_name="Smith & Sons")
    assert "Smith & Sons" in subject           # subject is plain text
    assert "Smith &amp; Sons" not in subject


def test_a_missing_detail_or_amount_does_not_break_the_row():
    _s, html, text = _render(items=[{"title": "Just a title", "severity": "low"}])
    assert "Just a title" in html and "Just a title" in text


# ── It has to be readable in a dark inbox ──────────────────────────────────
#
# Apple Mail and iOS keep the <style> block, so dark mode is handled by class
# overrides (.nv-ink, .nv-body, .nv-muted). An element that sets a dark ink
# colour inline WITHOUT the matching class keeps it: near-black text on a
# near-black card. The one that bit was the amount column — the single number a
# reader scans the row for.

_DARK_PAIRS = (("#111827", "nv-ink"), ("#374151", "nv-body"), ("#9ca3af", "nv-muted"))


def _tags(html: str):
    """Every opening tag, crudely — enough to check what class it carries."""
    import re
    return re.findall(r"<[a-zA-Z][^>]*>", html)


def _dark_mode_offenders(html: str) -> list[str]:
    out = []
    for tag in _tags(html):
        for colour, cls in _DARK_PAIRS:
            if f"color:{colour}" in tag and cls not in tag:
                out.append(tag[:120])
    return out


def test_every_dark_ink_colour_carries_its_dark_mode_class():
    _s, html, _t = _render()
    offenders = _dark_mode_offenders(html)
    assert not offenders, (
        "these set a dark colour inline with no class for the dark-mode "
        "override to hook: " + " | ".join(offenders)
    )


def test_the_notification_email_holds_the_same_rule():
    _s, html, _t = render_notification_email(
        title="Something happened", body="with a quoted line", cta_url=CTA,
    )
    assert not _dark_mode_offenders(html)


def test_the_amount_column_specifically():
    """The regression that shipped: the row title was overridden, the figure
    beside it was not, so the amount vanished on a phone in dark mode."""
    _s, html, _t = _render(items=[
        {"title": "Repairs", "amount": "$14,000", "severity": "high"},
    ])
    cell = next(t for t in _tags(html) if "align=\"right\"" in t and "nv-" in t)
    assert "nv-ink" in cell


def test_the_plain_text_alternative_lists_the_same_items():
    """Some clients render text only; a body that says 'view in HTML' is a
    monitoring email nobody reads on a phone."""
    _s, _h, text = _render()
    for it in _items():
        assert it["title"] in text
    assert CTA in text
