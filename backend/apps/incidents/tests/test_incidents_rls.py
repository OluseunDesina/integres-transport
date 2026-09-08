"""Adversarial raw-SQL probe, one per app.

The ORM-level `TenantScopedManager` is only the first of two layers.
This bypasses it entirely and asks Postgres directly, which is the only
way to prove the `tenant_isolation` policy from
`apps.core.migration_operations.EnableRowLevelSecurity` is actually
doing something.
"""

import pytest
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory

from ..services import add_incident_note
from .factories import IncidentFactory
from .helpers import business_for

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_incident_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    with tenant_context(str(client_b.id)):
        incident_b = IncidentFactory(client=client_b, business=business_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "incidents_incident" WHERE id = %s',  # noqa: S608
                [str(incident_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_activity_lookup_via_raw_sql() -> None:
    """The trail carries staff notes, so it needs the same proof the
    incident itself does — a leak here would be worse, not lesser."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    staff_b = ClientStaffUserFactory(client=client_b)
    with tenant_context(str(client_b.id)):
        incident_b = IncidentFactory(client=client_b, business=business_b)
        activity_b = add_incident_note(
            incident=incident_b, actor=staff_b, note="Internal only."
        )

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "incidents_incidentactivity" WHERE id = %s',  # noqa: S608
                [str(activity_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
