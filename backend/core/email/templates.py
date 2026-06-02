"""
HTML for transactional notification emails. Monochrome, inline-styled (email
clients strip <style>), table-based for broad client support. User-supplied
text (titles, comment excerpts) is HTML-escaped.
"""
from __future__ import annotations

from html import escape


def render_notification_email(
    *,
    title: str,
    body: str | None,
    cta_url: str,
    cta_label: str = "Open in Nordavix",
    actor_name: str | None = None,  # reserved; title usually already names the actor
) -> tuple[str, str, str]:
    """Return (subject, html, text) for one notification email."""
    subject = title.strip() or "New notification"

    safe_title = escape(title.strip())
    safe_body  = escape(body.strip()) if body and body.strip() else ""
    safe_url   = escape(cta_url, quote=True)

    body_html = (
        f'<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">{safe_body}</p>'
        if safe_body else ""
    )

    html = f"""\
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="max-width:480px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <span style="font-size:20px;font-weight:600;letter-spacing:-0.02em;color:#111827;">nordavix<span style="color:#16a34a;">.</span></span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 28px;">
                <h1 style="margin:0 0 14px;font-size:18px;line-height:1.4;font-weight:600;color:#111827;">{safe_title}</h1>
                {body_html}
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background:#111827;">
                      <a href="{safe_url}" target="_blank"
                         style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">{escape(cta_label)}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #f3f4f6;">
                <p style="margin:0;font-size:12px;line-height:1.5;color:#9ca3af;">
                  You're receiving this because email notifications are on for your Nordavix account.
                  Manage them in Settings.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""

    text_lines = [title.strip()]
    if safe_body:
        text_lines.append("")
        text_lines.append(body.strip())
    text_lines.append("")
    text_lines.append(f"{cta_label}: {cta_url}")
    text_lines.append("")
    text_lines.append("Manage email notifications in Settings.")
    text = "\n".join(text_lines)

    return subject, html, text
