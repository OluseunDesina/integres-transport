"""Write-side helper for AuditLog. Import `record_audit_event` from any
app's service layer when a privileged or money-moving action happens —
this is the primitive every later phase's service functions call, per
the brief's cross-cutting audit requirement.
"""

from typing import Any

from apps.core.context import get_current_client_id
from apps.core.models import AuditLog


def record_audit_event(
    *,
    actor: Any,
    action: str,
    target: Any = None,
    client_id: str | None = None,
    **metadata: Any,
) -> AuditLog:
    target_type = type(target).__name__ if target is not None else ""
    target_id = str(getattr(target, "pk", "")) if target is not None else ""
    resolved_client_id = client_id or getattr(target, "client_id", None) or get_current_client_id()
    return AuditLog.objects.create(
        client_id=resolved_client_id,
        actor=actor,
        action=action,
        target_type=target_type,
        target_id=target_id,
        metadata=metadata,
    )
