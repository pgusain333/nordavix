import base64
import logging

import jwt
from jwt import PyJWKClient

from core.config import settings

logger = logging.getLogger(__name__)


def _derive_jwks_url(publishable_key: str) -> str:
    """
    Derive the Clerk JWKS URL directly from the publishable key.

    Clerk encodes the Frontend API hostname in the publishable key:
        pk_test_<base64url(frontend_api + '$')>
        pk_live_<base64url(frontend_api + '$')>

    This removes the need for a separate CLERK_JWKS_URL env var and
    guarantees the JWKS URL always matches the Clerk instance in use.
    """
    for prefix in ("pk_live_", "pk_test_"):
        if publishable_key.startswith(prefix):
            encoded = publishable_key[len(prefix):]
            break
    else:
        raise ValueError(
            f"Unrecognised Clerk publishable key prefix: {publishable_key[:10]}..."
        )

    # Add standard base64 padding (Clerk omits it)
    padding = (4 - len(encoded) % 4) % 4
    encoded += "=" * padding

    # Clerk appends '$' before encoding; strip it after decoding
    frontend_api = base64.b64decode(encoded).decode().rstrip("$")
    url = f"https://{frontend_api}/.well-known/jwks.json"
    logger.info("Clerk JWKS URL derived from publishable key: %s", url)
    return url


# Always derive from the publishable key — this is the only source of truth.
# If an explicit override is set (CLERK_JWKS_URL), it takes precedence.
_jwks_url: str = (
    settings.clerk_jwks_url.strip()
    if settings.clerk_jwks_url.strip()
    else _derive_jwks_url(settings.clerk_publishable_key)
)

# PyJWKClient fetches and caches Clerk's public keys automatically.
# Keys are refreshed on rotation (kid mismatch triggers a re-fetch).
_jwks_client = PyJWKClient(_jwks_url, cache_keys=True)


def verify_clerk_token(token: str) -> dict[str, object]:
    """
    Verify a Clerk session JWT and return its claims.

    Raises jwt.PyJWTError (and subclasses) on any verification failure.
    The middleware catches these and returns 401.
    """
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims: dict[str, object] = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            # Clerk does not always populate `aud`; skip that check.
            options={"verify_aud": False},
        )
        return claims
    except jwt.PyJWTError as exc:
        # Log the specific failure to make debugging easy.
        logger.warning(
            "Clerk JWT verification failed [%s]: %s  |  jwks_url=%s",
            type(exc).__name__,
            exc,
            _jwks_url,
        )
        raise
