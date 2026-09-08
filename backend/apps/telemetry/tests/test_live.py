import datetime
from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.tests.factories import BookingFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleFactory
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    CustomerTokenObtainSerializer,
)
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory
from apps.tapngo.models import FareJourney
from apps.tapngo.tests.factories import TapCredentialFactory
from apps.ticketing.services import issue_open_seating_tickets

from ..live import compute_eta, compute_progress
from .factories import VehicleLiveStateFactory, VehiclePositionFactory

pytestmark = pytest.mark.django_db


def _staff_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _passenger_client(user: User) -> APIClient:
    token = CustomerTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _business(client: object) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        from apps.businesses.tests.factories import BusinessFactory

        return BusinessFactory(client=client)


def _coordinated_route(
    client: object, business: object, *, estimated_duration_minutes: int | None = 30
) -> tuple:
    """A three-stop route with real coordinates, roughly a straight
    line, so nearest-stop-by-distance is unambiguous."""
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(
            client=client,
            business=business,
            estimated_duration_minutes=estimated_duration_minutes,
        )
        stop_a = StopFactory(
            client=client,
            business=business,
            latitude=Decimal("6.5000"),
            longitude=Decimal("3.3000"),
        )
        stop_b = StopFactory(
            client=client,
            business=business,
            latitude=Decimal("6.6000"),
            longitude=Decimal("3.3000"),
        )
        stop_c = StopFactory(
            client=client,
            business=business,
            latitude=Decimal("6.7000"),
            longitude=Decimal("3.3000"),
        )
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        RouteStopFactory(client=client, route=route, stop=stop_c, sequence=3)
    return route, [stop_a, stop_b, stop_c]


def _in_progress_trip(
    client: object, business: object, route: object, vehicle: object, **overrides: object
) -> Trip:
    # A recent departure, not TripFactory's own fixed calendar-date
    # default — apps.ticketing.services._issue anchors Ticket.expires_at
    # to trip.scheduled_departure_at, which must be after "now" (the
    # ticket's issued_at) for several of this file's tests to issue one.
    now = timezone.now()
    defaults: dict[str, object] = {
        "service_date": now.date(),
        "scheduled_departure_at": now - datetime.timedelta(minutes=10),
    }
    defaults.update(overrides)
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            status=Trip.Status.IN_PROGRESS,
            **defaults,
        )


def _vehicle(client: object, business: object) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return VehicleFactory(client=client, business=business)


def _live_state(
    client: object, business: object, trip: Trip, vehicle: object, **overrides: object
) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return VehicleLiveStateFactory(
            client=client, business=business, trip=trip, vehicle=vehicle, **overrides
        )


def _ticket_for(
    client: object, business: object, trip: Trip, stops: list, passenger: object
) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        booking = BookingFactory(client=client, business=business, trip=trip, passenger=passenger)
        tickets = issue_open_seating_tickets(
            booking=booking, from_stop=stops[0], to_stop=stops[-1], passenger_count=1
        )
    return tickets[0]


def _fare_journey_for(
    client: object, business: object, trip: Trip, stop: object, passenger: object
) -> FareJourney:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        credential = TapCredentialFactory(client=client, passenger=passenger)
        return FareJourney.objects.create(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            credential=credential,
            board_stop=stop,
            status=FareJourney.Status.OPEN,
            boarded_at=timezone.now(),
        )


# --- GET /trips/live/ -------------------------------------------------


def test_trips_live_includes_position_progress_and_occupancy() -> None:
    client = ClientFactory()
    business = _business(client)
    staff = ClientStaffUserFactory(client=client)
    route, stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    trip = _in_progress_trip(
        client,
        business,
        route,
        vehicle,
        actual_departure_at=timezone.now() - datetime.timedelta(minutes=5),
    )
    _live_state(
        client, business, trip, vehicle, latitude=stops[1].latitude, longitude=stops[1].longitude
    )

    response = _staff_client(staff).get(reverse("trips-live"))

    assert response.status_code == status.HTTP_200_OK
    assert "poll_interval_seconds" in response.data
    # The client's own `?since=` cursor on its *next* poll — the
    # server's clock, not an echo of the request, so client/server skew
    # cannot make it drop a real update.
    assert "server_time" in response.data
    envelope = response.data["results"][0]
    assert envelope["trip"]["id"] == str(trip.id)
    assert envelope["position"] is not None
    assert envelope["progress"]["method"] == "nearest_stop"
    assert envelope["progress"]["stops_completed"] == 2
    assert envelope["eta"]["method"] == "scheduled_segment"
    assert envelope["occupancy"]["capacity"] is not None
    assert envelope["incidents_open"] == 0


def test_trips_live_position_null_with_no_telemetry() -> None:
    client = ClientFactory()
    business = _business(client)
    staff = ClientStaffUserFactory(client=client)
    route, _stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    _in_progress_trip(client, business, route, vehicle)

    response = _staff_client(staff).get(reverse("trips-live"))

    envelope = response.data["results"][0]
    assert envelope["position"] is None
    assert envelope["progress"] is None
    assert envelope["eta"] is None


def test_trips_live_empty_fleet_is_empty_list_not_error() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _staff_client(staff).get(reverse("trips-live"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


def test_trips_live_completed_trip_is_excluded() -> None:
    client = ClientFactory()
    business = _business(client)
    staff = ClientStaffUserFactory(client=client)
    route, stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    trip = _in_progress_trip(client, business, route, vehicle)
    _live_state(
        client, business, trip, vehicle, latitude=stops[0].latitude, longitude=stops[0].longitude
    )
    with tenant_context(str(client.id)):
        trip.status = Trip.Status.COMPLETED
        trip.save(update_fields=["status"])

    response = _staff_client(staff).get(reverse("trips-live"))

    assert response.data["results"] == []


def test_trips_live_returns_304_when_etag_unchanged() -> None:
    client = ClientFactory()
    business = _business(client)
    staff = ClientStaffUserFactory(client=client)
    route, stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    trip = _in_progress_trip(client, business, route, vehicle)
    _live_state(
        client, business, trip, vehicle, latitude=stops[0].latitude, longitude=stops[0].longitude
    )
    api = _staff_client(staff)

    first = api.get(reverse("trips-live"))
    etag = first["ETag"]
    second = api.get(reverse("trips-live"), HTTP_IF_NONE_MATCH=etag)

    assert second.status_code == status.HTTP_304_NOT_MODIFIED


def test_trips_live_since_cursor_excludes_unmoved_trips() -> None:
    client = ClientFactory()
    business = _business(client)
    staff = ClientStaffUserFactory(client=client)
    route, stops = _coordinated_route(client, business)
    vehicle_a = _vehicle(client, business)
    vehicle_b = _vehicle(client, business)
    trip_a = _in_progress_trip(client, business, route, vehicle_a)
    trip_b = _in_progress_trip(client, business, route, vehicle_b)
    _live_state(
        client,
        business,
        trip_a,
        vehicle_a,
        latitude=stops[0].latitude,
        longitude=stops[0].longitude,
    )
    _live_state(
        client,
        business,
        trip_b,
        vehicle_b,
        latitude=stops[0].latitude,
        longitude=stops[0].longitude,
    )
    cursor = timezone.now().isoformat()

    response = _staff_client(staff).get(reverse("trips-live"), {"since": cursor})

    # Neither state has moved since the cursor, but a brand-new
    # no-signal trip would still show up unconditionally — asserted by
    # the "no telemetry" test above. Here, both already have state
    # older than the cursor, so neither is included.
    assert response.data["results"] == []


def test_trips_live_requires_authentication() -> None:
    response = APIClient().get(reverse("trips-live"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_trips_live_rejects_passenger() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    response = _passenger_client(passenger).get(reverse("trips-live"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_trips_live_excludes_another_clients_trips() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_a = _business(client_a)
    route_a, stops_a = _coordinated_route(client_a, business_a)
    vehicle_a = _vehicle(client_a, business_a)
    trip_a = _in_progress_trip(client_a, business_a, route_a, vehicle_a)
    _live_state(
        client_a,
        business_a,
        trip_a,
        vehicle_a,
        latitude=stops_a[0].latitude,
        longitude=stops_a[0].longitude,
    )
    staff_b = ClientStaffUserFactory(client=client_b)

    response = _staff_client(staff_b).get(reverse("trips-live"))

    assert response.data["results"] == []


# --- GET /trips/{id}/live/ ---------------------------------------------


def test_trip_live_detail_allows_staff() -> None:
    client = ClientFactory()
    business = _business(client)
    staff = ClientStaffUserFactory(client=client)
    route, stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    trip = _in_progress_trip(client, business, route, vehicle)
    _live_state(
        client, business, trip, vehicle, latitude=stops[0].latitude, longitude=stops[0].longitude
    )

    response = _staff_client(staff).get(reverse("trip-live-detail", args=[trip.id]))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["trip"]["id"] == str(trip.id)


def test_trip_live_detail_allows_ticket_holding_passenger() -> None:
    client = ClientFactory()
    business = _business(client)
    route, stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    trip = _in_progress_trip(client, business, route, vehicle)
    passenger = PassengerUserFactory(client=client)
    _ticket_for(client, business, trip, stops, passenger)

    response = _passenger_client(passenger).get(reverse("trip-live-detail", args=[trip.id]))

    assert response.status_code == status.HTTP_200_OK


def test_trip_live_detail_allows_fare_journey_holding_passenger() -> None:
    client = ClientFactory()
    business = _business(client)
    route, stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    trip = _in_progress_trip(client, business, route, vehicle)
    passenger = PassengerUserFactory(client=client)
    _fare_journey_for(client, business, trip, stops[0], passenger)

    response = _passenger_client(passenger).get(reverse("trip-live-detail", args=[trip.id]))

    assert response.status_code == status.HTTP_200_OK


def test_trip_live_detail_rejects_non_holding_passenger() -> None:
    client = ClientFactory()
    business = _business(client)
    route, _stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    trip = _in_progress_trip(client, business, route, vehicle)
    passenger = PassengerUserFactory(client=client)

    response = _passenger_client(passenger).get(reverse("trip-live-detail", args=[trip.id]))

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_trip_live_detail_unknown_trip_is_404() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    response = _staff_client(staff).get(
        reverse("trip-live-detail", args=["00000000-0000-0000-0000-000000000000"])
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_trip_live_detail_another_clients_trip_is_404() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_a = _business(client_a)
    route_a, _stops = _coordinated_route(client_a, business_a)
    vehicle_a = _vehicle(client_a, business_a)
    trip_a = _in_progress_trip(client_a, business_a, route_a, vehicle_a)
    staff_b = ClientStaffUserFactory(client=client_b)

    response = _staff_client(staff_b).get(reverse("trip-live-detail", args=[trip_a.id]))

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_trip_live_detail_completed_trip_returns_last_known_position() -> None:
    """A vehicle reused for a later trip must not leak that trip's live
    position onto an earlier, completed one — see
    `apps.telemetry.live.current_position_for`'s own docstring."""
    client = ClientFactory()
    business = _business(client)
    route, stops = _coordinated_route(client, business)
    vehicle = _vehicle(client, business)
    old_trip = _in_progress_trip(client, business, route, vehicle)
    passenger = PassengerUserFactory(client=client)
    _ticket_for(client, business, old_trip, stops, passenger)

    with tenant_context(str(client.id)):
        VehiclePositionFactory(
            client=client,
            business=business,
            vehicle=vehicle,
            trip=old_trip,
            latitude=stops[0].latitude,
            longitude=stops[0].longitude,
            recorded_at=timezone.now() - datetime.timedelta(hours=1),
        )
        old_trip.status = Trip.Status.COMPLETED
        old_trip.save(update_fields=["status"])

    # The same vehicle now runs a brand-new trip, with its own live state.
    new_trip = _in_progress_trip(client, business, route, vehicle)
    _live_state(
        client,
        business,
        new_trip,
        vehicle,
        latitude=stops[2].latitude,
        longitude=stops[2].longitude,
    )

    response = _passenger_client(passenger).get(reverse("trip-live-detail", args=[old_trip.id]))

    assert response.status_code == status.HTTP_200_OK
    assert Decimal(response.data["position"]["latitude"]) == stops[0].latitude
    assert response.data["trip"]["status"] == Trip.Status.COMPLETED


# --- Progress / ETA (service-level) ------------------------------------


def test_compute_progress_returns_none_for_uncoordinated_route() -> None:
    client = ClientFactory()
    business = _business(client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)  # no coordinates
        stop_b = StopFactory(
            client=client, business=business, latitude=Decimal("6.6"), longitude=Decimal("3.3")
        )
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle = VehicleFactory(client=client, business=business)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            status=Trip.Status.IN_PROGRESS,
        )

        progress = compute_progress(trip=trip, latitude=Decimal("6.55"), longitude=Decimal("3.3"))
        assert progress is None
        assert compute_eta(trip=trip, progress=progress) is None


def test_compute_progress_never_moves_backwards() -> None:
    client = ClientFactory()
    business = _business(client)
    route, stops = _coordinated_route(client, business)
    with tenant_context(str(client.id)):
        vehicle = VehicleFactory(client=client, business=business)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            status=Trip.Status.IN_PROGRESS,
        )

        forward = compute_progress(
            trip=trip, latitude=stops[2].latitude, longitude=stops[2].longitude
        )
        assert forward is not None
        assert forward["stops_completed"] == 3

        # A later, noisier reading lands nearest to an earlier stop —
        # progress must not regress.
        backward = compute_progress(
            trip=trip, latitude=stops[0].latitude, longitude=stops[0].longitude
        )
        assert backward is not None
        assert backward["stops_completed"] == 3


def test_compute_eta_none_without_estimated_duration() -> None:
    client = ClientFactory()
    business = _business(client)
    route, stops = _coordinated_route(client, business, estimated_duration_minutes=None)
    with tenant_context(str(client.id)):
        vehicle = VehicleFactory(client=client, business=business)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            status=Trip.Status.IN_PROGRESS,
        )
        progress = compute_progress(
            trip=trip, latitude=stops[0].latitude, longitude=stops[0].longitude
        )
        assert compute_eta(trip=trip, progress=progress) is None
