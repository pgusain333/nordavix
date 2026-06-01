"""
Application-layer encryption for secrets at rest (QBO OAuth tokens).

Why: QBO access/refresh tokens grant full access to a client's live books.
Supabase encrypts disk at rest, but anyone with DB read access (a leaked
DATABASE_URL, a backup dump, a SQL-injection elsewhere) would otherwise
read live credentials in plaintext. We envelope-encrypt the token columns
with Fernet (AES-128-CBC + HMAC-SHA256) using a key from the ENCRYPTION_KEY
Fly secret, so the database never holds usable tokens.

Design goals:
  - TRANSPARENT: an `EncryptedString` SQLAlchemy TypeDecorator encrypts on
    write and decrypts on read, so no consumer code changes — every place
    that reads conn.access_token keeps working.
  - GRACEFUL: if ENCRYPTION_KEY isn't set yet, everything behaves exactly
    as before (plaintext) and logs a warning. Nothing breaks in prod the
    moment this ships; once the secret is set, tokens encrypt on their
    next write/refresh (lazy migration — no data migration required).
  - SELF-IDENTIFYING: encrypted values carry an "enc:v1:" prefix so the
    decryptor can distinguish ciphertext from legacy plaintext rows.

Generate a key:  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
Set it on Fly:   fly secrets set ENCRYPTION_KEY='<that key>' -a nordavix-api
"""
from __future__ import annotations

import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import Text, TypeDecorator

from core.config import settings

logger = logging.getLogger(__name__)

# Marks a value as ciphertext produced by this module. Legacy plaintext
# rows lack the prefix and are returned untouched on read (then encrypted
# on their next write).
_PREFIX = "enc:v1:"


@lru_cache(maxsize=1)
def _fernet() -> Fernet | None:
    """Build the Fernet instance from ENCRYPTION_KEY, or None if unset/invalid.
    Cached — the key doesn't change at runtime."""
    key = (settings.encryption_key or "").strip()
    if not key:
        logger.warning(
            "ENCRYPTION_KEY not set — QBO tokens are stored in PLAINTEXT. "
            "Set the secret to enable at-rest encryption."
        )
        return None
    try:
        return Fernet(key.encode())
    except Exception:
        logger.error(
            "ENCRYPTION_KEY is set but invalid (must be a urlsafe-base64 32-byte "
            "Fernet key). Falling back to plaintext — fix the key."
        )
        return None


def encrypt_secret(plaintext: str | None) -> str | None:
    """Encrypt a secret for storage. No-op (returns plaintext) when no key
    is configured, or when the value is already encrypted/empty."""
    if plaintext is None or plaintext == "":
        return plaintext
    if plaintext.startswith(_PREFIX):
        return plaintext  # already ciphertext — don't double-encrypt
    f = _fernet()
    if f is None:
        return plaintext  # graceful: store as-is (legacy behavior)
    return _PREFIX + f.encrypt(plaintext.encode()).decode()


def decrypt_secret(stored: str | None) -> str | None:
    """Decrypt a stored secret. Legacy plaintext (no prefix) passes through
    unchanged. Returns the raw stored value if the key is missing/wrong so
    a misconfiguration degrades rather than crashes."""
    if stored is None or stored == "":
        return stored
    if not stored.startswith(_PREFIX):
        return stored  # legacy plaintext row
    f = _fernet()
    if f is None:
        logger.error("Encrypted token present but ENCRYPTION_KEY missing/invalid — cannot decrypt.")
        return stored
    try:
        return f.decrypt(stored[len(_PREFIX):].encode()).decode()
    except InvalidToken:
        logger.error("Failed to decrypt token (key rotated or value corrupted).")
        return stored


class EncryptedString(TypeDecorator):
    """SQLAlchemy column type that transparently encrypts on write and
    decrypts on read. Backed by TEXT, so swapping a column to this type
    needs NO migration. Legacy plaintext rows are read as-is and become
    encrypted on their next write."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect: object) -> str | None:  # noqa: ARG002
        return encrypt_secret(value)

    def process_result_value(self, value: str | None, dialect: object) -> str | None:  # noqa: ARG002
        return decrypt_secret(value)
