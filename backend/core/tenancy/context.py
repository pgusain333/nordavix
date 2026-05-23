"""
Re-exports current_tenant_id from core.db.base for import convenience.

The ContextVar lives in core.db.base to avoid a circular import:
    session.py → base.py (event listener needs TenantBase)
    middleware.py → context.py → base.py (fine)

Import current_tenant_id from here in all non-db code.
"""
from core.db.base import current_tenant_id

__all__ = ["current_tenant_id"]
