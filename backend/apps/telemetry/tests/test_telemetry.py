import datetime
from decimal import Decimal

import pytest
from django.conf import settings
from django.core.management import call_command
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory

from ..models import TelemetryDevice, VehicleLiveState, VehiclePosition
from ..services import (
    DeviceNotAssigned,
    InvalidDeviceToken,
    authenticate_device,
    issue_device,
    prune_positions,
    record_device_positions,
    record_positions,
)
from .factories import TelemetryDeviceFactory, VehicleLiveStateFactory, VehiclePositionFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _device_client(raw_token: str) -> APIClient:
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Device {raw_token}")
    return api


def _business(client: object) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return BusinessFactory(client=client)


def _vehicle(client: object, business: object) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return VehicleFactory(client=client, business=business)


def _issue_device(
    client: object, business: object, vehicle: object | None
) -> tuple[TelemetryDevice, str]:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        staff = ClientStaffUserFactory(client=client)
        return issue_device(business=business, label="Unit A", vehicle=vehicle, issued_by=staff)


def _reading(**overrides: object) -> dict:
    base = {
        "latitude": "6.524400",
        "longitude": "3.379200",
        "speed_kph": "34.5",
        "heading_degrees": 118,
        "recorded_at": timezone.now().isoformat(),
    }
    base.update(overrides)
    return base


# --- Device issue / management ---------------------------------------------


def test_client_staff_can_issue_a_device_and_the_raw_token_is_returned_once() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _business(client)

    response = _auth_client(staff).post(
        reverse("telemetry-device-list-create"),
        {"business": str(business.id), "label": "Depot scanner 1"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert "token" in response.data
    with tenant_context(str(client.id)):
        device = TelemetryDevice.objects.get(pk=response.data["id"])
    assert device.token_hash != response.data["token"]
    assert AuditLog.objects.filter(action="telemetry_device.issued").exists()


def test_device_list_never_shows_another_clients_devices() -> None:
    client_a, client_b = ClientFactory(), ClientFactory()
    business_a = _business(client_a)
    _issue_device(client_a, business_a, None)
    staff_b = ClientStaffUserFactory(client=client_b)

    response = _auth_client(staff_b).get(reverse("telemetry-device-list-create"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


def test_another_clients_business_query_param_is_400() -> None:
    client_a, client_b = ClientFactory(), ClientFactory()
    business_a = _business(client_a)
    staff_b = ClientStaffUserFactory(client=client_b)

    response = _auth_client(staff_b).get(
        reverse("telemetry-device-list-create"), {"business": str(business_a.id)}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_patching_another_clients_device_is_404() -> None:
    client_a, client_b = ClientFactory(), ClientFactory()
    business_a = _business(client_a)
    device, _token = _issue_device(client_a, business_a, None)
    staff_b = ClientStaffUserFactory(client=client_b)

    response = _auth_client(staff_b).patch(
        reverse("telemetry-device-update", args=[device.id]), {"is_active": False}
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_revoking_a_device_rejects_further_ingest() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    device, raw_token = _issue_device(client, business, vehicle)
    staff = ClientStaffUserFactory(client=client)

    patch_response = _auth_client(staff).patch(
        reverse("telemetry-device-update", args=[device.id]), {"is_active": False}
    )
    assert patch_response.status_code == status.HTTP_200_OK
    assert patch_response.data["is_active"] is False

    ingest_response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [_reading()]}, format="json"
    )
    assert ingest_response.status_code == status.HTTP_401_UNAUTHORIZED


def test_reassigning_a_device_moves_only_future_rows() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle_a = _vehicle(client, business)
    vehicle_b = _vehicle(client, business)
    device, raw_token = _issue_device(client, business, vehicle_a)
    staff = ClientStaffUserFactory(client=client)

    first = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [_reading()]}, format="json"
    )
    assert first.status_code == status.HTTP_202_ACCEPTED

    patch_response = _auth_client(staff).patch(
        reverse("telemetry-device-update", args=[device.id]), {"vehicle": str(vehicle_b.id)}
    )
    assert patch_response.status_code == status.HTTP_200_OK

    second = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"),
        {"positions": [_reading(recorded_at=timezone.now().isoformat())]},
        format="json",
    )
    assert second.status_code == status.HTTP_202_ACCEPTED

    with tenant_context(str(client.id)):
        vehicle_ids = set(
            VehiclePosition.objects.filter(device=device).values_list("vehicle_id", flat=True)
        )
    assert vehicle_ids == {vehicle_a.id, vehicle_b.id}


# --- Ingest ------------------------------------------------------------


def test_ingest_accepts_a_batch_and_derives_vehicle_and_business_from_the_device() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)

    response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [_reading()]}, format="json"
    )

    assert response.status_code == status.HTTP_202_ACCEPTED
    assert response.data == {"accepted": 1, "ignored": 0, "skipped": 0, "flagged_skew": 0}
    with tenant_context(str(client.id)):
        position = VehiclePosition.objects.get()
    assert position.vehicle_id == vehicle.id
    assert position.business_id == business.id
    assert position.source == VehiclePosition.Source.DEVICE


def test_ingest_resolves_the_vehicles_in_progress_trip_server_side() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            status=Trip.Status.IN_PROGRESS,
        )

    response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [_reading()]}, format="json"
    )

    assert response.status_code == status.HTTP_202_ACCEPTED
    with tenant_context(str(client.id)):
        position = VehiclePosition.objects.get()
    assert position.trip_id == trip.id


def test_ingest_without_an_in_progress_trip_stores_a_null_trip() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)

    response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [_reading()]}, format="json"
    )

    assert response.status_code == status.HTTP_202_ACCEPTED
    with tenant_context(str(client.id)):
        position = VehiclePosition.objects.get()
    assert position.trip_id is None


def test_ingest_skips_and_counts_malformed_rows_without_failing_the_batch() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)

    response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"),
        {"positions": [_reading(), {"latitude": "not-a-number"}]},
        format="json",
    )

    assert response.status_code == status.HTTP_202_ACCEPTED
    assert response.data["accepted"] == 1
    assert response.data["skipped"] == 1


def test_ingest_empty_positions_list_is_400() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)

    response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": []}, format="json"
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_duplicate_batch_is_ignored_not_double_written() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)
    reading = _reading()

    first = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [reading]}, format="json"
    )
    second = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [reading]}, format="json"
    )

    assert first.data["accepted"] == 1
    assert second.data == {"accepted": 0, "ignored": 1, "skipped": 0, "flagged_skew": 0}
    with tenant_context(str(client.id)):
        assert VehiclePosition.objects.count() == 1


def test_unassigned_device_cannot_ingest() -> None:
    client = ClientFactory()
    business = _business(client)
    _device, raw_token = _issue_device(client, business, None)

    response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"), {"positions": [_reading()]}, format="json"
    )

    assert response.status_code == status.HTTP_409_CONFLICT


def test_unknown_device_token_is_401() -> None:
    response = _device_client("not-a-real-token").post(
        reverse("telemetry-position-ingest"), {"positions": [_reading()]}, format="json"
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_clock_skew_is_stored_flagged_and_excluded_from_live_state() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)
    skewed_recorded_at = timezone.now() - datetime.timedelta(hours=48)

    response = _device_client(raw_token).post(
        reverse("telemetry-position-ingest"),
        {"positions": [_reading(recorded_at=skewed_recorded_at.isoformat())]},
        format="json",
    )

    assert response.status_code == status.HTTP_202_ACCEPTED
    assert response.data["accepted"] == 1
    assert response.data["flagged_skew"] == 1
    with tenant_context(str(client.id)):
        assert VehiclePosition.objects.count() == 1
        assert not VehicleLiveState.objects.filter(vehicle=vehicle).exists()


def test_ingest_is_rate_limited_per_device() -> None:
    """Same shape as apps.identity.tests.test_throttling: fires against
    the real configured rate rather than lowering it via
    override_settings — DRF's SimpleRateThrottle.THROTTLE_RATES is bound
    to the settings dict once, at class-definition/import time, so a
    later override_settings(REST_FRAMEWORK=...) never reaches it."""
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    _device, raw_token = _issue_device(client, business, vehicle)
    limit = int(settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["telemetry_ingest"].split("/")[0])
    device_client = _device_client(raw_token)

    responses = [
        device_client.post(
            reverse("telemetry-position-ingest"),
            {"positions": [_reading(recorded_at=timezone.now().isoformat())]},
            format="json",
        )
        for _ in range(limit + 1)
    ]

    statuses = [r.status_code for r in responses]
    assert statuses.count(status.HTTP_202_ACCEPTED) == limit
    assert statuses[-1] == status.HTTP_429_TOO_MANY_REQUESTS


# --- Live-state advance guard (service-level) -------------------------


def test_live_state_does_not_move_backwards_on_an_out_of_order_batch() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    now = timezone.now()

    with tenant_context(str(client.id)):
        record_positions(
            business=business,
            vehicle=vehicle,
            source=VehiclePosition.Source.SIMULATED,
            readings=[
                {
                    "latitude": Decimal("6.6"),
                    "longitude": Decimal("3.6"),
                    "recorded_at": now,
                }
            ],
        )
        record_positions(
            business=business,
            vehicle=vehicle,
            source=VehiclePosition.Source.SIMULATED,
            readings=[
                {
                    "latitude": Decimal("6.1"),
                    "longitude": Decimal("3.1"),
                    "recorded_at": now - datetime.timedelta(minutes=5),
                }
            ],
        )
        live_state = VehicleLiveState.objects.get(vehicle=vehicle)

    assert live_state.recorded_at == now
    assert live_state.latitude == Decimal("6.600000")


def test_authenticate_device_rejects_unknown_token() -> None:
    with pytest.raises(InvalidDeviceToken):
        authenticate_device(raw_token="does-not-exist")


def test_record_device_positions_requires_an_assigned_vehicle() -> None:
    client = ClientFactory()
    business = _business(client)
    with tenant_context(str(client.id)):
        device = TelemetryDeviceFactory(client=client, business=business, vehicle=None)
    with pytest.raises(DeviceNotAssigned):
        record_device_positions(device=device, readings=[_reading()])


# --- Pruning -------------------------------------------------------------


def test_prune_positions_deletes_beyond_the_window_and_keeps_live_state() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    now = timezone.now()
    with tenant_context(str(client.id)):
        old = VehiclePositionFactory(
            client=client,
            business=business,
            vehicle=vehicle,
            recorded_at=now - datetime.timedelta(days=45),
        )
        recent = VehiclePositionFactory(
            client=client,
            business=business,
            vehicle=vehicle,
            recorded_at=now - datetime.timedelta(days=1),
        )
        live_state = VehicleLiveStateFactory(client=client, business=business, vehicle=vehicle)

    result = prune_positions()

    assert result["deleted"] == 1
    with tenant_context(str(client.id)):
        remaining_ids = set(VehiclePosition.objects.values_list("id", flat=True))
    assert remaining_ids == {recent.id}
    assert old.id not in remaining_ids
    with tenant_context(str(client.id)):
        assert VehicleLiveState.objects.filter(pk=live_state.pk).exists()


# --- Simulator -------------------------------------------------------------


def test_simulator_writes_simulated_positions_for_in_progress_trips() -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(
            client=client, business=business, latitude=Decimal("6.5"), longitude=Decimal("3.3")
        )
        stop_b = StopFactory(
            client=client, business=business, latitude=Decimal("6.6"), longitude=Decimal("3.4")
        )
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            status=Trip.Status.IN_PROGRESS,
        )

    call_command("simulate_vehicle_positions")
    call_command("simulate_vehicle_positions")

    with tenant_context(str(client.id)):
        positions = list(VehiclePosition.objects.filter(vehicle=vehicle).order_by("recorded_at"))
    assert len(positions) == 2
    assert all(p.source == VehiclePosition.Source.SIMULATED for p in positions)
    first, second = positions
    assert (first.latitude, first.longitude) != (second.latitude, second.longitude)


def test_simulator_skips_and_reports_routes_with_uncoordinated_stops(
    capsys: pytest.CaptureFixture,
) -> None:
    client = ClientFactory()
    business = _business(client)
    vehicle = _vehicle(client, business)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        # No coordinates on this Stop — the route is uncoordinated.
        stop = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop, sequence=1)
        RouteStopFactory(
            client=client,
            route=route,
            stop=StopFactory(client=client, business=business),
            sequence=2,
        )
        TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            status=Trip.Status.IN_PROGRESS,
        )

    call_command("simulate_vehicle_positions")

    with tenant_context(str(client.id)):
        assert not VehiclePosition.objects.filter(vehicle=vehicle).exists()
    assert "skipped 1" in capsys.readouterr().out


def test_simulator_refuses_to_run_under_production_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from django.core.management.base import CommandError

    monkeypatch.setenv("DJANGO_SETTINGS_MODULE", "config.settings.production")
    with pytest.raises(CommandError):
        call_command("simulate_vehicle_positions")
