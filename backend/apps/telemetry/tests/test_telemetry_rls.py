"""Adversarial RLS proof for apps.telemetry — mirrors
apps/tapngo/tests/test_tapngo_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
TelemetryDevice/VehiclePosition/VehicleLiveState automatically; this
file proves RLS itself, not just that it's enabled.
"""

import pytest
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

from .factories import TelemetryDeviceFactory, VehicleLiveStateFactory, VehiclePositionFactory

pytestmark = pytest.mark.django_db


def _probe_blocks_cross_client_read(table: str, row_id: object, client_a_id: str) -> None:
    set_rls_session_vars(client_a_id, is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(f'SELECT id FROM "{table}" WHERE id = %s', [str(row_id)])  # noqa: S608
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_telemetry_device_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        device_b = TelemetryDeviceFactory(client=client_b)
    _probe_blocks_cross_client_read("telemetry_telemetrydevice", device_b.id, str(client_a.id))


def test_rls_blocks_cross_client_vehicle_position_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        position_b = VehiclePositionFactory(client=client_b)
    _probe_blocks_cross_client_read("telemetry_vehicleposition", position_b.id, str(client_a.id))


def test_rls_blocks_cross_client_vehicle_live_state_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        live_state_b = VehicleLiveStateFactory(client=client_b)
    _probe_blocks_cross_client_read("telemetry_vehiclelivestate", live_state_b.id, str(client_a.id))
