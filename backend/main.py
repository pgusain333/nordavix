import sentry_sdk
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from core.config import settings
from core.db.base import DemoReadOnlyError, TenantOwnershipError
from core.security.crypto import encryption_configured
from core.tenancy.middleware import TenantMiddleware
from modules.adjustments.router import router as adjustments_router
from modules.advisory.router import router as advisory_router
from modules.assistant.router import router as assistant_router
from modules.audit.router import router as audit_router
from modules.autopilot.router import router as autopilot_router
from modules.close_workflow.router import router as close_workflow_router
from modules.comments.router import router as comments_router
from modules.email.router import router as email_router
from modules.exports.router import router as exports_router
from modules.feedback.router import router as feedback_router
from modules.financials.router import router as financials_router
from modules.flux.router import router as flux_router
from modules.gl_accuracy.router import router as gl_accuracy_router
from modules.insights.router import router as insights_router
from modules.intercompany.router import router as intercompany_router
from modules.internal.router import router as internal_router
from modules.memory.router import router as memory_router
from modules.notifications.router import router as notifications_router
from modules.onboarding.router import router as onboarding_router
from modules.pbc.router import public_router as pbc_public_router
from modules.pbc.router import router as pbc_router
from modules.qbo.router import oauth_router as qbo_oauth_router
from modules.qbo.router import qbo_router
from modules.recons.router import router as recons_router
from modules.review.router import router as review_router
from modules.schedules.router import router as schedules_router
from modules.tasks.router import router as tasks_router
from modules.workpapers.router import router as workpapers_router
from modules.workspace.router import router as workspace_router

if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.app_env,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        send_default_pii=False,
        traces_sample_rate=0.1,
    )

# Fail CLOSED in production: refuse to boot if at-rest encryption for secrets
# (QBO OAuth tokens) isn't configured, so a missing/invalid ENCRYPTION_KEY can
# never silently persist live credentials as plaintext. In dev it stays a
# warning (see core/security/crypto.py) so local work isn't blocked.
if settings.is_production and not encryption_configured():
    raise RuntimeError(
        "ENCRYPTION_KEY is required in production — QBO OAuth tokens must be "
        "encrypted at rest. Set the ENCRYPTION_KEY secret and redeploy."
    )

app = FastAPI(
    title="Nordavix API",
    version="0.2.0",
    docs_url="/docs" if not settings.is_production else None,
    redoc_url=None,
)

# Middleware is applied in reverse add order (last added = outermost = runs first).
# So TenantMiddleware is added first (inner), CORSMiddleware second (outer/first).
# CORS handles OPTIONS preflight before TenantMiddleware ever sees the request.
app.add_middleware(TenantMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    """Baseline security headers on every API response.

    The API serves JSON only (no HTML), so the high-value headers are the
    anti-sniff / anti-embed ones. CSP is intentionally omitted — it protects
    rendered documents, and the SPA's headers are set at the Vercel edge.
    HSTS only in production: localhost must stay reachable over plain http.
    """
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if settings.is_production:
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=63072000; includeSubDomains"
        )
    return response


@app.exception_handler(DemoReadOnlyError)
async def _demo_readonly_handler(request: Request, exc: DemoReadOnlyError) -> JSONResponse:  # noqa: ARG001
    """A read-only demo request tried to write to the DB — return a clean 403
    instead of a 500. The demo middleware already blocks non-GET methods; this
    catches GET handlers that would write (now prevented at the DB layer)."""
    return JSONResponse(
        {"detail": "Sample company is read-only.", "code": "demo_readonly"},
        status_code=403,
    )


@app.exception_handler(TenantOwnershipError)
async def _tenant_ownership_handler(request: Request, exc: TenantOwnershipError) -> JSONResponse:  # noqa: ARG001
    """A tenant-ownership assertion failed (assert_tenant_owns) — code tried to
    act on a row by id that the current tenant does not own. Surface it as a
    clean 404 (don't confirm the row exists for another tenant) instead of a
    500. The bulk write it guarded never ran."""
    return JSONResponse(
        {"detail": f"{exc.label} not found.", "code": "not_found"},
        status_code=404,
    )

# ── API routers ───────────────────────────────────────────────────────────────

app.include_router(flux_router,      prefix="/api/flux",            tags=["flux"])
app.include_router(qbo_oauth_router, prefix="/api/oauth/qbo",       tags=["oauth"])
app.include_router(qbo_router,       prefix="/api/qbo",             tags=["qbo"])
app.include_router(recons_router,    prefix="/api/reconciliations", tags=["reconciliations"])
app.include_router(audit_router,     prefix="/api/audit",           tags=["audit"])
app.include_router(workspace_router, prefix="/api/workspace",       tags=["workspace"])
app.include_router(tasks_router,     prefix="/api/tasks",           tags=["tasks"])
app.include_router(intercompany_router, prefix="/api/intercompany", tags=["intercompany"])
app.include_router(financials_router,   prefix="/api/financials",   tags=["financials"])
app.include_router(exports_router,      prefix="/api/exports",      tags=["exports"])
app.include_router(insights_router,     prefix="/api/insights",     tags=["insights"])
app.include_router(schedules_router,     prefix="/api/schedules",    tags=["schedules"])
app.include_router(feedback_router,      prefix="/api/feedback",     tags=["feedback"])
app.include_router(internal_router,      prefix="/api/internal",     tags=["internal"])
app.include_router(email_router,         prefix="/api/email",        tags=["email"])
app.include_router(notifications_router, prefix="/api/notifications", tags=["notifications"])
app.include_router(onboarding_router,    prefix="/api/onboarding",   tags=["onboarding"])
app.include_router(comments_router,      prefix="/api/comments",     tags=["comments"])
app.include_router(adjustments_router,    prefix="/api/adjustments",  tags=["adjustments"])
app.include_router(assistant_router,      prefix="/api/assistant",    tags=["assistant"])
app.include_router(pbc_router,            prefix="/api/pbc",          tags=["pbc"])
app.include_router(pbc_public_router,     prefix="/api/pbc-public",   tags=["pbc-public"])
app.include_router(autopilot_router,      prefix="/api/autopilot",    tags=["autopilot"])
app.include_router(review_router,         prefix="/api/review",       tags=["review"])
app.include_router(advisory_router,       prefix="/api/advisory",     tags=["advisory"])
app.include_router(memory_router,         prefix="/api/memory",       tags=["memory"])
app.include_router(workpapers_router,      prefix="/api/workpapers",   tags=["workpapers"])
app.include_router(close_workflow_router,  prefix="/api/close",        tags=["close"])
app.include_router(gl_accuracy_router,      prefix="/api/gl-accuracy",  tags=["gl-accuracy"])


@app.get("/api/health", tags=["system"])
async def health() -> dict[str, str]:
    """Liveness probe — no auth required. Used by Fly.io health checks."""
    return {"status": "ok", "version": "0.2.0", "env": settings.app_env}
