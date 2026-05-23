"""
Celery tasks for async AI narrative generation.

Full implementation is Phase 4. These stubs define the task signatures
and wiring so the Celery worker can be started now and tasks added later.

Each task sets current_tenant_id at the top — this scopes all ORM queries
within the task to the correct tenant, mirroring what TenantMiddleware does
for HTTP requests.
"""
import asyncio
import uuid

from celery import shared_task

from celery_app import celery_app
from core.db.base import current_tenant_id


@celery_app.task(bind=True, name="flux.generate_narrative")
def generate_narrative_task(self: object, variance_id: str, tenant_id: str) -> dict[str, str]:
    """
    Generate an AI narrative for one variance row.

    Phase 4 will implement the full flow:
      1. Set current_tenant_id for ORM tenant scoping.
      2. Load Variance + Account from DB.
      3. Check narrative cache (cache_key lookup).
      4. If cache miss: call core.ai.client.generate_narrative().
      5. Persist Narrative + AIUsage records.
      6. Update Variance.status → "pending" (awaiting controller review).
    """
    # Tenant context must be set before any DB query in a Celery task
    current_tenant_id.set(uuid.UUID(tenant_id))

    # Phase 4 implementation goes here
    return {"status": "stub", "variance_id": variance_id}
