import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from core.config import settings
from core.tenancy.middleware import TenantMiddleware
from modules.flux.router import router as flux_router

if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.app_env,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        # Never send request bodies or user data to Sentry — financial data is PII
        send_default_pii=False,
        traces_sample_rate=0.1,
    )

app = FastAPI(
    title="Nordavix API",
    version="0.1.0",
    # Disable interactive docs in production — no need to expose the schema publicly
    docs_url="/docs" if not settings.is_production else None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

# TenantMiddleware must come after CORSMiddleware so OPTIONS preflight requests
# are handled by CORS before hitting the auth check.
app.add_middleware(TenantMiddleware)

app.include_router(flux_router, prefix="/api/flux", tags=["flux"])


@app.get("/api/health", tags=["system"])
async def health() -> dict[str, str]:
    """Liveness probe — no auth required. Used by Fly.io health checks."""
    return {"status": "ok", "version": "0.1.0", "env": settings.app_env}
