"""
HTML for transactional notification emails.

Email clients are a hostile rendering target: <style> blocks are stripped by
Gmail, fl/grid don't work, Outlook uses Word's engine. So this is table-based,
inline-styled, with a VML fallback for the Outlook button and a progressive
dark-mode <style> for clients that keep it (Apple Mail / iOS). User-supplied
text (titles, comment excerpts) is HTML-escaped.

`render_notification_email` is a drop-in: same required args as before
(title, body, cta_url), with optional `type_label` for the little eyebrow pill
and an auto-derived "Manage preferences" link.
"""
from __future__ import annotations

from html import escape
from urllib.parse import urlsplit

# One font stack, reused everywhere (inline — clients ignore <style> fonts).
_FONT = (
    "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',"
    "Roboto,Helvetica,Arial,sans-serif"
)

# Brand
_BURGUNDY = "#8B1538"   # marketing hero — used as the thin top accent only
_GREEN = "#10b981"      # action accent — CTA, the wordmark dot, the quote rule
_GREEN_DK = "#059669"
_INK = "#111827"
_BODY = "#374151"
_MUTED = "#9ca3af"

# Progressive dark-mode (Apple Mail / iOS keep <style>; Gmail strips it — fine).
_HEAD_STYLE = """\
<style>
  @media (prefers-color-scheme: dark) {
    body, .nv-bg { background:#0b0b0f !important; }
    .nv-card { background:#17171c !important; border-color:#27272e !important; box-shadow:none !important; }
    .nv-ink { color:#f5f5f7 !important; }
    .nv-body { color:#cdcdd4 !important; }
    .nv-quote { background:#1d1d23 !important; }
    .nv-muted { color:#8a8a93 !important; }
    .nv-faint { color:#5f5f68 !important; }
  }
  a { text-decoration:none; }
  @media only screen and (max-width:600px) {
    .nv-pad { padding-left:22px !important; padding-right:22px !important; }
  }
</style>"""


def render_notification_email(
    *,
    title: str,
    body: str | None,
    cta_url: str,
    cta_label: str = "Open in Nordavix",
    actor_name: str | None = None,  # reserved; the title usually already names the actor
    type_label: str | None = None,  # small eyebrow pill, e.g. "New mention"
) -> tuple[str, str, str]:
    """Return (subject, html, text) for one notification email."""
    subject = title.strip() or "New notification"

    safe_title = escape(title.strip())
    safe_body = escape(body.strip()) if body and body.strip() else ""
    safe_url = escape(cta_url, quote=True)
    safe_cta = escape(cta_label)

    # "Manage preferences" → settings page on the same origin as the CTA link.
    parts = urlsplit(cta_url)
    origin = f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""
    settings_url = escape((origin + "/app/settings") if origin else cta_url, quote=True)

    # Brand mark: the real logo image (served from the frontend origin, same as
    # the welcome / re-engagement emails) with the text wordmark as a fallback
    # if we can't derive an origin. Versioned query defeats stale CDN/proxy caches.
    logo_url = escape((origin + "/email-logo.png?v=2") if origin else "", quote=True)
    wordmark = (
        f'<span class="nv-ink" style="color:{_INK};">nordavix</span>'
        f'<span style="color:{_GREEN};">.</span>'
    )
    brand = (
        f'<img src="{logo_url}" width="156" height="44" alt="Nordavix" '
        f'style="display:block;border:0;outline:none;text-decoration:none;width:156px;height:44px;">'
        if logo_url else wordmark
    )

    # Inbox-preview text, then zero-width spacers so the client doesn't pull the
    # body/quoted-text into the preview line.
    preheader = escape((body or title).strip()[:140])
    spacer = "&zwnj;&nbsp;" * 30

    badge = (
        f'<span class="nv-pill" style="display:inline-block;background:#ecfdf5;color:{_GREEN_DK};'
        f"font-family:{_FONT};font-size:10px;font-weight:700;letter-spacing:0.07em;"
        f'text-transform:uppercase;padding:5px 11px;border-radius:999px;white-space:nowrap;">'
        f"{escape(type_label)}</span>"
        if type_label else ""
    )

    quote = (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 6px;">'
        f"<tr><td class=\"nv-quote\" style=\"background:#f9fafb;border-left:3px solid {_GREEN};"
        f'border-radius:8px;padding:14px 16px;">'
        f'<p class="nv-body" style="margin:0;font-family:{_FONT};font-size:15px;line-height:1.65;color:{_BODY};">'
        f"{safe_body}</p></td></tr></table>"
        if safe_body else ""
    )

    html = f"""\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{safe_title}</title>
{_HEAD_STYLE}
</head>
<body class="nv-bg" style="margin:0;padding:0;background:#f4f4f5;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;">{preheader}{spacer}</div>
  <table role="presentation" class="nv-bg" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:34px 12px;">

      <table role="presentation" class="nv-card" width="100%" cellpadding="0" cellspacing="0"
        style="max-width:524px;width:100%;background:#ffffff;border:1px solid #ececee;border-radius:16px;
               box-shadow:0 10px 30px rgba(17,24,39,0.07);overflow:hidden;">

        <!-- brand accent -->
        <tr><td style="height:4px;line-height:4px;font-size:4px;background:{_BURGUNDY};">&nbsp;</td></tr>

        <!-- header: wordmark + type pill -->
        <tr><td class="nv-pad" style="padding:26px 34px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td align="left" style="font-family:{_FONT};font-size:20px;font-weight:700;letter-spacing:-0.02em;">
              {brand}
            </td>
            <td align="right">{badge}</td>
          </tr></table>
        </td></tr>

        <!-- title + message -->
        <tr><td class="nv-pad" style="padding:20px 34px 6px;">
          <h1 class="nv-ink" style="margin:0 0 {'12px' if quote else '4px'};font-family:{_FONT};
              font-size:21px;line-height:1.34;font-weight:700;color:{_INK};">{safe_title}</h1>
          {quote}
        </td></tr>

        <!-- CTA -->
        <tr><td class="nv-pad" style="padding:14px 34px 2px;" align="left">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="{safe_url}" style="height:48px;v-text-anchor:middle;width:236px;" arcsize="21%" stroke="f" fillcolor="{_GREEN}">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">{safe_cta} &#8594;</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="{safe_url}" target="_blank"
             style="display:inline-block;background:{_GREEN};color:#ffffff;font-family:{_FONT};font-size:15px;
                    font-weight:700;line-height:1;text-decoration:none;padding:15px 30px;border-radius:10px;
                    box-shadow:0 6px 16px rgba(16,185,129,0.32);">{safe_cta} &rarr;</a>
          <!--<![endif]-->
          <p class="nv-faint" style="margin:14px 0 0;font-family:{_FONT};font-size:12px;line-height:1.5;color:#b6b6bb;">
            or paste this link into your browser:<br>
            <a href="{safe_url}" class="nv-muted" style="color:{_MUTED};word-break:break-all;">{safe_url}</a>
          </p>
        </td></tr>

        <!-- divider -->
        <tr><td class="nv-pad" style="padding:22px 34px 0;">
          <div style="height:1px;line-height:1px;font-size:1px;background:#f0f0f1;">&nbsp;</div>
        </td></tr>

        <!-- footer -->
        <tr><td class="nv-pad" style="padding:16px 34px 28px;">
          <p class="nv-muted" style="margin:0 0 6px;font-family:{_FONT};font-size:12px;line-height:1.55;color:{_MUTED};">
            You're receiving this because email notifications are on for your Nordavix workspace.
            <a href="{settings_url}" style="color:{_GREEN_DK};font-weight:600;">Manage preferences</a>.
          </p>
          <p class="nv-faint" style="margin:0;font-family:{_FONT};font-size:11px;line-height:1.5;color:#c4c4c8;">
            Nordavix &middot; AI-native month-end close
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>"""

    text_lines = [title.strip()]
    if safe_body:
        text_lines += ["", body.strip()]  # type: ignore[union-attr]
    text_lines += ["", f"{cta_label}: {cta_url}", "", "Manage email notifications in your Nordavix Settings."]
    text = "\n".join(text_lines)

    return subject, html, text
