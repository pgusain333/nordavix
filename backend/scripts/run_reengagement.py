"""
Scheduled re-engagement drip runner.

Enrolls users who signed up but never activated, exits those who have since
connected QuickBooks / run a reconciliation / unsubscribed, and sends each due
person the next email in the 5-step sequence (every 3 days). Run it daily:

    # live
    python -m scripts.run_reengagement
    # compute only — no sends, no writes
    python -m scripts.run_reengagement --dry-run

Idempotent and safe to run repeatedly. Alternative trigger:
POST /api/internal/run-reengagement with the X-Internal-Secret header.
"""
import asyncio
import logging
import sys

from modules.reengagement.service import run_reengagement

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("scripts.run_reengagement")


async def _main() -> None:
    dry = "--dry-run" in sys.argv
    summary = await run_reengagement(dry_run=dry)
    logger.info("Re-engagement %s complete: %s", "dry-run" if dry else "run", summary)


if __name__ == "__main__":
    asyncio.run(_main())
