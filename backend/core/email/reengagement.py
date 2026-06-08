"""
Re-engagement (win-back) drip — 5 feature-focused emails for users who signed up
but never activated. One every 3 days; the sweep in
``modules/reengagement/service.py`` decides who is due and stops the moment a
person activates or unsubscribes.

Branded like the welcome email (``core/email/welcome.py``) and self-contained so
the CAN-SPAM footer (one-click unsubscribe + a postal address) is part of every
message. ``send_reengagement_email`` is the best-effort entrypoint: resolves the
first name from Clerk, renders, sends with ``List-Unsubscribe`` headers, and
returns a bool so the caller only advances the sequence on a real send.

The copy in ``_STEPS`` is intended to be edited freely — change the words without
touching the rendering logic.
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
_FAINT = "#c4c4c8"
_GREEN = "#10b981"
_GREEN_DK = "#059669"

# CAN-SPAM requires a physical postal address in marketing email.
# Business mailing address shown in every drip email's footer.
_POSTAL_ADDRESS = "Nordavix · West New York, NJ 07093"

# ── The sequence. Edit the copy freely; keep the keys. ──────────────────────────
_STEPS: list[dict] = [
    {
        "subject":   "Your first reconciliation is 10 minutes away",
        "preheader": "Connect QuickBooks and Nordavix drafts the workpaper for you.",
        "heading":   "Let's get your first account reconciled",
        "body": [
            "You created a Nordavix account but haven't run a reconciliation yet. "
            "Here's the shortest path to the first one.",
            "Connect QuickBooks Online and your trial balance syncs automatically. "
            "Nordavix rolls last month's balances forward, ties the general ledger to "
            "the subledger, and drafts the workpaper. You just review and approve.",
        ],
        "bullets": [
            "No spreadsheets, no copy-paste",
            "Opening balances roll forward on their own",
            "Differences are surfaced, not buried",
        ],
        "cta": "Connect QuickBooks",
    },
    {
        "subject":   "Stop writing variance explanations by hand",
        "preheader": "Nordavix drafts the 'why' behind every movement.",
        "heading":   "Flux analysis that explains itself",
        "body": [
            "Month-end flux is mostly the same question over and over: why did this "
            "account move? Nordavix answers it for you.",
            "It pulls the transactions behind every material variance and writes a "
            "first-draft explanation, so your review starts at 'is this right?' "
            "instead of 'what happened here?'",
        ],
        "bullets": [],
        "cta": "See it on your books",
    },
    {
        "subject":   "Meet the close assistant that does the busywork",
        "preheader": "Agentic Mode prepares reconciliations and commentary for you.",
        "heading":   "Let the AI do the first pass",
        "body": [
            "Agentic Mode is the part people tell us feels like magic. Point it at an "
            "account and it prepares the reconciliation, drafts the commentary, and "
            "flags anything that needs a human.",
            "You stay in control — nothing is approved until you say so. It just "
            "removes the blank-page part of the close.",
        ],
        "bullets": [],
        "cta": "Try Agentic Mode",
    },
    {
        "subject":   "An audit-ready financial package, generated for you",
        "preheader": "Board-ready statements and an AI executive summary in one click.",
        "heading":   "Close, then hand over something polished",
        "body": [
            "When the close is done, Nordavix produces the financial package for you: "
            "income statement, balance sheet, cash flow, and an AI-written executive "
            "summary.",
            "It's the kind of report you'd be comfortable sending to an owner, a board, "
            "or an auditor — without spending a weekend formatting it.",
        ],
        "bullets": [],
        "cta": "Generate your package",
    },
    {
        "subject":   "Want us to set up your first close with you?",
        "preheader": "We'll do it together on a quick call — no charge during the beta.",
        "heading":   "Let's do your first close together",
        "body": [
            "You signed up a couple of weeks ago, so I'll keep this short. Nordavix is "
            "in beta, and we're helping a small group of teams run their first close "
            "inside it — personally.",
            "If you've been meaning to try it but haven't had a spare hour, just reply "
            "to this email. We'll get on a quick call and set up your first "
            "reconciliation together. No charge during the beta.",
        ],
        "bullets": [],
        "cta": "Open Nordavix",
    },
]

MAX_STEPS = len(_STEPS)


def render_reengagement_email(
    *, step: int, name: str | None, cta_url: str, unsubscribe_url: str,
) -> tuple[str, str, str]:
    """Return (subject, html, text) for re-engagement email number ``step`` (1-based)."""
    if step < 1 or step > MAX_STEPS:
        raise ValueError(f"re-engagement step out of range: {step}")
    s = _STEPS[step - 1]
    subject: str = s["subject"]
    preheader: str = s["preheader"]
    heading: str = s["heading"]
    body_paras: list[str] = s["body"]
    bullets: list[str] = s.get("bullets") or []
    cta_label: str = s["cta"]

    parts = urlsplit(cta_url)
    origin = f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""
    logo_url = escape((origin + "/email-logo.png?v=2") if origin else "", quote=True)
    safe_cta = escape(cta_url, quote=True)
    safe_unsub = escape(unsubscribe_url, quote=True)

    first = escape(name.strip()) if name and name.strip() else ""
    greeting = f"Hi {first}," if first else "Hi there,"

    logo = (
        f'<img src="{logo_url}" width="208" height="59" alt="Nordavix" '
        f'style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;height:59px;width:208px;">'
        if logo_url
        else f'<span style="font-family:{_FONT};font-size:22px;font-weight:700;color:{_INK};">'
             f'nordavix<span style="color:{_GREEN};">.</span></span>'
    )

    body_html = "".join(
        f'<p style="margin:0 0 14px;font-family:{_FONT};font-size:15px;line-height:1.6;color:{_BODY};">{p}</p>'
        for p in body_paras
    )

    bullets_html = ""
    if bullets:
        rows = "".join(
            f'<tr>'
            f'<td valign="top" width="22" style="padding:0 8px 9px 0;font-family:{_FONT};'
            f'font-size:15px;line-height:1.5;color:{_GREEN_DK};">&#10003;</td>'
            f'<td valign="top" style="padding:0 0 9px;font-family:{_FONT};font-size:14px;'
            f'line-height:1.55;color:{_BODY};">{b}</td>'
            f'</tr>'
            for b in bullets
        )
        bullets_html = (
            f'<tr><td style="padding:2px 34px 6px;">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>'
            f'</td></tr>'
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
    {escape(preheader)}{"&zwnj;&nbsp;" * 24}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:36px 12px;">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="max-width:524px;width:100%;background:#ffffff;border:1px solid #ececee;border-radius:16px;
               box-shadow:0 10px 30px rgba(17,24,39,0.07);overflow:hidden;">

        <!-- logo -->
        <tr><td align="center" style="padding:34px 34px 0;">{logo}</td></tr>

        <!-- heading + greeting -->
        <tr><td style="padding:24px 34px 0;">
          <p style="margin:0 0 12px;font-family:{_FONT};font-size:14px;color:{_MUTED};">{greeting}</p>
          <h1 style="margin:0;font-family:{_FONT};font-size:22px;line-height:1.3;font-weight:700;color:{_INK};">{heading}</h1>
        </td></tr>

        <!-- body -->
        <tr><td style="padding:14px 34px 0;">{body_html}</td></tr>

        <!-- bullets (optional) -->
        {bullets_html}

        <!-- CTA -->
        <tr><td align="center" style="padding:14px 34px 4px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="{safe_cta}" style="height:48px;v-text-anchor:middle;width:250px;" arcsize="21%" stroke="f" fillcolor="{_GREEN}">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">{escape(cta_label)} &#8594;</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="{safe_cta}" target="_blank"
             style="display:inline-block;background:{_GREEN};color:#ffffff;font-family:{_FONT};font-size:15px;
                    font-weight:700;line-height:1;text-decoration:none;padding:15px 30px;border-radius:10px;
                    box-shadow:0 6px 16px rgba(16,185,129,0.32);">{escape(cta_label)} &rarr;</a>
          <!--<![endif]-->
        </td></tr>

        <!-- divider -->
        <tr><td style="padding:24px 34px 0;">
          <div style="height:1px;line-height:1px;font-size:1px;background:#f0f0f1;">&nbsp;</div>
        </td></tr>

        <!-- footer -->
        <tr><td align="center" style="padding:16px 34px 30px;">
          <p style="margin:0 0 8px;font-family:{_FONT};font-size:12px;line-height:1.55;color:{_MUTED};">
            Questions? Just reply to this email — a real person reads every one.
          </p>
          <p style="margin:0 0 5px;font-family:{_FONT};font-size:11px;line-height:1.5;color:{_MUTED};">
            You're receiving this because you signed up for Nordavix.
            <a href="{safe_unsub}" style="color:{_MUTED};text-decoration:underline;">Unsubscribe</a>
          </p>
          <p style="margin:0;font-family:{_FONT};font-size:11px;line-height:1.5;color:{_FAINT};">
            {escape(_POSTAL_ADDRESS)}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>"""

    text_lines = [greeting, "", *body_paras]
    if bullets:
        text_lines += ["", *(f"  - {b}" for b in bullets)]
    text_lines += [
        "",
        f"{cta_label}: {cta_url}",
        "",
        "Questions? Just reply to this email — a real person reads every one.",
        f"Unsubscribe: {unsubscribe_url}",
        _POSTAL_ADDRESS,
    ]
    text = "\n".join(text_lines)

    return subject, html, text


async def send_reengagement_email(
    *, to_email: str, clerk_user_id: str, step: int, cta_url: str, unsubscribe_url: str,
) -> bool:
    """Resolve the first name from Clerk, render, and send step ``step``. Best-effort:
    no-ops (returns False) when email is disabled; never raises. Returns True only on
    a real send so the caller advances the sequence."""
    if not settings.email_enabled or not to_email:
        return False
    try:
        first: str | None = None
        try:
            cu = await get_clerk_user(clerk_user_id)
            if cu:
                first = (cu.get("first_name") or "").strip() or None
        except Exception:
            first = None  # name is a nice-to-have; send anyway
        subject, html, text = render_reengagement_email(
            step=step, name=first, cta_url=cta_url, unsubscribe_url=unsubscribe_url,
        )
        return await send_email(
            to=to_email, subject=subject, html=html, text=text,
            reply_to=settings.feedback_to_email or None,
            from_email=settings.notifications_from_email,
            headers={
                "List-Unsubscribe": f"<{unsubscribe_url}>",
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
        )
    except Exception:
        logger.exception("Re-engagement email failed (non-fatal)")
        return False
