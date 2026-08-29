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

# Severity → the dot beside a flagged item in the digest. Amber, not red: these
# are things to look at, not things that are known to be wrong, and a wall of
# red in an inbox every morning is how a monitoring email gets muted.
_SEV_DOT = {"high": "#d97706", "medium": "#a16207", "low": "#9ca3af"}


def _brand_shell(
    *,
    title_html: str,
    preheader: str,
    body_html: str,
    cta_url: str,
    cta_label: str,
    badge_label: str | None,
    footer_note: str,
) -> str:
    """The Nordavix email frame — burgundy hairline, logo, badge, CTA, footer.

    Extracted so a second kind of email can't drift into a second brand. Callers
    supply escaped HTML for the heading and the body block; everything around it
    is fixed. `cta_url` is escaped here.
    """
    safe_url = escape(cta_url, quote=True)
    safe_cta = escape(cta_label)
    parts = urlsplit(cta_url)
    origin = f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""
    settings_url = escape((origin + "/app/settings") if origin else cta_url, quote=True)
    logo_url = escape((origin + "/email-logo.png?v=2") if origin else "", quote=True)
    brand = (
        f'<img src="{logo_url}" width="156" height="44" alt="Nordavix" '
        f'style="display:block;border:0;outline:none;text-decoration:none;width:156px;height:44px;">'
        if logo_url else
        f'<span class="nv-ink" style="color:{_INK};">nordavix</span>'
        f'<span style="color:{_GREEN};">.</span>'
    )
    badge = (
        f'<span style="display:inline-block;background:#ecfdf5;color:{_GREEN_DK};'
        f"font-family:{_FONT};font-size:10px;font-weight:700;letter-spacing:0.07em;"
        f'text-transform:uppercase;padding:5px 11px;border-radius:999px;white-space:nowrap;">'
        f"{escape(badge_label)}</span>"
        if badge_label else ""
    )
    spacer = "&zwnj;&nbsp;" * 30
    return f"""\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{escape(preheader[:120])}</title>
{_HEAD_STYLE}
</head>
<body class="nv-bg" style="margin:0;padding:0;background:#f4f4f5;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;">{escape(preheader)}{spacer}</div>
  <table role="presentation" class="nv-bg" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:34px 12px;">

      <table role="presentation" class="nv-card" width="100%" cellpadding="0" cellspacing="0"
        style="max-width:524px;width:100%;background:#ffffff;border:1px solid #ececee;border-radius:16px;
               box-shadow:0 10px 30px rgba(17,24,39,0.07);overflow:hidden;">

        <tr><td style="height:4px;line-height:4px;font-size:4px;background:{_BURGUNDY};">&nbsp;</td></tr>

        <tr><td class="nv-pad" style="padding:26px 34px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td align="left" style="font-family:{_FONT};font-size:20px;font-weight:700;letter-spacing:-0.02em;">
              {brand}
            </td>
            <td align="right">{badge}</td>
          </tr></table>
        </td></tr>

        <tr><td class="nv-pad" style="padding:20px 34px 6px;">
          <h1 class="nv-ink" style="margin:0 0 12px;font-family:{_FONT};
              font-size:21px;line-height:1.34;font-weight:700;color:{_INK};">{title_html}</h1>
          {body_html}
        </td></tr>

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

        <tr><td class="nv-pad" style="padding:22px 34px 0;">
          <div style="height:1px;line-height:1px;font-size:1px;background:#f0f0f1;">&nbsp;</div>
        </td></tr>

        <tr><td class="nv-pad" style="padding:16px 34px 28px;">
          <p class="nv-muted" style="margin:0 0 6px;font-family:{_FONT};font-size:12px;line-height:1.55;color:{_MUTED};">
            {footer_note}
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


def render_watch_digest_email(
    *,
    period_label: str,
    items: list[dict],
    new_count: int,
    scanned: int,
    cta_url: str,
    workspace_name: str | None = None,
) -> tuple[str, str, str]:
    """The continuous-close digest: what today's unattended check turned up.

    `items` are the NEW findings only, each {title, detail, amount, severity}.
    A digest that re-lists yesterday's open items every morning is a digest
    people stop opening, and the sweep already refuses to send on a quiet day.

    Sent only when there IS something, so the subject can be specific: a subject
    line that says nothing happened is the one that gets a filter rule.

    Returns (subject, html, text).
    """
    plural = "" if new_count == 1 else "s"
    where = f" · {workspace_name}" if workspace_name else ""
    subject = f"{new_count} new item{plural} in {period_label}{where}"

    rows = []
    for it in items:
        sev = str(it.get("severity") or "medium").lower()
        dot = _SEV_DOT.get(sev, _SEV_DOT["medium"])
        amount = str(it.get("amount") or "").strip()
        detail = str(it.get("detail") or "").strip()
        rows.append(
            f'<tr><td style="padding:0 0 14px;">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td width="16" valign="top" style="padding-top:6px;">'
            f'<div style="width:7px;height:7px;border-radius:99px;background:{dot};'
            f'line-height:7px;font-size:7px;">&nbsp;</div></td>'
            f'<td valign="top">'
            f'<p class="nv-ink" style="margin:0;font-family:{_FONT};font-size:14px;'
            f'line-height:1.45;font-weight:600;color:{_INK};">{escape(str(it.get("title") or "Flagged entry"))}</p>'
            + (f'<p class="nv-body" style="margin:3px 0 0;font-family:{_FONT};font-size:12.5px;'
               f'line-height:1.55;color:{_BODY};">{escape(detail)}</p>' if detail else "")
            + '</td>'
            # nv-ink, not a bare colour: the dark-mode override keys on the
            # class, and without it the amount stays near-black on a near-black
            # card — the one number in the row a reader actually scans for.
            + (f'<td class="nv-ink" align="right" valign="top" width="90" '
               f'style="font-family:{_FONT};font-size:13px;font-weight:600;color:{_INK};'
               f'white-space:nowrap;padding-left:10px;">{escape(amount)}</td>' if amount else "")
            + "</tr></table></td></tr>"
        )

    # "and N more" only makes sense AFTER something. With nothing listed — a
    # findings lookup that came back empty — it reads as "and 4 more than the
    # nothing above", so the count moves into the sentence instead.
    more = new_count - len(items)
    more_line = (
        f'<p class="nv-muted" style="margin:2px 0 0;font-family:{_FONT};font-size:12px;'
        f'color:{_MUTED};">and {more} more &mdash; open Risk Radar for the full list.</p>'
        if more > 0 and rows else ""
    )

    lead = (
        f'<p class="nv-body" style="margin:0 0 14px;font-family:{_FONT};font-size:15px;'
        f'line-height:1.6;color:{_BODY};">'
        f"Nordavix checked {scanned:,} transactions in {escape(period_label)} and found "
        f"<strong>{new_count} new item{plural}</strong> to review. Nothing was written to QuickBooks."
        f"</p>"
    )
    listing = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'class="nv-quote" style="background:#f9fafb;border-radius:10px;padding:14px 16px;">'
        "<tr><td>"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
        + "".join(rows) +
        f"</table>{more_line}"
        f"</td></tr></table>"
        if rows else ""
    )
    body_html = lead + listing

    html = _brand_shell(
        title_html=escape(f"{new_count} new item{plural} flagged in {period_label}"),
        preheader=f"Continuous close checked {scanned:,} transactions and found {new_count} new item{plural}.",
        body_html=body_html,
        cta_url=cta_url,
        cta_label="Review in Nordavix",
        badge_label="Continuous close",
        footer_note=(
            "You're receiving this because continuous close is on for this workspace "
            "and email notifications are on for your account."
        ),
    )

    text_lines = [
        f"{new_count} new item{plural} flagged in {period_label}",
        "",
        f"Nordavix checked {scanned:,} transactions and found {new_count} new item{plural} to review.",
        "Nothing was written to QuickBooks.",
        "",
    ]
    for it in items:
        amt = str(it.get("amount") or "").strip()
        text_lines.append(f"- {it.get('title') or 'Flagged entry'}{(' — ' + amt) if amt else ''}")
        if it.get("detail"):
            text_lines.append(f"  {it['detail']}")
    if more > 0 and items:
        text_lines.append(f"- and {more} more")
    text_lines += ["", f"Review in Nordavix: {cta_url}", "",
                   "Turn this off in Risk Radar → continuous close, or in your Nordavix Settings."]
    return subject, html, "\n".join(text_lines)


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
