"""
Bridge from in-app notifications to email. A producer creates the bell
notifications, then calls schedule_notification_emails() to queue one batched
Resend send (after the response, via BackgroundTasks). Best-effort throughout:
no-ops when email is disabled or there are no opted-in recipients.
"""
from __future__ import annotations

import uuid

from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from core.email.sender import send_batch
from core.email.templates import render_notification_email
from modules.notifications.service import notify, resolve_email_targets

# Raw notification type → friendly eyebrow label shown in the email.
# Unknown types fall through to no badge (render handles None).
_TYPE_LABELS = {
    "mention":         "New mention",
    "period_closed":   "Books closed",
    "period_reopened": "Books reopened",
    "task_assigned":   "Task assigned",
    "close_step_assigned": "Close step assigned",
    "review_ready":    "Ready for review",
    "recon_approved":  "Reconciliation approved",
    "recon_reopened":  "Needs re-review",
}


def schedule_notification_emails(
    background_tasks: BackgroundTasks,
    *,
    targets: list[tuple[uuid.UUID, str]],
    title: str,
    body: str | None,
    link: str | None,
    actor_name: str | None = None,
    notif_type: str | None = None,
) -> None:
    """Queue a single batched email send for the recipients in `targets`
    (each `(user_id, email)` from resolve_email_targets). Every recipient gets
    the same content, so it's one Resend batch call. No-op if email is off or
    there are no targets."""
    if not settings.email_enabled or not targets:
        return
    path = link or "/app"
    if not path.startswith("/"):
        path = "/" + path
    cta_url = settings.web_url + path
    subject, html, text = render_notification_email(
        title=title, body=body, cta_url=cta_url, actor_name=actor_name,
        type_label=_TYPE_LABELS.get(notif_type or ""),
    )
    from_email = settings.notifications_from_email
    messages = [
        {"from": from_email, "to": [email], "subject": subject, "html": html, "text": text}
        for (_uid, email) in targets
    ]
    background_tasks.add_task(send_batch, messages)


async def notify_and_email_users(
    db: AsyncSession,
    background_tasks: BackgroundTasks,
    *,
    tenant_id: uuid.UUID,
    recipient_ids: list[uuid.UUID],
    type: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    actor_name: str | None = None,
) -> None:
    """Create one in-app notification per recipient (own commit) and schedule a
    batched email to those opted in. The common directed-notification path —
    callers wrap this in try/except so it stays best-effort."""
    if not recipient_ids:
        return
    for uid in recipient_ids:
        notify(
            db, tenant_id=tenant_id, recipient_user_id=uid,
            type=type, title=title, body=body, link=link,
            entity_type=entity_type, entity_id=entity_id,
        )
    await db.commit()
    targets = await resolve_email_targets(db, recipient_ids)
    schedule_notification_emails(
        background_tasks, targets=targets,
        title=title, body=body, link=link, actor_name=actor_name,
        notif_type=type,
    )
