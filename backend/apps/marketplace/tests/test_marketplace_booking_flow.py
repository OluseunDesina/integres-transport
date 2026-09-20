"""The marketplace's whole reason for existing, end to end: a passenger
registered under the Marketplace Client searches, finds, and books a
Trip belonging to a completely different, unrelated Client — docs/adr/0009,
docs/specs/22-marketplace.md."""

import uuid

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.models import Booking, Traveler
from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.services import get_or_create_marketplace_client
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import User
from apps.identity.serializers import CustomerTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory
from apps.seating.tests.factories import SeatFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = CustomerTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _marketplace_passenger() -> User:
    marketplace_client = get_or_create_marketplace_client()
    return PassengerUserFactory(client=marketplace_client)


def _operator_trip_with_seat(
    operator_client: object, *, fare: str = "750.00", **trip_overrides: object
):  # type: ignore[no-untyped-def]
    """A fully bookable Trip under its own, unrelated operator Client —
    the marketplace passenger belongs to none of this."""
    with tenant_context(str(operator_client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=operator_client)
        stop_a = StopFactory(client=operator_client, business=route.business, name="Yaba")
        stop_b = StopFactory(client=operator_client, business=route.business, name="Ikeja")
        RouteStopFactory(client=operator_client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=operator_client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(
            client=operator_client, business=route.business, capacity=2
        )
        vehicle = VehicleFactory(
            client=operator_client, business=route.business, vehicle_type=vehicle_type
        )
        FareRuleFactory(client=operator_client, route=route, business=route.business, amount=fare)
        trip = TripFactory(
            client=operator_client,
            route=route,
            business=route.business,
            vehicle=vehicle,
            **trip_overrides,
        )
        seat = SeatFactory(client=operator_client, vehicle_type=vehicle_type, seat_number="1A")
    return trip, stop_a, stop_b, seat


def test_full_cross_client_search_to_booking_loop() -> None:
    operator_client = ClientFactory()
    trip, stop_a, stop_b, seat = _operator_trip_with_seat(operator_client)
    passenger = _marketplace_passenger()
    api = _auth_client(passenger)

    search = api.get(
        reverse("marketplace-trip-search"),
        {"origin": "Yaba", "destination": "Ikeja", "service_date": str(trip.service_date)},
    )
    assert search.status_code == status.HTTP_200_OK
    assert len(search.data["results"]) == 1
    result = search.data["results"][0]
    assert result["trip"]["id"] == str(trip.id)
    assert result["fare"]["amount"] == "750.00"
    # The one piece of context a flat, non-grouped result list cannot do
    # without on a marketplace search — which operator this result
    # belongs to.
    assert result["business_name"] == trip.business.name
    assert result["stops_between"] == 0
    # docs/specs/22-marketplace.md slice 2: vehicle type is another
    # dimension a passenger comparing operators needs. Confirms
    # `search_trips_across_clients`'s own `select_related` covers
    # `vehicle__vehicle_type` — a separate queryset from the
    # same-Client `TripSearchView`'s, so this is not implied by that
    # view's own equivalent test.
    assert result["trip"]["vehicle"]["vehicle_type"]["name"] == trip.vehicle.vehicle_type.name
    # No duration set on this fixture's Route — "if available", not
    # assumed to always exist.
    assert result["duration_minutes"] is None
    assert result["scheduled_arrival_at"] is None
    # docs/specs/22-marketplace.md slice 3: "N seats left" on the results
    # page — the fixture's one Seat, still free.
    assert result["capacity_remaining"] == 1

    availability = api.get(
        reverse("marketplace-trip-availability", args=[trip.id]),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )
    assert availability.status_code == status.HTTP_200_OK
    assert availability.data["status"] == "open"

    fare = api.get(
        reverse("marketplace-trip-fare", args=[trip.id]),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )
    assert fare.status_code == status.HTTP_200_OK
    assert fare.data["amount"] == "750.00"

    booking_response = api.post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "passenger_count": 1,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            # docs/specs/22-marketplace.md slice 3: `travelers`, not a
            # per-seat pick — the marketplace endpoint auto-allocates a
            # seat per entry (this fixture's own only free one, "1A")
            # rather than taking an explicit `seats` choice.
            "travelers": [
                {
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                    "phone": "+2348000000000",
                    "email": "ada@example.com",
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-booking-1",
    )
    assert booking_response.status_code == status.HTTP_201_CREATED
    assert booking_response.data["total_amount"] == "750.00"
    assert booking_response.data["seats"][0]["seat"] == "1A"
    assert booking_response.data["seats"][0]["traveler"]["first_name"] == "Ada"

    with tenant_context(str(operator_client.id)):
        booking = Booking.objects.get(id=booking_response.data["id"])
        # The load-bearing assertion: the booking belongs to the
        # *operator's* Client, exactly like any booking made directly
        # against them — not the passenger's own (Marketplace) Client.
        assert booking.client_id == operator_client.id
        assert booking.business_id == trip.business_id
        assert booking.passenger_id == passenger.id

    mine = api.get(reverse("booking-mine"))
    assert mine.status_code == status.HTTP_200_OK
    assert [row["id"] for row in mine.data["results"]] == [booking_response.data["id"]]
    assert mine.data["results"][0]["seats"][0]["seat"] == "1A"
    assert mine.data["results"][0]["seats"][0]["traveler"]["first_name"] == "Ada"
    # The same operator-name gap the search results already fixed,
    # applied here: a marketplace passenger's own booking list can span
    # several different operators, so a bare business id names none of
    # them (found live, driving this exact flow through a real browser).
    assert mine.data["results"][0]["business_name"] == trip.business.name

    other_marketplace_passenger = _marketplace_passenger()
    unrelated = _auth_client(other_marketplace_passenger).get(reverse("booking-mine"))
    assert unrelated.status_code == status.HTTP_200_OK
    assert unrelated.data["results"] == []

    # A marketplace passenger can cancel their own cross-Client booking
    # too — BookingCancelView is one of the widened "my own records"
    # views (docs/adr/0009), same as booking-mine above.
    unrelated_cancel = _auth_client(other_marketplace_passenger).post(
        reverse("booking-cancel", kwargs={"pk": booking_response.data["id"]})
    )
    assert unrelated_cancel.status_code == status.HTTP_403_FORBIDDEN

    cancel = api.post(reverse("booking-cancel", kwargs={"pk": booking_response.data["id"]}))
    assert cancel.status_code == status.HTTP_200_OK
    assert cancel.data["status"] == "cancelled"


# --- Traveler details (docs/specs/22-marketplace.md slices 2-3) ------------
# Required here, unlike apps.booking's own endpoint (test_booking.py's
# existing passing suite already proves that one still works with no
# traveler at all — MarketplaceBookingCreateSerializer is the only
# thing that adds the requirement). Slice 3 dropped the per-seat `seats`
# shape entirely in favour of `passenger_count` + `travelers`, with the
# seat itself auto-allocated — see that serializer's own docstring.


def test_booking_create_400s_without_traveler_details_for_a_seat_choice_trip() -> None:
    operator_client = ClientFactory()
    trip, stop_a, stop_b, _seat = _operator_trip_with_seat(operator_client)
    passenger = _marketplace_passenger()

    response = _auth_client(passenger).post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "passenger_count": 1,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-no-traveler",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "travelers" in response.data


def test_booking_create_400s_when_an_explicit_seat_is_sent() -> None:
    """docs/specs/22-marketplace.md slice 3: the marketplace endpoint no
    longer accepts a passenger-chosen seat at all — auto-allocation plus
    the "Change seat" follow-up replaced it."""
    operator_client = ClientFactory()
    trip, stop_a, stop_b, seat = _operator_trip_with_seat(operator_client)
    passenger = _marketplace_passenger()

    response = _auth_client(passenger).post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {
                    "seat": str(seat.id),
                    "from_stop": str(stop_a.id),
                    "to_stop": str(stop_b.id),
                    "traveler": {
                        "first_name": "Ada",
                        "last_name": "Lovelace",
                        "phone": "+2348000000000",
                        "email": "ada@example.com",
                    },
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-explicit-seat",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "seats" in response.data


def test_booking_persists_a_traveler_tied_to_its_auto_allocated_seat() -> None:
    operator_client = ClientFactory()
    trip, stop_a, stop_b, _seat = _operator_trip_with_seat(operator_client)
    passenger = _marketplace_passenger()

    response = _auth_client(passenger).post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "passenger_count": 1,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            "travelers": [
                {
                    "title": "ms",
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                    "phone": "+2348000000000",
                    "email": "ada@example.com",
                    "date_of_birth": "1990-01-01",
                    "gender": "female",
                    "nationality": "Nigerian",
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-with-traveler",
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["seats"][0]["seat"] == "1A"
    with tenant_context(str(operator_client.id)):
        traveler = Traveler.objects.get(booking_id=response.data["id"])
        assert traveler.first_name == "Ada"
        assert traveler.last_name == "Lovelace"
        assert traveler.nationality == "Nigerian"
        assert traveler.seat_reservation_id is not None


def test_open_seating_booking_requires_and_persists_one_traveler_per_passenger() -> None:
    operator_client = ClientFactory()
    with tenant_context(str(operator_client.id)):
        business = BusinessFactory(
            client=operator_client,
            booking_mode_default=Business.BookingMode.OPEN_SEATING,
            kyb_status=Business.KybStatus.APPROVED,
        )
        route = RouteFactory(client=operator_client, business=business)
        stop_a = StopFactory(client=operator_client, business=business, name="Yaba")
        stop_b = StopFactory(client=operator_client, business=business, name="Ikeja")
        RouteStopFactory(client=operator_client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=operator_client, route=route, stop=stop_b, sequence=2)
        FareRuleFactory(client=operator_client, route=route, business=business, amount="500.00")
        vehicle_type = VehicleTypeFactory(client=operator_client, business=business, capacity=20)
        vehicle = VehicleFactory(
            client=operator_client, business=business, vehicle_type=vehicle_type
        )
        trip = TripFactory(
            client=operator_client,
            route=route,
            business=business,
            vehicle=vehicle,
            booking_mode=Business.BookingMode.OPEN_SEATING,
        )
    passenger = _marketplace_passenger()
    api = _auth_client(passenger)

    without_traveler = api.post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "passenger_count": 2,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-places-no-traveler",
    )
    assert without_traveler.status_code == status.HTTP_400_BAD_REQUEST

    with_travelers = api.post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "passenger_count": 2,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            # docs/specs/22-marketplace.md slice 3: open seating gets one
            # named traveler per passenger too, not a single lead — none
            # of them own a seat (there is none to hold), but each is
            # still a real name on the party.
            "travelers": [
                {
                    "first_name": "Grace",
                    "last_name": "Hopper",
                    "phone": "+2348111111111",
                    "email": "grace@example.com",
                },
                {
                    "first_name": "Katherine",
                    "last_name": "Johnson",
                    "phone": "+2348222222222",
                    "email": "katherine@example.com",
                },
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-places-with-travelers",
    )
    assert with_travelers.status_code == status.HTTP_201_CREATED
    with tenant_context(str(operator_client.id)):
        travelers = list(
            Traveler.objects.filter(booking_id=with_travelers.data["id"]).order_by("first_name")
        )
        assert [traveler.first_name for traveler in travelers] == ["Grace", "Katherine"]
        assert all(traveler.seat_reservation_id is None for traveler in travelers)
    assert {row["first_name"] for row in with_travelers.data["travelers"]} == {
        "Grace",
        "Katherine",
    }


def test_search_excludes_a_trip_whose_business_kyb_is_not_approved() -> None:
    operator_client = ClientFactory()
    with tenant_context(str(operator_client.id)):
        business = BusinessFactory(client=operator_client, kyb_status=Business.KybStatus.SUBMITTED)
        route = RouteFactory(client=operator_client, business=business)
        stop_a = StopFactory(client=operator_client, business=business, name="Yaba")
        stop_b = StopFactory(client=operator_client, business=business, name="Ikeja")
        RouteStopFactory(client=operator_client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=operator_client, route=route, stop=stop_b, sequence=2)
        trip = TripFactory(client=operator_client, route=route, business=business)
    passenger = _marketplace_passenger()

    response = _auth_client(passenger).get(
        reverse("marketplace-trip-search"),
        {"origin": "Yaba", "destination": "Ikeja", "service_date": str(trip.service_date)},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


def test_booking_create_404s_for_a_non_scheduled_trip() -> None:
    operator_client = ClientFactory()
    trip, stop_a, stop_b, seat = _operator_trip_with_seat(operator_client)
    with tenant_context(str(operator_client.id)):
        trip.status = Trip.Status.CANCELLED
        trip.save(update_fields=["status"])
    passenger = _marketplace_passenger()

    response = _auth_client(passenger).post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-booking-cancelled",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_stop_suggest_spans_every_client() -> None:
    operator_client = ClientFactory()
    with tenant_context(str(operator_client.id)):
        route = RouteFactory(client=operator_client)
        StopFactory(client=operator_client, business=route.business, name="Yaba")
    passenger = _marketplace_passenger()

    response = _auth_client(passenger).get(reverse("marketplace-stop-suggest"), {"q": "yaba"})

    assert response.status_code == status.HTTP_200_OK
    assert any(row["name"] == "Yaba" for row in response.data)


def test_marketplace_read_endpoints_allow_an_unauthenticated_request() -> None:
    """docs/specs/22-marketplace.md slice 2: a guest can search, resolve
    availability, and get a fare quote with no session at all — browsing
    is public, matching the Wakanow/TravelBeta/Trip.com reference this
    app is modelled on. Only booking/payment (below) require one."""
    operator_client = ClientFactory()
    trip, stop_a, stop_b, _seat = _operator_trip_with_seat(operator_client)
    anon = APIClient()

    search = anon.get(
        reverse("marketplace-trip-search"),
        {"origin": "Yaba", "destination": "Ikeja", "service_date": str(trip.service_date)},
    )
    assert search.status_code == status.HTTP_200_OK
    assert len(search.data["results"]) == 1

    availability = anon.get(
        reverse("marketplace-trip-availability", args=[trip.id]),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )
    assert availability.status_code == status.HTTP_200_OK

    fare = anon.get(
        reverse("marketplace-trip-fare", args=[trip.id]),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )
    assert fare.status_code == status.HTTP_200_OK

    suggest = anon.get(reverse("marketplace-stop-suggest"), {"q": "yaba"})
    assert suggest.status_code == status.HTTP_200_OK


# --- Change seat (docs/specs/22-marketplace.md slice 3) --------------------


def test_marketplace_passenger_can_change_their_own_seat() -> None:
    operator_client = ClientFactory()
    trip, stop_a, stop_b, seat = _operator_trip_with_seat(operator_client)
    with tenant_context(str(operator_client.id)):
        second_seat = SeatFactory(
            client=operator_client, vehicle_type=trip.vehicle.vehicle_type, seat_number="1B"
        )
    passenger = _marketplace_passenger()
    api = _auth_client(passenger)

    booking_response = api.post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "passenger_count": 1,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            "travelers": [
                {
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                    "phone": "+2348000000000",
                    "email": "ada@example.com",
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-change-seat-create",
    )
    assert booking_response.status_code == status.HTTP_201_CREATED
    booking_id = booking_response.data["id"]
    reservation_id = booking_response.data["seats"][0]["id"]

    response = api.post(
        reverse(
            "marketplace-booking-change-seat",
            kwargs={"pk": booking_id, "reservation_pk": reservation_id},
        ),
        {"seat": str(second_seat.id)},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["seats"][0]["seat"] == "1B"
    # The traveler followed the seat, not left orphaned on the old one.
    assert response.data["seats"][0]["traveler"]["first_name"] == "Ada"


def test_marketplace_passenger_cannot_change_another_passengers_seat() -> None:
    operator_client = ClientFactory()
    trip, stop_a, stop_b, seat = _operator_trip_with_seat(operator_client)
    with tenant_context(str(operator_client.id)):
        second_seat = SeatFactory(
            client=operator_client, vehicle_type=trip.vehicle.vehicle_type, seat_number="1B"
        )
    passenger = _marketplace_passenger()
    other_passenger = _marketplace_passenger()

    booking_response = _auth_client(passenger).post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "passenger_count": 1,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            "travelers": [
                {
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                    "phone": "+2348000000000",
                    "email": "ada@example.com",
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-change-seat-other",
    )
    booking_id = booking_response.data["id"]
    reservation_id = booking_response.data["seats"][0]["id"]

    response = _auth_client(other_passenger).post(
        reverse(
            "marketplace-booking-change-seat",
            kwargs={"pk": booking_id, "reservation_pk": reservation_id},
        ),
        {"seat": str(second_seat.id)},
        format="json",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_marketplace_booking_and_payment_endpoints_reject_an_unauthenticated_request() -> None:
    """The one point a guest is actually required to have a session —
    both need `request.user` as the booking's passenger."""
    operator_client = ClientFactory()
    trip, stop_a, stop_b, seat = _operator_trip_with_seat(operator_client)
    anon = APIClient()

    booking_response = anon.post(
        reverse("marketplace-booking-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-anon-booking",
    )
    assert booking_response.status_code == status.HTTP_401_UNAUTHORIZED

    payment_response = anon.post(
        reverse("marketplace-payment-create"),
        {"booking_id": str(uuid.uuid4())},
        format="json",
        HTTP_IDEMPOTENCY_KEY="marketplace-anon-payment",
    )
    assert payment_response.status_code == status.HTTP_401_UNAUTHORIZED
