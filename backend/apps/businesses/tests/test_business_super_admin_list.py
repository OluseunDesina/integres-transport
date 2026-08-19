"""GET /super-admin/businesses/ — cross-client Business search for
platform staff, Phase 5 frontend Slice C. Mirrors
apps/businesses/tests/test_kyb_queue.py's shape."""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    SuperAdminTokenObtainSerializer,
)
from apps.identity.tests.factories import (
    ClientStaffUserFactory,
    PassengerUserFactory,
    PlatformStaffUserFactory,
)

pytestmark = pytest.mark.django_db


def _auth_client(user: User, *, platform_staff: bool = False) -> APIClient:
    serializer_cls = (
        SuperAdminTokenObtainSerializer if platform_staff else ClientAdminTokenObtainSerializer
    )
    token = serializer_cls.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_platform_staff_sees_businesses_across_multiple_clients() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_a.id)):
        business_a = BusinessFactory(client=client_a, name="Lagos Shuttle")
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b, name="Gaborone Metro")
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(
        reverse("business-super-admin-list")
    )

    assert response.status_code == status.HTTP_200_OK
    ids = {row["id"] for row in response.data["results"]}
    assert {str(business_a.id), str(business_b.id)} <= ids
    row_a = next(row for row in response.data["results"] if row["id"] == str(business_a.id))
    assert row_a["client_name"] == client_a.name


def test_search_filters_by_business_name() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        BusinessFactory(client=client, name="Lagos Shuttle")
        BusinessFactory(client=client, name="Gaborone Metro")
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(
        reverse("business-super-admin-list"), {"search": "Lagos"}
    )

    assert response.status_code == status.HTTP_200_OK
    names = [row["name"] for row in response.data["results"]]
    assert names == ["Lagos Shuttle"]


def test_client_admin_staff_cannot_list_businesses_cross_client() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).get(reverse("business-super-admin-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_passenger_cannot_list_businesses_cross_client() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("business-super-admin-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_unauthenticated_request_is_rejected() -> None:
    response = APIClient().get(reverse("business-super-admin-list"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_approved_business_still_appears_unlike_kyb_queue() -> None:
    """The bug this endpoint fixes: an approved Business drops out of
    `KybQueueListView` (kyb_status filter), leaving platform staff with
    no way to find it at all."""
    with tenant_context(None, is_platform_staff=True):
        business = BusinessFactory(kyb_status=Business.KybStatus.APPROVED)
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(
        reverse("business-super-admin-list")
    )

    assert response.status_code == status.HTTP_200_OK
    ids = [row["id"] for row in response.data["results"]]
    assert str(business.id) in ids
