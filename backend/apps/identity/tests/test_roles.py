import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import Permission, Role, User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_create_default_roles_creates_owner_manager_staff_with_correct_permissions() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)

    assert set(roles) == {"Owner", "Manager", "Staff"}
    all_codenames = set(Permission.objects.values_list("codename", flat=True))
    with tenant_context(None, is_platform_staff=True):
        owner_codenames = set(roles["Owner"].permissions.values_list("codename", flat=True))
        manager_codenames = set(roles["Manager"].permissions.values_list("codename", flat=True))
        staff_codenames = set(roles["Staff"].permissions.values_list("codename", flat=True))

    assert owner_codenames == all_codenames
    assert manager_codenames == {
        "client.view",
        "business.manage",
        "kyb.submit",
        "network.view",
        "network.manage",
        "fleet.view",
        "fleet.manage",
        "scheduling.view",
        "scheduling.manage",
        "fares.view",
        "fares.manage",
        "seating.view",
        "seating.manage",
        "booking.view",
        "tapngo.record",
        "tapngo.view",
        "ledger.view",
        "payments.view",
        "wallet.view",
        "ticketing.validate",
    }
    assert staff_codenames == {
        "client.view",
        "network.view",
        "fleet.view",
        "scheduling.view",
        "fares.view",
        "seating.view",
        "booking.view",
        "tapngo.record",
        "tapngo.view",
        "ledger.view",
        "payments.view",
        "wallet.view",
        "ticketing.validate",
    }
    assert roles["Owner"].is_default_owner_role is True
    assert roles["Manager"].is_default_owner_role is False


def test_create_default_roles_is_idempotent() -> None:
    client = ClientFactory()
    create_default_roles(client)
    create_default_roles(client)

    with tenant_context(None, is_platform_staff=True):
        assert Role.all_objects.filter(client=client).count() == 3


def test_registration_assigns_the_owner_role() -> None:
    response = APIClient().post(
        reverse("client-register"),
        {
            "name": "Acme Shuttle Co",
            "email": "owner@acme.example.com",
            "phone": "+2348012345678",
            "password": "a-strong-unguessable-passphrase-42",
        },
    )
    assert response.status_code == status.HTTP_201_CREATED
    owner = User.objects.get(email="owner@acme.example.com")
    with tenant_context(str(owner.client_id)):
        assert owner.role is not None
        assert owner.role.name == "Owner"
        assert owner.role.is_default_owner_role is True


def test_staff_role_is_blocked_from_business_manage_gated_endpoint() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])

    response = _auth_client(staff).post(
        reverse("business-list-create"),
        {
            "vertical": "shuttle",
            "name": "Blocked Business",
            "currency": "NGN",
            "timezone": "Africa/Lagos",
            "booking_mode_default": "reservation",
        },
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_staff_role_can_still_list_businesses() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])

    response = _auth_client(staff).get(reverse("business-list-create"))
    assert response.status_code == status.HTTP_200_OK


def test_manager_role_can_create_a_business() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    manager = ClientStaffUserFactory(client=client, role=roles["Manager"])

    response = _auth_client(manager).post(
        reverse("business-list-create"),
        {
            "vertical": "shuttle",
            "name": "Manager's Business",
            "currency": "NGN",
            "timezone": "Africa/Lagos",
            "booking_mode_default": "reservation",
        },
    )
    assert response.status_code == status.HTTP_201_CREATED


def test_client_staff_with_no_role_is_blocked() -> None:
    # role=None to the factory means "not provided" (factory_boy can't
    # distinguish "explicitly None" from "omitted"), so clear it after
    # creation instead of relying on the factory kwarg.
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    staff.role = None
    staff.save(update_fields=["role"])

    response = _auth_client(staff).get(reverse("staff-role-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_role_list_returns_only_the_callers_own_clients_roles() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    roles_a = create_default_roles(client_a)
    create_default_roles(client_b)
    staff_a = ClientStaffUserFactory(client=client_a, role=roles_a["Owner"])

    response = _auth_client(staff_a).get(reverse("staff-role-list"))

    assert response.status_code == status.HTTP_200_OK
    names = {row["name"] for row in response.data["results"]}
    assert names == {"Owner", "Manager", "Staff"}


def test_role_list_requires_client_view_permission() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    response = _auth_client(passenger).get(reverse("staff-role-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN
