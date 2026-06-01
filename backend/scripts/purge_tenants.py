"""
Scheduled tenant-purge runner.

Hard-deletes every soft-deleted tenant whose 30-day grace window has elapsed
(see modules/workspace/purge.py). Run it daily from a scheduler:

    # Fly scheduled machine / cron (from the backend working dir):
    python -m scripts.purge_tenants

It's idempotent and safe to run as often as you like — only tenants past their
purge_after are touched, and a purged tenant no longer matches.

Alternative trigger: POST /api/internal/purge-expired-tenants with the
X-Internal-Secret header (same logic, over HTTP).
"""
import asyncio
import logging

from modules.workspace.purge import purge_expired_tenants

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("scripts.purge_tenants")


async def _main() -> None:
    results = await purge_expired_tenants()
    purged = sum(1 for r in results if r.get("ok"))
    failed = sum(1 for r in results if not r.get("ok"))
    logger.info("Tenant purge complete: %d purged, %d failed.", purged, failed)
    for r in results:
        if not r.get("ok"):
            logger.error("  FAILED tenant %s: %s", r.get("tenant_id"), r.get("error"))


if __name__ == "__main__":
    asyncio.run(_main())
