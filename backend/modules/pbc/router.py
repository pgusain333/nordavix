"""
PBC ("Prepared By Client") portal — magic-link document requests.

Two routers:

  router         /api/pbc          (authed)   create / list / remind / cancel
  public_router  /api/pbc-public   (PUBLIC)   the client side of the magic link

Security model:
  * The magic token (secrets.token_urlsafe(32), ~256 bits) is generated
    once, embedded in the emailed link, and only its SHA-256 is stored.
    Possession of the link IS the credential; the database alone can't
    reconstruct a working URL.
  * Public endpoints never reveal tenant ids and accept uploads only while
    the request is pending/fulfilled and unexpired. Lookup is by token
    hash with `skip_tenant_filter` (there is no JWT on a client click).
  * Uploads inherit the SAME validation as in-app evidence (extension
    allow-list, 15 MB cap, basename-sanitized filename) and land as
    ordinary SubledgerEvidence rows — so review, locking, audit, and
    exports treat client files identically to preparer files. The row's
    uploaded_by is the requesting preparer; the client origin (email,
    request id) is recorded in evidence.verification and the audit log.
"""
import hashlib
import io
import logging
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit.log import write_audit_event
from core.auth.dependencies import CurrentTenantId, CurrentUser
from core.config import settings
from core.db.session import get_db
from core.email.sender import send_email
from core.storage import r2 as r2_storage
from models.evidence_request import EvidenceRequest
from models.subledger_evidence import SubledgerEvidence
from models.tenant import Tenant

logger = logging.getLogger(__name__)

router = APIRouter()
public_router = APIRouter()

_EXPIRY_DAYS = 14
_MAX_FILES_PER_REQUEST = 10
_MAX_BYTES = 15 * 1024 * 1024
_ALLOWED_EXTS = {"pdf", "csv", "xlsx", "xls", "png", "jpg", "jpeg"}
_REMIND_COOLDOWN_MINUTES = 60
_MAX_SENDS = 6


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _is_expired(req: EvidenceRequest) -> bool:
    exp = req.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=UTC)
    return datetime.now(UTC) > exp


async def _company_name(db: AsyncSession, tenant_id: uuid.UUID) -> str:
    t = (await db.execute(
        select(Tenant).where(Tenant.id == tenant_id),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()
    return (t.name if t and t.name and not t.name.startswith("org_") else None) or "Your accountant"


def _request_email_html(*, company: str, title: str, note: str | None,
                        period_label: str, link: str, expires: str) -> str:
    note_block = (
        f'<p style="margin:0 0 18px;color:#3C4146;font-size:14px;line-height:1.6;'
        f'background:#FAFAF8;border:1px solid #E6E4DF;border-radius:8px;padding:12px 14px;">'
        f'{note}</p>'
        if note else ""
    )
    return f"""\
<div style="background:#F4F1E9;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #E6E4DF;overflow:hidden;">
    <div style="background:#0C2620;padding:18px 28px;">
      <span style="color:#F4F1E9;font-size:15px;font-weight:700;letter-spacing:-0.01em;">nordavix<span style="color:#9CC4AD;">.</span></span>
    </div>
    <div style="padding:30px 28px;">
      <p style="margin:0 0 6px;color:#8A8F98;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">Document request · {period_label}</p>
      <h1 style="margin:0 0 12px;color:#14181A;font-size:21px;line-height:1.3;">{company} needs a document from you</h1>
      <p style="margin:0 0 6px;color:#3C4146;font-size:14px;line-height:1.6;"><strong>{title}</strong></p>
      {note_block}
      <a href="{link}" style="display:inline-block;background:#2E7A55;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 22px;border-radius:9px;margin:10px 0 18px;">Upload securely &rarr;</a>
      <p style="margin:0;color:#8A8F98;font-size:12px;line-height:1.6;">
        No account needed — the link opens a secure upload page that goes straight
        to {company}&rsquo;s Nordavix workspace. It expires on {expires}.
        If you weren&rsquo;t expecting this, you can ignore this email.
      </p>
    </div>
    <div style="padding:14px 28px;border-top:1px solid #E6E4DF;">
      <p style="margin:0;color:#8A8F98;font-size:11px;">Sent via Nordavix &middot; AI-powered month-end close</p>
    </div>
  </div>
</div>"""


async def _send_request_email(db: AsyncSession, req: EvidenceRequest, token: str) -> None:
    company = await _company_name(db, req.tenant_id)
    period_label = req.period_end.strftime("%b %Y")
    expires = req.expires_at.strftime("%b %d, %Y")
    link = f"{settings.web_url}/r/{token}"
    await send_email(
        to=req.recipient_email,
        subject=f"{company} needs a document: {req.title}",
        html=_request_email_html(
            company=company, title=req.title, note=req.note,
            period_label=period_label, link=link, expires=expires,
        ),
        text=(
            f"{company} needs a document from you: {req.title} ({period_label}).\n\n"
            f"Upload securely (no account needed): {link}\n\n"
            f"This link expires on {expires}."
        ),
    )


# ── Authed: create / list / remind / cancel ─────────────────────────────────

# Light shape check — Resend rejects truly invalid addresses; we just stop
# obvious typos before an email is attempted. (Avoids the email-validator dep.)
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")


class RequestCreate(BaseModel):
    qbo_account_id: str
    period_end: str  # YYYY-MM-DD
    title: str = Field(min_length=3, max_length=255)
    note: str | None = Field(default=None, max_length=1000)
    account_label: str | None = Field(default=None, max_length=255)
    recipient_email: str = Field(max_length=255)
    recipient_name: str | None = Field(default=None, max_length=255)


def _serialize(req: EvidenceRequest) -> dict:
    return {
        "id":              str(req.id),
        "qbo_account_id":  req.qbo_account_id,
        "period_end":      req.period_end.isoformat(),
        "title":           req.title,
        "note":            req.note,
        "account_label":   req.account_label,
        "recipient_email": req.recipient_email,
        "recipient_name":  req.recipient_name,
        "status":          "expired" if (req.status == "pending" and _is_expired(req)) else req.status,
        "expires_at":      req.expires_at.isoformat(),
        "fulfilled_at":    req.fulfilled_at.isoformat() if req.fulfilled_at else None,
        "files":           req.files or [],
        "send_count":      req.send_count,
        "last_sent_at":    req.last_sent_at.isoformat() if req.last_sent_at else None,
        "created_at":      req.created_at.isoformat() if req.created_at else None,
    }


@router.post("")
async def create_request(
    body: RequestCreate,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    from datetime import date as _date
    try:
        pe = _date.fromisoformat(body.period_end)
    except ValueError:
        raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    email = body.recipient_email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="That doesn't look like a valid email address.")

    token = secrets.token_urlsafe(32)
    req = EvidenceRequest(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        qbo_account_id=body.qbo_account_id,
        period_end=pe,
        title=body.title.strip(),
        note=(body.note or "").strip() or None,
        account_label=(body.account_label or "").strip() or None,
        recipient_email=email,
        recipient_name=(body.recipient_name or "").strip() or None,
        token_hash=_hash(token),
        expires_at=datetime.now(UTC) + timedelta(days=_EXPIRY_DAYS),
        status="pending",
        files=[],
        send_count=1,
        last_sent_at=datetime.now(UTC),
        created_by=user.id,
    )
    db.add(req)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="pbc.request_sent", entity_type="evidence_request", entity_id=req.id,
        metadata={"summary": f"Requested '{body.title}' from {body.recipient_email} ({pe.strftime('%b %Y')})"},
    )
    await db.commit()

    try:
        await _send_request_email(db, req, token)
    except Exception:
        logger.exception("PBC request email failed for %s", req.id)
        raise HTTPException(
            status_code=502,
            detail="The request was created but the email could not be sent. Use Resend to retry.",
        )
    return _serialize(req)


@router.get("")
async def list_requests(
    tenant_id: CurrentTenantId,
    qbo_account_id: str | None = None,
    period_end: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    stmt = select(EvidenceRequest).order_by(desc(EvidenceRequest.created_at)).limit(200)
    if qbo_account_id:
        stmt = stmt.where(EvidenceRequest.qbo_account_id == qbo_account_id)
    if period_end:
        from datetime import date as _date
        try:
            stmt = stmt.where(EvidenceRequest.period_end == _date.fromisoformat(period_end))
        except ValueError:
            raise HTTPException(status_code=400, detail="period_end must be YYYY-MM-DD.")
    rows = list((await db.execute(stmt)).scalars().all())
    return {"requests": [_serialize(r) for r in rows]}


@router.post("/{request_id}/remind")
async def remind_request(
    request_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    req = (await db.execute(
        select(EvidenceRequest).where(EvidenceRequest.id == request_id)
    )).scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    if req.status != "pending" or _is_expired(req):
        raise HTTPException(status_code=409, detail="Only open requests can be re-sent.")
    if req.send_count >= _MAX_SENDS:
        raise HTTPException(status_code=429, detail="Send limit reached for this request.")
    if req.last_sent_at:
        last = req.last_sent_at if req.last_sent_at.tzinfo else req.last_sent_at.replace(tzinfo=UTC)
        if datetime.now(UTC) - last < timedelta(minutes=_REMIND_COOLDOWN_MINUTES):
            raise HTTPException(status_code=429, detail="Wait an hour between reminders.")

    # Re-sending mints a FRESH token (and invalidates the old link) — a
    # reminder must never extend the life of a possibly-forwarded URL.
    token = secrets.token_urlsafe(32)
    req.token_hash = _hash(token)
    req.expires_at = datetime.now(UTC) + timedelta(days=_EXPIRY_DAYS)
    req.send_count += 1
    req.last_sent_at = datetime.now(UTC)
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="pbc.reminder_sent", entity_type="evidence_request", entity_id=req.id,
        metadata={"summary": f"Re-sent '{req.title}' to {req.recipient_email}"},
    )
    await db.commit()
    try:
        await _send_request_email(db, req, token)
    except Exception:
        logger.exception("PBC reminder email failed for %s", req.id)
        raise HTTPException(status_code=502, detail="Could not send the reminder email. Try again.")
    return _serialize(req)


@router.post("/{request_id}/cancel")
async def cancel_request(
    request_id: uuid.UUID,
    tenant_id: CurrentTenantId,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    req = (await db.execute(
        select(EvidenceRequest).where(EvidenceRequest.id == request_id)
    )).scalar_one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    req.status = "cancelled"
    await write_audit_event(
        db, tenant_id=tenant_id, user_id=user.id,
        action="pbc.request_cancelled", entity_type="evidence_request", entity_id=req.id,
        metadata={"summary": f"Cancelled request '{req.title}' to {req.recipient_email}"},
    )
    await db.commit()
    return _serialize(req)


# ── Public: the client side of the magic link ───────────────────────────────

async def _load_by_token(db: AsyncSession, token: str) -> EvidenceRequest | None:
    if not token or len(token) < 16:
        return None
    return (await db.execute(
        select(EvidenceRequest).where(EvidenceRequest.token_hash == _hash(token)),
        execution_options={"skip_tenant_filter": True},
    )).scalar_one_or_none()


def _public_payload(req: EvidenceRequest, company: str) -> dict:
    status = req.status
    if status == "pending" and _is_expired(req):
        status = "expired"
    return {
        "company":      company,
        "title":        req.title,
        "note":         req.note,
        "period_label": req.period_end.strftime("%B %Y"),
        "status":       status,
        "expires_at":   req.expires_at.isoformat(),
        "files": [
            {"file_name": f.get("file_name"), "uploaded_at": f.get("uploaded_at")}
            for f in (req.files or [])
        ],
        "max_files":    _MAX_FILES_PER_REQUEST,
        "allowed_exts": sorted(_ALLOWED_EXTS),
    }


@public_router.get("/{token}")
async def get_public_request(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    req = await _load_by_token(db, token)
    if req is None:
        raise HTTPException(status_code=404, detail="This link isn't valid.")
    company = await _company_name(db, req.tenant_id)
    return _public_payload(req, company)


@public_router.post("/{token}/upload")
async def public_upload(
    token: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    req = await _load_by_token(db, token)
    if req is None:
        raise HTTPException(status_code=404, detail="This link isn't valid.")
    if req.status == "cancelled":
        raise HTTPException(status_code=410, detail="This request was cancelled.")
    if _is_expired(req):
        raise HTTPException(status_code=410, detail="This link has expired. Ask for a new one.")
    if len(req.files or []) >= _MAX_FILES_PER_REQUEST:
        raise HTTPException(status_code=409, detail="File limit reached for this request.")

    name = (file.filename or "document").replace("\\", "/").rsplit("/", 1)[-1] or "document"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in _ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"File type .{ext} not allowed. Use: {', '.join(sorted(_ALLOWED_EXTS))}.",
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(raw) > _MAX_BYTES:
        raise HTTPException(status_code=400, detail=f"File too large (max {_MAX_BYTES // (1024 * 1024)} MB).")

    mime = file.content_type or "application/octet-stream"
    key = r2_storage.tenant_key(
        req.tenant_id,
        f"subledger-evidence/{req.qbo_account_id}/{req.period_end.isoformat()}",
        f"{uuid.uuid4()}_{name}",
    )
    r2_storage.upload_file(key, io.BytesIO(raw), content_type=mime)

    ev = SubledgerEvidence(
        id=uuid.uuid4(),
        tenant_id=req.tenant_id,
        qbo_account_id=req.qbo_account_id,
        period_end=req.period_end,
        file_name=name,
        file_size=len(raw),
        mime_type=mime,
        r2_key=key,
        # uploaded_by is NOT NULL; the requesting preparer owns the slot.
        # The true origin (client email + request id) is recorded below.
        uploaded_by=req.created_by,
        verification={
            "source": "client_upload",
            "request_id": str(req.id),
            "client_email": req.recipient_email,
        },
    )
    db.add(ev)

    now = datetime.now(UTC)
    req.files = [*(req.files or []), {
        "file_name": name,
        "file_size": len(raw),
        "uploaded_at": now.isoformat(),
        "evidence_id": str(ev.id),
    }]
    if req.status == "pending":
        req.status = "fulfilled"
        req.fulfilled_at = now

    await write_audit_event(
        db, tenant_id=req.tenant_id, user_id=None,
        action="pbc.client_uploaded", entity_type="evidence_request", entity_id=req.id,
        metadata={"summary": f"Client {req.recipient_email} uploaded '{name}' for '{req.title}'"},
    )
    await db.commit()

    company = await _company_name(db, req.tenant_id)
    return _public_payload(req, company)
