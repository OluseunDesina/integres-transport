"""Adversarial RLS proof for VehicleType/Vehicle/Driver — mirrors
apps/network/tests/test_network_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
all three models automatically; this file proves RLS itself, not just
that it's enabled.
"""

import pytest
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

from .factories import DriverFactory, VehicleFactory, VehicleTypeFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_vehicle_type_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        vehicle_type_b = VehicleTypeFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "fleet_vehicletype" WHERE id = %s',  # noqa: S608
                [str(vehicle_type_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_vehicle_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        vehicle_b = VehicleFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "fleet_vehicle" WHERE id = %s',  # noqa: S608
                [str(vehicle_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_driver_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        driver_b = DriverFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "fleet_driver" WHERE id = %s',  # noqa: S608
                [str(driver_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
