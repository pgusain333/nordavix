import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from core.config import settings
from core.tenancy.middleware import TenantMiddleware
from modules.flux.router import router as flux_router
from modules.qbo.router import oauth_router as qbo_oauth_router
from modules.qbo.router import qbo_router
from modules.recons.router import router as recons_router

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


@app.get("/api/health", tags=["system"])
async def health() -> dict[str, str]:
    """Liveness probe — no auth required. Used by Fly.io health checks."""
    return {"status": "ok", "version": "0.2.0", "env": settings.app_env}
