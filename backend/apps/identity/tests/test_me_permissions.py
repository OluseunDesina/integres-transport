import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.clients.tests.factories import ClientFactory
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import (
    ClientStaffUserFactory,
    PassengerUserFactory,
    PlatformStaffUserFactory,
)

pytestmark = pytest.mark.django_db


def _auth_client(user: object) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)  # type: ignore[arg-type]
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_passenger_permissions_array() -> None:
    passenger = PassengerUserFactory()
    response = _auth_client(passenger).get(reverse("me"))
    assert response.data["permissions"] == ["customer:access"]


def test_platform_staff_permissions_array() -> None:
    platform_staff = PlatformStaffUserFactory()
    response = _auth_client(platform_staff).get(reverse("me"))
    assert response.data["permissions"] == ["super-admin:access"]


def test_owner_client_staff_permissions_array_includes_all_codenames() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    owner = ClientStaffUserFactory(client=client, role=roles["Owner"])

    response = _auth_client(owner).get(reverse("me"))

    permissions = response.data["permissions"]
    assert "client-admin:access" in permissions
    assert "business.manage" in permissions
    assert "staff.invite" in permissions


def test_staff_client_staff_permissions_array_is_limited() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])

    response = _auth_client(staff).get(reverse("me"))

    assert response.data["permissions"] == [
        "client-admin:access",
        "booking.view",
        "client.view",
        "fares.view",
        "fleet.view",
        # docs/specs/17-incidents.md — Staff get both, unlike
        # `analytics.view`, which is still correctly absent below.
        "incidents.manage",
        "incidents.view",
        "ledger.view",
        "network.view",
        "notifications.view",
        "payments.view",
        "scheduling.view",
        "seating.view",
        "tapngo.record",
        "tapngo.view",
        "ticketing.validate",
        "wallet.view",
    ]


def test_client_staff_with_no_role_gets_only_the_base_access_string() -> None:
    # role=None to the factory means "not provided" (factory_boy can't
    # distinguish "explicitly None" from "omitted"), so clear it after
    # creation instead of relying on the factory kwarg.
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    staff.role = None
    staff.save(update_fields=["role"])

    response = _auth_client(staff).get(reverse("me"))
    assert response.data["permissions"] == ["client-admin:access"]
