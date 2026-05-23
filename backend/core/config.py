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
    clerk_jwks_url: str

    # Cloudflare R2 — S3-compatible; boto3 pointed at account-specific endpoint
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket_name: str
    r2_public_url: str

    # Anthropic — model pinned here so all modules upgrade together
    anthropic_api_key: str
    anthropic_model: str = "claude-sonnet-4-6"

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
    def qbo_environment(self) -> str:
        return "sandbox" if self.qbo_sandbox else "production"

    @property
    def qbo_base_url(self) -> str:
        if self.qbo_sandbox:
            return "https://sandbox-quickbooks.api.intuit.com"
        return "https://quickbooks.api.intuit.com"


settings = Settings()
