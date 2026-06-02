import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from core.config import settings
from core.tenancy.middleware import TenantMiddleware
from modules.audit.router import router as audit_router
from modules.exports.router import router as exports_router
from modules.feedback.router import router as feedback_router
from modules.financials.router import router as financials_router
from modules.flux.router import router as flux_router
from modules.insights.router import router as insights_router
from modules.intercompany.router import router as intercompany_router
from modules.internal.router import router as internal_router
from modules.onboarding.router import router as onboarding_router
from modules.qbo.router import oauth_router as qbo_oauth_router
from modules.qbo.router import qbo_router
from modules.recons.router import router as recons_router
from modules.schedules.router import router as schedules_router
from modules.tasks.router import router as tasks_router
from modules.workspace.router import router as workspace_router

if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.app_env,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        send_default_pii=False,
        traces_sample_rate=0.1,
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
app.include_router(onboarding_router,    prefix="/api/onboarding",   tags=["onboarding"])


@app.get("/api/health", tags=["system"])
async def health() -> dict[str, str]:
    """Liveness probe — no auth required. Used by Fly.io health checks."""
    return {"status": "ok", "version": "0.2.0", "env": settings.app_env}
