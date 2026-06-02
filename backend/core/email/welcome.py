"""
First-sign-in welcome email — sent once per person the first time they reach
the app. Intentionally simple: the logo lockup, a warm line, three getting-
started steps, one button. Mostly ink + grey with a single green accent.

`send_welcome_email` is the best-effort background entrypoint (resolves the
first name from Clerk, renders, sends). Never raises.
"""
from __future__ import annotations

import logging
from html import escape
from urllib.parse import urlsplit

from core.auth.clerk_users import get_clerk_user
from core.config import settings
from core.email.sender import send_email

logger = logging.getLogger(__name__)

_FONT = (
    "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',"
    "Roboto,Helvetica,Arial,sans-serif"
)
_INK = "#111827"
_BODY = "#4b5563"
_MUTED = "#9ca3af"
_GREEN = "#10b981"
_GREEN_DK = "#059669"

_STEPS = [
    ("Connect QuickBooks Online", "Your trial balance and general ledger sync automatically."),
    ("Set your books start date", "Nordavix rolls your opening balances forward for you."),
    ("Reconcile &amp; explain", "AI drafts the workpapers and variance commentary — you review and approve."),
]


def render_welcome_email(*, name: str | None, cta_url: str) -> tuple[str, str, str]:
    """Return (subject, html, text) for the welcome email."""
    parts = urlsplit(cta_url)
    origin = f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""
    logo_url = escape((origin + "/email-logo.png") if origin else "", quote=True)
    safe_url = escape(cta_url, quote=True)

    first = escape(name.strip()) if name and name.strip() else ""
    heading = f"Welcome to Nordavix, {first}" if first else "Welcome to Nordavix"
    subject = f"Welcome to Nordavix, {name.strip()}" if name and name.strip() else "Welcome to Nordavix"

    logo = (
        f'<img src="{logo_url}" width="208" height="59" alt="Nordavix" '
        f'style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;height:59px;width:208px;">'
        if logo_url
        else f'<span style="font-family:{_FONT};font-size:22px;font-weight:700;color:{_INK};">'
             f'nordavix<span style="color:{_GREEN};">.</span></span>'
    )

    steps_rows = "".join(
        f"""\
        <tr>
          <td width="36" valign="top" style="padding:0 14px 18px 0;">
            <div style="width:26px;height:26px;border-radius:999px;background:#ecfdf5;color:{_GREEN_DK};
                        font-family:{_FONT};font-size:12px;font-weight:700;text-align:center;line-height:26px;">{i}</div>
          </td>
          <td valign="top" style="padding:0 0 18px;">
            <p style="margin:0 0 2px;font-family:{_FONT};font-size:15px;font-weight:700;color:{_INK};">{head}</p>
            <p style="margin:0;font-family:{_FONT};font-size:13px;line-height:1.55;color:{_BODY};">{sub}</p>
          </td>
        </tr>"""
        for i, (head, sub) in enumerate(_STEPS, start=1)
    )

    html = f"""\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>{escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;">
    Welcome to Nordavix — here's how to close your first month.{"&zwnj;&nbsp;" * 24}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:36px 12px;">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="max-width:524px;width:100%;background:#ffffff;border:1px solid #ececee;border-radius:16px;
               box-shadow:0 10px 30px rgba(17,24,39,0.07);overflow:hidden;">

        <!-- logo -->
        <tr><td align="center" style="padding:34px 34px 0;">{logo}</td></tr>

        <!-- heading -->
        <tr><td align="center" style="padding:24px 34px 0;">
          <h1 style="margin:0;font-family:{_FONT};font-size:23px;line-height:1.3;font-weight:700;color:{_INK};">{heading}</h1>
          <p style="margin:10px 0 0;font-family:{_FONT};font-size:15px;line-height:1.6;color:{_BODY};">
            You're all set. Nordavix turns the month-end close into a guided, AI-assisted
            workflow — reconcile every account, explain every variance, and lock the period
            with confidence.
          </p>
        </td></tr>

        <!-- steps -->
        <tr><td style="padding:26px 34px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{steps_rows}</table>
        </td></tr>

        <!-- CTA -->
        <tr><td align="center" style="padding:8px 34px 4px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="{safe_url}" style="height:48px;v-text-anchor:middle;width:230px;" arcsize="21%" stroke="f" fillcolor="{_GREEN}">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Open your dashboard &#8594;</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="{safe_url}" target="_blank"
             style="display:inline-block;background:{_GREEN};color:#ffffff;font-family:{_FONT};font-size:15px;
                    font-weight:700;line-height:1;text-decoration:none;padding:15px 32px;border-radius:10px;
                    box-shadow:0 6px 16px rgba(16,185,129,0.32);">Open your dashboard &rarr;</a>
          <!--<![endif]-->
        </td></tr>

        <!-- divider -->
        <tr><td style="padding:24px 34px 0;">
          <div style="height:1px;line-height:1px;font-size:1px;background:#f0f0f1;">&nbsp;</div>
        </td></tr>

        <!-- footer -->
        <tr><td align="center" style="padding:16px 34px 30px;">
          <p style="margin:0 0 5px;font-family:{_FONT};font-size:12px;line-height:1.55;color:{_MUTED};">
            Questions? Just reply to this email — a real person reads it.
          </p>
          <p style="margin:0;font-family:{_FONT};font-size:11px;line-height:1.5;color:#c4c4c8;">
            Nordavix &middot; AI-native month-end close
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>"""

    text = (
        f"{heading}\n\n"
        "You're all set. Nordavix turns the month-end close into a guided, AI-assisted "
        "workflow — reconcile every account, explain every variance, and lock the period.\n\n"
        "Getting started:\n"
        "  1. Connect QuickBooks Online — your trial balance and GL sync automatically.\n"
        "  2. Set your books start date — Nordavix rolls opening balances forward.\n"
        "  3. Reconcile & explain — AI drafts the workpapers; you review and approve.\n\n"
        f"Open your dashboard: {cta_url}\n\n"
        "Questions? Just reply to this email — a real person reads it.\n"
        "Nordavix · AI-native month-end close"
    )

    return subject, html, text


async def send_welcome_email(*, to_email: str, clerk_user_id: str, cta_url: str) -> None:
    """Resolve the user's first name from Clerk, render, and send. Best-effort:
    no-ops when email is disabled, never raises (fired from BackgroundTasks)."""
    if not settings.email_enabled or not to_email:
        return
    try:
        first: str | None = None
        try:
            cu = await get_clerk_user(clerk_user_id)
            if cu:
                first = (cu.get("first_name") or "").strip() or None
        except Exception:
            first = None  # name is a nice-to-have; send anyway
        subject, html, text = render_welcome_email(name=first, cta_url=cta_url)
        await send_email(
            to=to_email, subject=subject, html=html, text=text,
            reply_to=settings.feedback_to_email or None,
            from_email=settings.notifications_from_email,
        )
    except Exception:
        logger.exception("Welcome email failed (non-fatal)")
