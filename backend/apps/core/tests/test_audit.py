"""AuditLog's append-only guarantee (`apps/core/models.py`) and
`record_audit_event`'s client_id resolution have been relied on by every
privileged action since Phase 1 Slice 2, but neither had a dedicated
test — found during the Phase 1 self-check's security sweep (§10.5).
"""

import pytest

from apps.clients.tests.factories import ClientFactory
from apps.core.audit import record_audit_event
from apps.core.models import AuditLog
from apps.identity.tests.factories import ClientStaffUserFactory

pytestmark = pytest.mark.django_db


def test_audit_log_cannot_be_updated() -> None:
    entry = AuditLog.objects.create(action="test.created")

    entry.action = "test.tampered"
    with pytest.raises(ValueError, match="append-only"):
        entry.save()


def test_audit_log_cannot_be_deleted() -> None:
    entry = AuditLog.objects.create(action="test.created")

    with pytest.raises(ValueError, match="append-only"):
        entry.delete()


def test_record_audit_event_resolves_client_id_from_target_when_not_passed_explicitly() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    entry = record_audit_event(actor=staff, action="test.action", target=staff)

    assert entry.client_id == client.id
    assert entry.target_type == "User"
    assert entry.target_id == str(staff.pk)
