"""GET /trips/search/ — the passenger-facing Trip list. See
docs/specs/4-fares-seating-booking-frontend.md §3.3."""

import datetime

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory

from ..models import Trip
from .factories import TripFactory

pytestmark = pytest.mark.django_db

SERVICE_DATE = datetime.date(2026, 8, 10)


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _route_with_trip(client: object, **trip_overrides: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client)
        trip = TripFactory(client=client, route=route, business=route.business, **trip_overrides)
        return route, trip


def test_passenger_can_search_scheduled_reservation_trips_on_a_route_and_date() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, trip = _route_with_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-08-10"}
    )

    assert response.status_code == status.HTTP_200_OK
    rows = response.data["results"]
    assert [row["id"] for row in rows] == [str(trip.id)]
    assert rows[0]["route"] == {"id": route.id, "name": route.name}


def test_search_excludes_trips_on_another_date() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, wanted = _route_with_trip(client, service_date=SERVICE_DATE)
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=datetime.date(2026, 8, 11),
        )

    response = _auth_client(passenger).get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-08-10"}
    )

    assert [row["id"] for row in response.data["results"]] == [str(wanted.id)]


def test_search_excludes_trips_on_another_route() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, wanted = _route_with_trip(client, service_date=SERVICE_DATE)
    _route_with_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-08-10"}
    )

    assert [row["id"] for row in response.data["results"]] == [str(wanted.id)]


@pytest.mark.parametrize(
    "excluded_status",
    [Trip.Status.IN_PROGRESS, Trip.Status.COMPLETED, Trip.Status.CANCELLED],
)
def test_search_returns_only_scheduled_trips(excluded_status: str) -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, scheduled = _route_with_trip(client, service_date=SERVICE_DATE)
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=SERVICE_DATE,
            status=excluded_status,
        )

    response = _auth_client(passenger).get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-08-10"}
    )

    assert [row["id"] for row in response.data["results"]] == [str(scheduled.id)]


def test_search_excludes_tap_and_go_trips() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, reservation_trip = _route_with_trip(client, service_date=SERVICE_DATE)
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=SERVICE_DATE,
            booking_mode=Business.BookingMode.TAP_AND_GO,
        )

    response = _auth_client(passenger).get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-08-10"}
    )

    assert [row["id"] for row in response.data["results"]] == [str(reservation_trip.id)]


def test_search_ignores_a_caller_supplied_status_or_booking_mode() -> None:
    """Both filters are forced server-side — a passenger must not be
    able to widen the search by guessing query params."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, scheduled = _route_with_trip(client, service_date=SERVICE_DATE)
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=SERVICE_DATE,
            status=Trip.Status.CANCELLED,
        )
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=SERVICE_DATE,
            booking_mode=Business.BookingMode.TAP_AND_GO,
        )

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {
            "route": str(route.id),
            "service_date": "2026-08-10",
            "status": Trip.Status.CANCELLED,
            "booking_mode": Business.BookingMode.TAP_AND_GO,
        },
    )

    assert [row["id"] for row in response.data["results"]] == [str(scheduled.id)]


def test_search_returns_an_empty_list_when_nothing_runs_that_day() -> None:
    """A real, expected outcome — not an error. §5 of the spec."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, _ = _route_with_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-12-25"}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({}, id="both-missing"),
        pytest.param({"service_date": "2026-08-10"}, id="route-missing"),
        pytest.param({"route": "not-a-uuid", "service_date": "2026-08-10"}, id="route-malformed"),
        pytest.param({"service_date": "10-08-2026"}, id="date-malformed"),
    ],
)
def test_search_400s_on_missing_or_malformed_params(params: dict[str, str]) -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _route_with_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(reverse("trip-search"), params)

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_search_400s_on_a_missing_service_date() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, _ = _route_with_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(reverse("trip-search"), {"route": str(route.id)})

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_search_400s_on_another_clients_route() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    route_b, _ = _route_with_trip(client_b, service_date=SERVICE_DATE)

    response = _auth_client(passenger_a).get(
        reverse("trip-search"), {"route": str(route_b.id), "service_date": "2026-08-10"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_search_is_open_to_a_passenger_who_is_403ed_by_the_staff_trip_list() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, _ = _route_with_trip(client, service_date=SERVICE_DATE)
    api = _auth_client(passenger)

    searched = api.get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-08-10"}
    )

    assert searched.status_code == status.HTTP_200_OK
    assert api.get(reverse("trip-list-create")).status_code == status.HTTP_403_FORBIDDEN


def test_search_rejects_an_unauthenticated_request() -> None:
    client = ClientFactory()
    route, _ = _route_with_trip(client, service_date=SERVICE_DATE)

    response = APIClient().get(
        reverse("trip-search"), {"route": str(route.id), "service_date": "2026-08-10"}
    )

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
