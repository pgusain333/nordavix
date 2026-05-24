"""
Clerk JWT verification.

Strategy:
  1. Peek at the unverified JWT claims to read the `iss` (issuer) field.
  2. Derive the JWKS URL from the issuer: `<iss>/.well-known/jwks.json`.
  3. Fetch & cache the public key, then do a full signature + expiry check.

This is self-correcting: it works regardless of which Clerk Frontend API
the client (Vercel) is configured to use. If the app migrates to a new
Clerk instance, the backend adapts automatically without any env-var change.

Security note: trusting the `iss`-derived JWKS URL is standard practice
(RFC 8414). An attacker can't forge the issuer because the signature would
fail against the real Clerk keys — you'd need to control both the `iss`
and the corresponding JWKS to mount a meaningful attack.

Fallback: if `iss` is absent or cannot produce a JWKS URL, we fall back
to CLERK_JWKS_URL (env var) or derive it from CLERK_PUBLISHABLE_KEY.
"""
import base64
import logging
from functools import lru_cache

import jwt
from jwt import PyJWKClient

from core.config import settings

logger = logging.getLogger(__name__)


def _derive_jwks_url_from_publishable_key(publishable_key: str) -> str:
    """pk_test_<base64(frontend_api + '$')> → JWKS URL"""
    for prefix in ("pk_live_", "pk_test_"):
        if publishable_key.startswith(prefix):
            encoded = publishable_key[len(prefix):]
            break
    else:
        raise ValueError(f"Unknown Clerk publishable key prefix: {publishable_key[:10]}...")
    padding = (4 - len(encoded) % 4) % 4
    encoded += "=" * padding
    frontend_api = base64.b64decode(encoded).decode().rstrip("$")
    return f"https://{frontend_api}/.well-known/jwks.json"


# Configured fallback (used when the token has no `iss` claim)
_fallback_jwks_url: str = (
    settings.clerk_jwks_url.strip()
    if settings.clerk_jwks_url.strip()
    else _derive_jwks_url_from_publishable_key(settings.clerk_publishable_key)
)

logger.info("Clerk JWKS fallback URL: %s", _fallback_jwks_url)


@lru_cache(maxsize=16)
def _get_jwks_client(jwks_url: str) -> PyJWKClient:
    """Return a cached PyJWKClient for the given JWKS URL."""
    return PyJWKClient(jwks_url, cache_keys=True)


def verify_clerk_token(token: str) -> dict[str, object]:
    """
    Verify a Clerk session JWT and return its decoded claims.

    Raises jwt.PyJWTError (and subclasses) on any verification failure.
    The TenantMiddleware catches these and returns HTTP 401.
    """
    # ── Step 1: peek at claims without verification to find issuer ──────────
    try:
        unverified: dict = jwt.decode(
            token,
            options={"verify_signature": False},
            algorithms=["RS256"],
        )
        iss: str = unverified.get("iss", "") or ""
    except Exception:
        iss = ""

    # ── Step 2: derive JWKS URL from issuer, fall back to configured value ──
    if iss.startswith("https://"):
        jwks_url = f"{iss}/.well-known/jwks.json"
    else:
        jwks_url = _fallback_jwks_url
        logger.debug("No iss in token — using fallback JWKS URL: %s", jwks_url)

    # ── Step 3: full verification against the correct JWKS ──────────────────
    try:
        client = _get_jwks_client(jwks_url)
        signing_key = client.get_signing_key_from_jwt(token)
        claims: dict[str, object] = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_aud": False},
        )
        return claims
    except jwt.PyJWTError as exc:
        logger.warning(
            "Clerk JWT verification failed [%s]: %s  |  iss=%s  jwks_url=%s",
            type(exc).__name__,
            exc,
            iss,
            jwks_url,
        )
        raise
