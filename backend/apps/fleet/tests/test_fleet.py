import datetime

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

from ..models import Driver, Vehicle, VehicleType
from ..services import compliance_warnings_for
from .factories import DriverFactory, VehicleFactory, VehicleTypeFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _business(client: object, **overrides: object) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return BusinessFactory(client=client, **overrides)


def _vehicle_type(client: object, **overrides: object) -> VehicleType:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return VehicleTypeFactory(client=client, **overrides)


def _vehicle(client: object, **overrides: object) -> Vehicle:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return VehicleFactory(client=client, **overrides)


def _driver(client: object, **overrides: object) -> Driver:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return DriverFactory(client=client, **overrides)


# --- VehicleType -----------------------------------------------------------


def test_client_staff_can_create_a_vehicle_type() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _business(client)

    response = _auth_client(staff).post(
        reverse("vehicle-type-list-create"),
        {"business": str(business.id), "name": "33-seater coaster", "capacity": 33},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["capacity"] == 33
    entry = AuditLog.objects.get(action="vehicle_type.created")
    assert entry.client_id == client.id


def test_staff_role_user_can_list_but_not_create_vehicle_types() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    business = _business(client)

    api = _auth_client(staff_role_user)
    list_response = api.get(reverse("vehicle-type-list-create"))
    create_response = api.post(
        reverse("vehicle-type-list-create"),
        {"business": str(business.id), "name": "Blocked", "capacity": 10},
    )

    assert list_response.status_code == status.HTTP_200_OK
    assert create_response.status_code == status.HTTP_403_FORBIDDEN


def test_passenger_cannot_list_vehicle_types() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("vehicle-type-list-create"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_vehicle_type_list_only_returns_the_callers_own_rows() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    _vehicle_type(client_a, name="A's type")
    _vehicle_type(client_b, name="B's type")

    response = _auth_client(staff_a).get(reverse("vehicle-type-list-create"))

    assert response.status_code == status.HTTP_200_OK
    names = [row["name"] for row in response.data["results"]]
    assert names == ["A's type"]


def test_vehicle_type_patch_updates_mutable_fields_and_is_audit_logged() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    vehicle_type = _vehicle_type(client)

    response = _auth_client(staff).patch(
        reverse("vehicle-type-update", kwargs={"pk": str(vehicle_type.id)}), {"capacity": 45}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["capacity"] == 45
    entry = AuditLog.objects.get(action="vehicle_type.updated")
    assert entry.metadata["capacity"] == 45


def test_cross_client_vehicle_type_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    vehicle_type_b = _vehicle_type(client_b)

    response = _auth_client(staff_a).patch(
        reverse("vehicle-type-update", kwargs={"pk": str(vehicle_type_b.id)}), {"capacity": 1}
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- Vehicle -----------------------------------------------------------


def test_client_staff_can_create_a_vehicle() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _business(client)
    vehicle_type = _vehicle_type(client, business=business)

    response = _auth_client(staff).post(
        reverse("vehicle-list-create"),
        {
            "business": str(business.id),
            "vehicle_type": str(vehicle_type.id),
            "registration_number": "LAG-123-XY",
        },
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["compliance_warnings"] == []
    entry = AuditLog.objects.get(action="vehicle.created")
    assert entry.client_id == client.id


def test_vehicle_creation_rejects_a_vehicle_type_from_a_different_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _business(client)
    other_business = _business(client)
    foreign_vehicle_type = _vehicle_type(client, business=other_business)

    response = _auth_client(staff).post(
        reverse("vehicle-list-create"),
        {
            "business": str(business.id),
            "vehicle_type": str(foreign_vehicle_type.id),
            "registration_number": "LAG-999-XY",
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "vehicle_type" in response.data


def test_vehicle_creation_rejects_duplicate_registration_number_for_same_client() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _business(client)
    vehicle_type = _vehicle_type(client, business=business)
    _vehicle(client, business=business, vehicle_type=vehicle_type, registration_number="LAG-1-XY")

    response = _auth_client(staff).post(
        reverse("vehicle-list-create"),
        {
            "business": str(business.id),
            "vehicle_type": str(vehicle_type.id),
            "registration_number": "LAG-1-XY",
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_vehicle_list_embeds_compliance_warnings_for_an_expired_field() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    yesterday = datetime.date.today() - datetime.timedelta(days=1)
    vehicle = _vehicle(client, insurance_expires_at=yesterday)

    response = _auth_client(staff).get(reverse("vehicle-list-create"))

    assert response.status_code == status.HTTP_200_OK
    row = next(r for r in response.data["results"] if r["id"] == str(vehicle.id))
    assert row["compliance_warnings"] == [
        f"Vehicle insurance expired on {yesterday.isoformat()}"
    ]


def test_vehicle_list_filters_by_business_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business_a = _business(client)
    business_b = _business(client)
    vehicle_a = _vehicle(client, business=business_a)
    _vehicle(client, business=business_b)

    response = _auth_client(staff).get(
        reverse("vehicle-list-create"), {"business": str(business_a.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    ids = [row["id"] for row in response.data["results"]]
    assert ids == [str(vehicle_a.id)]


def test_vehicle_list_rejects_another_clients_business_query_param() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    business_b = _business(client_b)

    response = _auth_client(staff_a).get(
        reverse("vehicle-list-create"), {"business": str(business_b.id)}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_vehicle_patch_updates_mutable_fields_and_is_audit_logged() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    vehicle = _vehicle(client)

    response = _auth_client(staff).patch(
        reverse("vehicle-update", kwargs={"pk": str(vehicle.id)}),
        {"registration_number": "LAG-999-ZZ"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["registration_number"] == "LAG-999-ZZ"
    entry = AuditLog.objects.get(action="vehicle.updated")
    assert entry.metadata["registration_number"] == "LAG-999-ZZ"


def test_cross_client_vehicle_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    vehicle_b = _vehicle(client_b)

    response = _auth_client(staff_a).patch(
        reverse("vehicle-update", kwargs={"pk": str(vehicle_b.id)}),
        {"registration_number": "Hijacked"},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- Driver -----------------------------------------------------------


def test_client_staff_can_create_a_driver() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _business(client)

    response = _auth_client(staff).post(
        reverse("driver-list-create"),
        {"business": str(business.id), "name": "Tunde Bello", "license_number": "DL-000123"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["compliance_warnings"] == []
    entry = AuditLog.objects.get(action="driver.created")
    assert entry.client_id == client.id


def test_driver_creation_rejects_duplicate_license_number_for_same_client() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _business(client)
    _driver(client, business=business, license_number="DL-1")

    response = _auth_client(staff).post(
        reverse("driver-list-create"),
        {"business": str(business.id), "name": "Someone Else", "license_number": "DL-1"},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_driver_list_embeds_compliance_warnings_for_an_expired_license() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    yesterday = datetime.date.today() - datetime.timedelta(days=1)
    driver = _driver(client, license_expires_at=yesterday)

    response = _auth_client(staff).get(reverse("driver-list-create"))

    assert response.status_code == status.HTTP_200_OK
    row = next(r for r in response.data["results"] if r["id"] == str(driver.id))
    assert row["compliance_warnings"] == [f"Driver's license expired on {yesterday.isoformat()}"]


def test_passenger_cannot_list_drivers() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("driver-list-create"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_cross_client_driver_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    driver_b = _driver(client_b)

    response = _auth_client(staff_a).patch(
        reverse("driver-update", kwargs={"pk": str(driver_b.id)}), {"name": "Hijacked"}
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- compliance_warnings_for() unit tests -----------------------------


def test_compliance_warnings_for_returns_empty_when_nothing_expired() -> None:
    tomorrow = datetime.date.today() + datetime.timedelta(days=1)
    vehicle = Vehicle(insurance_expires_at=tomorrow, roadworthiness_expires_at=None)
    assert compliance_warnings_for(vehicle) == []


def test_compliance_warnings_for_vehicle_reports_both_expired_fields() -> None:
    yesterday = datetime.date.today() - datetime.timedelta(days=1)
    vehicle = Vehicle(insurance_expires_at=yesterday, roadworthiness_expires_at=yesterday)
    warnings = compliance_warnings_for(vehicle)
    assert len(warnings) == 2
    assert any("insurance" in w for w in warnings)
    assert any("Roadworthiness" in w for w in warnings)


def test_compliance_warnings_for_driver_reports_expired_license() -> None:
    yesterday = datetime.date.today() - datetime.timedelta(days=1)
    driver = Driver(license_expires_at=yesterday)
    assert compliance_warnings_for(driver) == [
        f"Driver's license expired on {yesterday.isoformat()}"
    ]
