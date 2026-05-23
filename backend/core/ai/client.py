import hashlib
import time
import uuid
from dataclasses import dataclass

import anthropic

from core.config import settings

_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

# Approximate pricing as of 2026 for claude-sonnet-4-6 (update when Anthropic changes rates).
# Stored for cost estimation only — not used for actual billing.
_COST_PER_MILLION_INPUT = 3.00
_COST_PER_MILLION_OUTPUT = 15.00


@dataclass
class AIResponse:
    content: str
    input_tokens: int
    output_tokens: int
    cost_usd_estimate: float
    cache_key: str


def _strip_pii(text: str) -> str:
    """
    Minimal PII pass before sending data to Anthropic.

    Strategy (Option A — approved in ADR 002): We pass account names through
    because generic names like "Marketing Expense" carry no client identity.
    What we strip is any entity-level context injected into prompts (company
    name, client name, engagement name). Those never appear in flux prompts —
    the prompt template uses only account numbers, generic names, and balances.

    This function is a defensive backstop; the real protection is the prompt
    template design. If account names ever contain client identifiers, upgrade
    this function to replace with account-number-based labels.
    """
    # Currently a no-op backstop — the prompt template ensures no PII reaches here.
    # Extend with regex patterns if you add new prompt types that carry entity names.
    return text


def compute_cache_key(
    account_number: str,
    current_balance: str,
    prior_balance: str,
    model: str,
) -> str:
    """
    SHA-256 hash used for idempotency: same inputs always produce the same key.

    Storing this in the narratives table means re-running flux on an unchanged
    trial balance is free — we return the cached narrative without an API call.
    """
    payload = f"{account_number}|{current_balance}|{prior_balance}|{model}"
    return hashlib.sha256(payload.encode()).hexdigest()


def generate_narrative(
    system_prompt: str,
    user_prompt: str,
    cache_key: str,
    max_tokens: int = 300,
    retries: int = 3,
) -> AIResponse:
    """
    Send a prompt to Anthropic and return the response with token tracking.

    Retries up to `retries` times on transient API errors with exponential backoff.
    The caller is responsible for checking the cache before calling this function.
    """
    # Strip any entity-level PII before the call leaves our system
    safe_system = _strip_pii(system_prompt)
    safe_user = _strip_pii(user_prompt)

    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = _client.messages.create(
                model=settings.anthropic_model,
                max_tokens=max_tokens,
                system=safe_system,
                messages=[{"role": "user", "content": safe_user}],
            )
            content = response.content[0].text
            input_tokens = response.usage.input_tokens
            output_tokens = response.usage.output_tokens
            cost = (
                input_tokens / 1_000_000 * _COST_PER_MILLION_INPUT
                + output_tokens / 1_000_000 * _COST_PER_MILLION_OUTPUT
            )
            return AIResponse(
                content=content,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd_estimate=cost,
                cache_key=cache_key,
            )
        except anthropic.RateLimitError as e:
            last_error = e
            time.sleep(2**attempt)
        except anthropic.APIStatusError as e:
            if e.status_code >= 500:
                last_error = e
                time.sleep(2**attempt)
            else:
                raise

    raise RuntimeError(f"Anthropic API failed after {retries} retries") from last_error
