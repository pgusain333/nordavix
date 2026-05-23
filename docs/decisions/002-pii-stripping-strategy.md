# ADR 002 — PII stripping before Anthropic API calls

**Date:** 2026-05-23  
**Status:** Accepted

## Context

Client financial data (balances, account names) is sent to Anthropic's API to generate flux narratives. We must ensure no client-identifying information leaves our system in a form that could be linked to a specific firm or engagement.

## Decision

**Option A** (chosen): Strip only entity-level metadata from prompts. Account names (e.g., "Marketing Expense", "Accounts Receivable") are passed through because they are generic accounting terms, not identifiers. Company name, client name, and engagement name never appear in flux prompts — the prompt template is designed to exclude them from the start.

The `_strip_pii()` function in `core/ai/client.py` is currently a documented no-op backstop. The real protection is the prompt template design: prompts contain only account numbers, generic account names, dollar amounts, and percentage changes — no entity names, no fiscal year labels that could be traced.

## Rationale for Option A over alternatives

- **Option B** (replace account names with account-number labels): Reduces narrative quality significantly. "Account 4100 increased $50K" is less useful to a controller than "Revenue increased $50K in the quarter."
- **Option C** (regex filter for proper nouns): Fragile, hard to maintain, and generates false positives.

## Future obligation

If we add prompt types that do include client context (e.g., workpaper generation with engagement names), `_strip_pii()` must be extended before those features ship. Any developer adding a new prompt type must review this ADR.

## Other privacy controls

- No client data in logs (`send_default_pii=False` in Sentry, no `logging.info(balance)` patterns)
- No client data in error messages (errors carry entity IDs, not content)
- Audit log records who/when/what, not what the data contained
