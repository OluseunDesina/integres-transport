"""Adversarial RLS proof for Role and StaffInvitation — spec §8's pattern,
applied to the two new RLS-protected models this slice adds. Mirrors
apps/core/tests/test_row_level_security.py and
apps/businesses/tests/test_business_rls.py.
"""

from datetime import timedelta

import pytest
from django.db import connection
from django.utils import timezone

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import Role, StaffInvitation
from apps.identity.services import create_default_roles

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_role_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    roles_b = create_default_roles(client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{Role._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(roles_b["Owner"].id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_staff_invitation_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    roles_b = create_default_roles(client_b)
    with tenant_context(str(client_b.id)):
        invitation_b = StaffInvitation.objects.create(
            client=client_b,
            email="someone@example.com",
            role=roles_b["Staff"],
            token="rls-test-token",
            expires_at=timezone.now() + timedelta(days=7),
        )

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{StaffInvitation._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(invitation_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
