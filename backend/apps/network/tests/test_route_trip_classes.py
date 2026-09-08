"""`Route.available_trip_classes` — docs/specs/15-trip-classes.md.

A JSONField, so nothing below the serializer validates its contents. A
typo would save cleanly and only surface much later as a Schedule that
can never be created on the route — the same failure shape
`validate_iana_timezone` was written to close.
"""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory

from ..models import Route
from .factories import RouteFactory

pytestmark = pytest.mark.django_db

PREMIUM = Business.TripClass.PREMIUM
STANDARD = Business.TripClass.STANDARD


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _approved_business(client: object, **overrides: object) -> Business:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED, **overrides)


def test_a_route_is_created_with_an_empty_allow_list_by_default() -> None:
    """Empty means no restriction, so an operator who never thinks about
    classes is not silently blocked from scheduling anything."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("route-list-create"), {"business": str(business.id), "name": "Ikeja Express"}
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["available_trip_classes"] == []


def test_an_allow_list_can_be_set_at_creation() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("route-list-create"),
        {
            "business": str(business.id),
            "name": "Ikeja Express",
            "available_trip_classes": [PREMIUM, STANDARD],
        },
        format="json",
    )

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        route = Route.objects.get(pk=response.data["id"])
    assert route.available_trip_classes == [PREMIUM, STANDARD]


def test_an_unknown_class_is_rejected() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("route-list-create"),
        {
            "business": str(business.id),
            "name": "Ikeja Express",
            "available_trip_classes": ["first_class"],
        },
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "available_trip_classes" in response.data


def test_duplicates_are_rejected() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("route-list-create"),
        {
            "business": str(business.id),
            "name": "Ikeja Express",
            "available_trip_classes": [PREMIUM, PREMIUM],
        },
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_the_allow_list_is_patchable_and_still_validated() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
    api = _auth_client(staff)
    url = reverse("route-detail", kwargs={"pk": str(route.id)})

    ok = api.patch(url, {"available_trip_classes": [PREMIUM]}, format="json")
    bad = api.patch(url, {"available_trip_classes": ["sleeper"]}, format="json")

    assert ok.status_code == status.HTTP_200_OK
    assert ok.data["available_trip_classes"] == [PREMIUM]
    assert bad.status_code == status.HTTP_400_BAD_REQUEST
