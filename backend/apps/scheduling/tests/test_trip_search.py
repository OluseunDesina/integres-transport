"""GET /trips/search/ — the passenger-facing Trip search. Reworked for
the origin/destination flow: see
apps.network.services.find_route_stop_matches and
docs/specs/4-fares-seating-booking-frontend.md §3.3."""

import datetime

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.models import Route
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory

from ..models import Trip
from .factories import TripFactory

pytestmark = pytest.mark.django_db

SERVICE_DATE = datetime.date(2026, 8, 10)


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _priced_trip(
    client: object,
    *,
    from_name: str = "Yaba",
    to_name: str = "Ikeja",
    between: int = 0,
    **trip_overrides: object,
):  # type: ignore[no-untyped-def]
    """A Route with a fare-configured flat rule and `between` stops
    strictly between `from_name` and `to_name` — the minimum this
    endpoint's happy path needs (a match *and* a price, or the Trip is
    excluded per TripSearchView's own FareNotConfigured handling)."""
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client)
        from_stop = StopFactory(client=client, business=route.business, name=from_name)
        RouteStopFactory(client=client, route=route, stop=from_stop, sequence=1)
        for i in range(between):
            filler = StopFactory(client=client, business=route.business, name=f"Filler {i}")
            RouteStopFactory(client=client, route=route, stop=filler, sequence=2 + i)
        to_stop = StopFactory(client=client, business=route.business, name=to_name)
        RouteStopFactory(client=client, route=route, stop=to_stop, sequence=2 + between)
        FareRuleFactory(client=client, route=route, amount="1500.00")
        trip = TripFactory(client=client, route=route, business=route.business, **trip_overrides)
        return route, from_stop, to_stop, trip


def test_passenger_can_search_by_origin_destination_and_gets_price_and_stop_count() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, from_stop, to_stop, trip = _priced_trip(client, service_date=SERVICE_DATE, between=2)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.status_code == status.HTTP_200_OK
    rows = response.data["results"]
    assert len(rows) == 1
    row = rows[0]
    assert row["trip"]["id"] == str(trip.id)
    assert row["from_stop"] == {"id": str(from_stop.id), "name": from_stop.name}
    assert row["to_stop"] == {"id": str(to_stop.id), "name": to_stop.name}
    assert row["stops_between"] == 2
    assert row["fare"] == {"amount": "1500.00", "currency": route.business.currency}
    assert row["business_name"] == route.business.name


def test_search_result_omits_vehicle_type_duration_and_arrival_when_not_yet_set() -> None:
    """The baseline this feature has to preserve: an operator who hasn't
    assigned a vehicle or set a route duration yet still gets a valid,
    bookable search result — "if available" (docs/specs/22-marketplace.md
    slice 2), not assumed to always exist."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    row = response.data["results"][0]
    assert row["trip"]["vehicle"] is None
    assert row["duration_minutes"] is None
    assert row["scheduled_arrival_at"] is None


def test_search_result_includes_vehicle_type_when_a_vehicle_is_assigned() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, _from_stop, _to_stop, trip = _priced_trip(client, service_date=SERVICE_DATE)
    with tenant_context(str(client.id)):
        vehicle = VehicleFactory(client=client, business=route.business)
        trip.vehicle = vehicle
        trip.save(update_fields=["vehicle"])

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    row = response.data["results"][0]
    # `vehicle` is a `SerializerMethodField` returning a plain dict, never
    # run through `TripVehicleSerializer.to_representation()` (that
    # serializer exists only for the OpenAPI schema via
    # `@extend_schema_field`) — so `response.data` (read before JSON
    # rendering) holds the model's actual `UUID`, not a string. A real
    # HTTP response still renders it as a string via the JSON encoder;
    # only this in-process `response.data` inspection sees the raw type.
    assert row["trip"]["vehicle"]["vehicle_type"] == {
        "id": vehicle.vehicle_type.id,
        "name": vehicle.vehicle_type.name,
    }


def test_search_result_computes_duration_and_arrival_from_the_routes_estimate() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, _from_stop, _to_stop, trip = _priced_trip(
        client,
        service_date=SERVICE_DATE,
        scheduled_departure_at=datetime.datetime(2026, 8, 10, 8, 0, tzinfo=datetime.UTC),
    )
    with tenant_context(str(client.id)):
        route.estimated_duration_minutes = 90
        route.save(update_fields=["estimated_duration_minutes"])

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    row = response.data["results"][0]
    assert row["duration_minutes"] == 90
    # Same raw-Python-object caveat as the vehicle_type assertion above —
    # `scheduled_arrival_at` is a `SerializerMethodField` too.
    assert row["scheduled_arrival_at"] == datetime.datetime(
        2026, 8, 10, 9, 30, tzinfo=datetime.UTC
    )


def test_direct_connection_has_zero_stops_between() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=SERVICE_DATE, between=0)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.data["results"][0]["stops_between"] == 0


def test_search_excludes_trips_on_another_date() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=datetime.date(2026, 8, 11))

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.data["results"] == []


def test_search_finds_nothing_when_no_route_connects_the_two_stops() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=SERVICE_DATE, from_name="Yaba", to_name="Ikeja")

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "somewhere else", "destination": "nowhere", "service_date": "2026-08-10"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


@pytest.mark.parametrize(
    "excluded_status",
    [Trip.Status.IN_PROGRESS, Trip.Status.COMPLETED, Trip.Status.CANCELLED],
)
def test_search_returns_only_scheduled_trips(excluded_status: str) -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=SERVICE_DATE, status=excluded_status)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.data["results"] == []


def test_search_excludes_pay_as_you_go_trips() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(
        client,
        service_date=SERVICE_DATE,
        fare_collection_mode=Business.FareCollectionMode.PAY_AS_YOU_GO,
    )

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.data["results"] == []


def test_search_ignores_a_caller_supplied_status_or_fare_collection_mode() -> None:
    """Both filters are forced server-side — a passenger must not be
    able to widen the search by guessing query params."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _, _, _, scheduled = _priced_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {
            "origin": "yaba",
            "destination": "ikeja",
            "service_date": "2026-08-10",
            "status": Trip.Status.CANCELLED,
            "fare_collection_mode": Business.FareCollectionMode.PAY_AS_YOU_GO,
        },
    )

    assert [row["trip"]["id"] for row in response.data["results"]] == [str(scheduled.id)]


def test_search_narrows_by_trip_class() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route, from_stop, to_stop, premium = _priced_trip(
        client, service_date=SERVICE_DATE, trip_class=Business.TripClass.PREMIUM
    )
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=SERVICE_DATE,
            trip_class=Business.TripClass.STANDARD,
        )

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {
            "origin": "yaba",
            "destination": "ikeja",
            "service_date": "2026-08-10",
            "trip_class": Business.TripClass.PREMIUM,
        },
    )

    assert [row["trip"]["id"] for row in response.data["results"]] == [str(premium.id)]


def test_search_excludes_a_trip_with_no_fare_configured() -> None:
    """A real, deliberate outcome (this endpoint's own note): an
    unconfigured fare excludes the Trip from the list rather than
    showing a row with no price — there is no booking step yet here to
    block instead, so the exclusion happens at list time."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)
        # No FareRule created — flat mode, no covering rule.
        TripFactory(client=client, route=route, business=route.business, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


def test_search_returns_an_empty_list_when_nothing_runs_that_day() -> None:
    """A real, expected outcome — not an error. §5 of the spec."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-12-25"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


@pytest.mark.parametrize(
    "params",
    [
        pytest.param({}, id="all-missing"),
        pytest.param({"origin": "yaba", "service_date": "2026-08-10"}, id="destination-missing"),
        pytest.param({"destination": "ikeja", "service_date": "2026-08-10"}, id="origin-missing"),
        pytest.param({"origin": "yaba", "destination": "ikeja"}, id="date-missing"),
        pytest.param(
            {"origin": "yaba", "destination": "ikeja", "service_date": "10-08-2026"},
            id="date-malformed",
        ),
    ],
)
def test_search_400s_on_missing_or_malformed_params(params: dict[str, str]) -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(reverse("trip-search"), params)

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_search_never_returns_another_clients_trip_for_the_same_stop_names() -> None:
    """Origin/destination are free text, not an id — nothing about them
    proves ownership the way a Route id used to, so isolation now rests
    entirely on find_route_stop_matches's own tenant scoping. Worth its
    own end-to-end check through the view, not just the service's own
    unit test."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    _priced_trip(client_a, service_date=SERVICE_DATE)
    _, _, _, trip_b = _priced_trip(client_b, service_date=SERVICE_DATE)

    response = _auth_client(passenger_a).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert trip_b.id not in [row["trip"]["id"] for row in response.data["results"]]


def test_search_is_open_to_a_passenger_who_is_403ed_by_the_staff_trip_list() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _priced_trip(client, service_date=SERVICE_DATE)
    api = _auth_client(passenger)

    searched = api.get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert searched.status_code == status.HTTP_200_OK
    assert api.get(reverse("trip-list-create")).status_code == status.HTTP_403_FORBIDDEN


def test_search_rejects_an_unauthenticated_request() -> None:
    client = ClientFactory()
    _priced_trip(client, service_date=SERVICE_DATE)

    response = APIClient().get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_search_excludes_a_route_that_is_not_active() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, status=Route.Status.INACTIVE)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)
        FareRuleFactory(client=client, route=route)
        TripFactory(client=client, route=route, business=route.business, service_date=SERVICE_DATE)

    response = _auth_client(passenger).get(
        reverse("trip-search"),
        {"origin": "yaba", "destination": "ikeja", "service_date": "2026-08-10"},
    )

    assert response.data["results"] == []
