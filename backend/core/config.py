from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # Database — must use asyncpg driver prefix: postgresql+asyncpg://
    database_url: str

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
    # Safe rollout: when False, a mismatched issuer is only LOGGED (so you can
    # confirm the real issuer matches what we derive before enforcing). Set to
    # True — or set clerk_allowed_issuers explicitly — to actually reject.
    clerk_enforce_issuer: bool = False

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

    @field_validator("database_url")
    @classmethod
    def require_asyncpg_driver(cls, v: str) -> str:
        if not v.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "DATABASE_URL must use the asyncpg driver: postgresql+asyncpg://"
            )
        return v

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

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
