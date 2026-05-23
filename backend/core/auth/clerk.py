import jwt
from jwt import PyJWKClient

from core.config import settings

# PyJWKClient fetches and caches Clerk's public keys automatically.
# Keys are refreshed on rotation (kid mismatch triggers a re-fetch).
_jwks_client = PyJWKClient(settings.clerk_jwks_url, cache_keys=True)


def verify_clerk_token(token: str) -> dict[str, object]:
    """
    Verify a Clerk session JWT and return its claims.

    Raises jwt.PyJWTError (and subclasses) on any verification failure.
    The middleware catches these and returns 401.
    """
    signing_key = _jwks_client.get_signing_key_from_jwt(token)
    claims: dict[str, object] = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        # Clerk does not always populate `aud`; skip that check.
        options={"verify_aud": False},
    )
    return claims
