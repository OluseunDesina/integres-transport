"""Adversarial RLS proof for Route/Stop/RouteStop — mirrors
apps/businesses/tests/test_business_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
all three models automatically; this file proves RLS itself, not just
that it's enabled.
"""

import pytest
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

from .factories import RouteFactory, StopFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_route_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        route_b = RouteFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "network_route" WHERE id = %s',  # noqa: S608
                [str(route_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_stop_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        stop_b = StopFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "network_stop" WHERE id = %s',  # noqa: S608
                [str(stop_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
