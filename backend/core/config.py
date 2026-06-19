from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # Database — must use asyncpg driver prefix: postgresql+asyncpg://
    database_url: str

    # Optional SECOND database URL for the request path (Tier 2 RLS). When set,
    # FastAPI request handlers (get_db) connect as this login instead of the
    # main one; everything else (migrations, auth/bootstrap, background jobs,
    # purge, public no-context routes) keeps using database_url. Point this at a
    # NON-BYPASSRLS role (e.g. nordavix_app, created by migration 059) to make
    # Row-Level Security actually enforce per-tenant isolation on the request
    # path. Empty = dormant: the app uses database_url everywhere exactly as
    # before (RLS policies exist but the BYPASSRLS login ignores them). This is
    # the cutover switch — see docs/RLS_CUTOVER.md.
    app_database_url: str = ""

    # Redis — Upstash uses rediss:// (TLS); local dev uses redis://
    # Stored as str because RedisDsn doesn't accept rediss:// in all pydantic versions
    redis_url: str

    # Clerk — JWTs are verified against their JWKS endpoint, never proxied to Clerk's API
    clerk_secret_key: str
    clerk_publishable_key: str
    # JWKS URL is auto-derived from clerk_publishable_key if not explicitly set
    clerk_jwks_url: str = ""

    # Cloudflare R2 — S3-compatible; boto3 pointed at account-specific endpoint
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket_name: str
    r2_public_url: str

    # Anthropic — model pinned here so all modules upgrade together
    anthropic_api_key: str
    anthropic_model: str = "claude-sonnet-4-6"
    # NDVX Chat (client assistant) runs on a faster/cheaper model than the
    # flux/recon narratives — it's a high-volume, latency-sensitive surface and
    # Haiku is plenty for grounded tool-routing + summarizing tool output.
    # Flip back to anthropic_model here if you ever want chat on Sonnet.
    assistant_model: str = "claude-haiku-4-5-20251001"

    # Application-layer encryption key for secrets at rest (QBO OAuth tokens).
    # urlsafe-base64 32-byte Fernet key. Empty = tokens stored plaintext
    # (the EncryptedString column type degrades gracefully + logs a warning).
    # Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    encryption_key: str = ""

    # Clerk issuer allowlist (comma-separated https URLs). Empty = derive the
    # expected issuer from clerk_jwks_url / clerk_publishable_key. Tokens
    # whose `iss` isn't allowed are rejected — stops anyone with their own
    # Clerk instance from self-provisioning a Nordavix tenant.
    clerk_allowed_issuers: str = ""
    # Secure by default: reject tokens whose `iss` isn't allowed. The expected
    # issuer is derived from clerk_publishable_key — the SAME key today's valid
    # logins already verify against — so enforcement matches your real Clerk
    # instance and won't lock anyone out. Set to False ONLY as a temporary
    # break-glass if a Clerk domain change ever causes a mismatch (then fix the
    # allowlist). If the issuer can't be derived at all, enforcement no-ops.
    clerk_enforce_issuer: bool = True

    # Shared secret for internal/scheduled task endpoints (e.g. the tenant
    # purge job). These bypass Clerk auth, so they're gated by this secret
    # sent in the X-Internal-Secret header. Empty = the endpoints are DISABLED
    # (return 503), so a missing secret can never leave them wide open.
    # Generate: python -c "import secrets; print(secrets.token_urlsafe(32))"
    internal_task_secret: str = ""

    # ── Rate limiting (Redis-backed, fail-open) ─────────────────────────────
    # Per-tenant fixed-window limits. The general limit guards the whole API;
    # the AI limit is stricter and applies only to AI-triggering endpoints.
    # Fail-open by design: if Redis is unreachable, requests are allowed (a
    # broken limiter must never take the app down). Tune via env without a
    # code change; set rate_limit_enabled=false to disable entirely.
    rate_limit_enabled: bool = True
    rate_limit_general_per_min: int = 60   # requests/min/tenant across the API
    rate_limit_ai_per_min: int = 10        # AI-endpoint requests/min/tenant

    # ── Per-tenant AI spend cap (Postgres-backed via AIUsage) ───────────────
    # A runaway/abuse backstop, not a meter for normal use. Summed over the
    # calendar month; when a tenant's estimated Anthropic cost reaches the cap
    # and ai_cap_enforce is true, AI endpoints return 429 until the month
    # resets. 0 disables the dollar cap (usage is still recorded).
    ai_monthly_cost_cap_usd: float = 25.0
    ai_cap_enforce: bool = True

    # ── Tenant isolation: per-transaction DB GUC (Tier 2 RLS groundwork) ────
    # When True, every DB transaction announces its tenant to Postgres via
    # set_config('app.current_tenant', <current_tenant_id>, is_local=True). This
    # is the value Row-Level Security policies will compare tenant_id against.
    # Harmless until RLS policies exist (an unused, transaction-local GUC); ON by
    # default so the plumbing is exercised in production BEFORE policies are
    # enabled. Kill switch: set DB_SET_TENANT_GUC=false on the host to disable
    # instantly without a code change (e.g. if it ever interacts badly with the
    # connection pooler).
    db_set_tenant_guc: bool = True

    app_env: str = "development"
    debug: bool = False

    # Empty string disables Sentry — acceptable for local dev
    sentry_dsn: str = ""

    # CORS — comma-separated origins; overridden in prod via env var
    cors_origins: str = "http://localhost:5173"

    # QuickBooks Online OAuth2 — empty strings disable QBO integration
    qbo_client_id: str = ""
    qbo_client_secret: str = ""
    # Where QBO redirects after OAuth — must match Intuit developer app settings
    qbo_redirect_uri: str = "http://localhost:8000/api/oauth/qbo/callback"
    # True = sandbox (development), False = production
    qbo_sandbox: bool = True

    # ── Email (Resend) ─────────────────────────────────────────────────
    # Used by the feedback endpoint to notify hello@nordavix.com when
    # a user submits via the in-app dialog. Empty string disables email
    # entirely — the feedback still saves to the DB, we just skip the
    # email step. To enable, sign up at resend.com, verify a domain,
    # then set RESEND_API_KEY + RESEND_FROM_EMAIL on Fly.
    resend_api_key:    str = ""
    resend_from_email: str = "Nordavix Feedback <feedback@nordavix.com>"
    feedback_to_email: str = "hello@nordavix.com"
    # Sender for user-facing notification emails (mentions, assignments, etc.).
    # Defaults to resend_from_email when blank. Must be on a Resend-verified
    # domain. Set RESEND_NOTIFICATIONS_FROM on Fly for a nicer label, e.g.
    # "Nordavix <notifications@nordavix.com>".
    resend_notifications_from: str = ""

    # Absolute base URL of the frontend app (e.g. https://app.nordavix.com),
    # used to build clickable links in transactional emails. Empty = derive
    # from the first https CORS origin, else the local dev origin. Set
    # APP_BASE_URL on Fly so email buttons point at the real app.
    app_base_url: str = ""

    # Absolute base URL of the BACKEND/API itself (e.g. https://nordavix-api.fly.dev).
    # Needed for links that must hit the API directly rather than the frontend —
    # e.g. the one-click email unsubscribe endpoint. The SPA host rewrites all paths
    # to index.html, so app_base_url (the frontend) can't serve /api routes. Empty =
    # unset; the re-engagement drip refuses to send without a working unsubscribe URL.
    # Set API_BASE_URL on Fly.
    api_base_url: str = ""

    # Clerk org id of the seeded read-only "sample company" demo tenant. The
    # tenancy middleware maps the X-Nordavix-Demo header to this one tenant.
    demo_clerk_org_id: str = "org_nordavix_demo"

    @field_validator("database_url")
    @classmethod
    def require_asyncpg_driver(cls, v: str) -> str:
        if not v.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "DATABASE_URL must use the asyncpg driver: postgresql+asyncpg://"
            )
        return v

    @field_validator("app_database_url")
    @classmethod
    def app_url_asyncpg_or_empty(cls, v: str) -> str:
        # Optional — but if set, it must use the same asyncpg driver as the main
        # URL (it feeds the same create_async_engine path).
        if v and not v.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "APP_DATABASE_URL, when set, must use the asyncpg driver: "
                "postgresql+asyncpg://"
            )
        return v

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def web_url(self) -> str:
        """Absolute base URL of the frontend, for links in emails. Prefers the
        explicit app_base_url; otherwise the first https CORS origin; else the
        local dev origin. Never has a trailing slash."""
        base = self.app_base_url.strip()
        if not base:
            base = next((o for o in self.cors_origins_list if o.startswith("https://")), "")
        if not base:
            base = "http://localhost:5173"
        return base.rstrip("/")

    @property
    def api_url(self) -> str:
        """Absolute base URL of the backend API, for links that must hit the API
        directly (e.g. one-click email unsubscribe). Empty when API_BASE_URL is
        unset. Never has a trailing slash."""
        return self.api_base_url.strip().rstrip("/")

    @property
    def notifications_from_email(self) -> str:
        """Sender address for notification emails — explicit override, else the
        shared Resend from address."""
        return self.resend_notifications_from.strip() or self.resend_from_email

    @property
    def r2_endpoint_url(self) -> str:
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"

    @property
    def qbo_enabled(self) -> bool:
        return bool(self.qbo_client_id and self.qbo_client_secret)

    @property
    def email_enabled(self) -> bool:
        """True when we have everything we need to send transactional
        email via Resend. False → email-side effects no-op silently."""
        return bool(self.resend_api_key and self.resend_from_email)

    @property
    def qbo_environment(self) -> str:
        return "sandbox" if self.qbo_sandbox else "production"

    @property
    def qbo_base_url(self) -> str:
        if self.qbo_sandbox:
            return "https://sandbox-quickbooks.api.intuit.com"
        return "https://quickbooks.api.intuit.com"


settings = Settings()
