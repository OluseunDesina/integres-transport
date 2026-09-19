"""GET /stops/suggest/ — the passenger-facing Stop suggestion list
backing customer-app's origin/destination typeahead. See
docs/specs/4-fares-seating-booking-frontend.md §3.3 (reworked flow)."""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory

from .factories import StopFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_suggests_stops_matching_the_query() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        yaba = StopFactory(client=client, name="Yaba")
        StopFactory(client=client, name="Ikeja")

    response = _auth_client(passenger).get(reverse("stop-suggest"), {"q": "yab"})

    assert response.status_code == status.HTTP_200_OK
    assert response.data == [{"id": str(yaba.id), "name": "Yaba"}]


def test_returns_a_bare_list_not_a_paginated_envelope() -> None:
    """pagination_class = None — see the view's own docstring on why."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        StopFactory(client=client, name="Yaba")

    response = _auth_client(passenger).get(reverse("stop-suggest"))

    assert isinstance(response.data, list)


def test_returns_a_default_list_when_q_is_empty() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        StopFactory(client=client, name="Yaba")
        StopFactory(client=client, name="Ikeja")

    response = _auth_client(passenger).get(reverse("stop-suggest"))

    assert {row["name"] for row in response.data} == {"Yaba", "Ikeja"}


def test_excludes_an_inactive_stop() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        StopFactory(client=client, name="Yaba")
        StopFactory(client=client, name="Retired Stop", is_active=False)

    response = _auth_client(passenger).get(reverse("stop-suggest"))

    assert {row["name"] for row in response.data} == {"Yaba"}


def test_deduplicates_same_named_stops_across_businesses() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        StopFactory(client=client, name="Yaba")
        StopFactory(client=client, name="Yaba")

    response = _auth_client(passenger).get(reverse("stop-suggest"), {"q": "yaba"})

    assert len(response.data) == 1


def test_is_case_insensitive() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        StopFactory(client=client, name="Yaba")

    response = _auth_client(passenger).get(reverse("stop-suggest"), {"q": "YABA"})

    assert len(response.data) == 1


def test_respects_the_limit_param() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        for i in range(5):
            StopFactory(client=client, name=f"Stop {i}")

    response = _auth_client(passenger).get(reverse("stop-suggest"), {"limit": 2})

    assert len(response.data) == 2


def test_400s_on_a_limit_over_the_cap() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("stop-suggest"), {"limit": 51})

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_never_returns_another_clients_stops() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    with tenant_context(str(client_a.id)):
        StopFactory(client=client_a, name="Yaba")
    with tenant_context(str(client_b.id)):
        StopFactory(client=client_b, name="Ikeja")

    response = _auth_client(passenger_a).get(reverse("stop-suggest"))

    assert {row["name"] for row in response.data} == {"Yaba"}


def test_is_open_to_a_passenger_who_is_403ed_by_the_staff_stop_list() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    api = _auth_client(passenger)

    assert api.get(reverse("stop-suggest")).status_code == status.HTTP_200_OK
    assert api.get(reverse("stop-list-create")).status_code == status.HTTP_403_FORBIDDEN


def test_rejects_an_unauthenticated_request() -> None:
    response = APIClient().get(reverse("stop-suggest"))

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
