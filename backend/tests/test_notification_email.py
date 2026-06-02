"""Unit tests for the notification email template (pure, no DB)."""
from core.email.templates import render_notification_email


def test_renders_subject_body_and_cta():
    subject, html, text = render_notification_email(
        title="Pankaj mentioned you",
        body="Take a look at the AR recon",
        cta_url="https://app.nordavix.com/app/reconciliations",
    )
    assert subject == "Pankaj mentioned you"
    assert "Pankaj mentioned you" in html
    assert "Take a look at the AR recon" in html
    assert "https://app.nordavix.com/app/reconciliations" in html
    assert "Open in Nordavix" in html
    # Plain-text fallback carries the raw link (not escaped).
    assert "https://app.nordavix.com/app/reconciliations" in text


def test_escapes_user_supplied_content():
    _subject, html, _text = render_notification_email(
        title="<script>alert(1)</script>",
        body="<b>bold</b> & stuff",
        cta_url="https://app.nordavix.com/app",
    )
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "&amp; stuff" in html


def test_handles_missing_body():
    _subject, html, _text = render_notification_email(
        title="Books closed for 2026-05-31",
        body=None,
        cta_url="https://app.nordavix.com/app",
    )
    assert "Books closed for 2026-05-31" in html
    assert "Open in Nordavix" in html
