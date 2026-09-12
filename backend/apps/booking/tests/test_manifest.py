"""`GET /trips/{id}/manifest/` — docs/specs/18-manifest-and-staff-booking.md
slice 1."""

from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory
from apps.seating.tests.factories import SeatFactory
from apps.tapngo.models import FareJourney
from apps.tapngo.tests.factories import TapCredentialFactory
from apps.ticketing.models import Ticket

from ..models import Booking
from ..services import create_booking, mark_booking_paid

pytestmark = pytest.mark.django_db


def _auth(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _manifest(user: User, trip_id: str, **params: object) -> object:
    return _auth(user).get(reverse("trip-manifest", args=[trip_id]), params)


def _reservation_trip(client: object, *, capacity: int = 4):  # type: ignore[no-untyped-def]
    """A prepaid, seat-assigned trip with a vehicle and a fare."""
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business, capacity=capacity)
        vehicle = VehicleFactory(client=client, business=route.business, vehicle_type=vehicle_type)
        # A near-future departure, not `TripFactory`'s fixed 2026-08-10:
        # `issue_ticket` anchors `Ticket.expires_at` to the departure,
        # and `ticket_expires_after_issued` refuses a ticket that
        # expired before it was issued. Same reason
        # `apps.payments.tests.booking_helpers` overrides it.
        departure = timezone.now() + timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=route.business,
            vehicle=vehicle,
            service_date=departure.date(),
            scheduled_departure_at=departure,
        )
        FareRuleFactory(client=client, route=route, business=route.business, amount="500.00")
    return trip, stop_a, stop_b, vehicle_type


def _book_and_pay(client, trip, stop_a, stop_b, seat, key):  # type: ignore[no-untyped-def]
    """A booking taken all the way to issued tickets.

    Through the real services rather than by writing rows: a manifest
    that agreed with a hand-built `Ticket` would prove nothing about the
    one the payment path actually issues.
    """
    with tenant_context(str(client.id)):
        passenger = PassengerUserFactory(client=client)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key=key,
        )
        mark_booking_paid(booking=booking)
    return booking


# --- the envelope ----------------------------------------------------------


def test_a_reservation_trip_lists_one_row_per_seat_with_its_reference() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
    booking = _book_and_pay(client, trip, stop_a, stop_b, seat, "m1")

    response = _manifest(staff, str(trip.id))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kind"] == "prepaid"
    assert len(response.data["results"]) == 1
    row = response.data["results"][0]
    assert row["seat_number"] == "1A"
    assert row["booking_reference"] == booking.reference
    assert row["booking_reference"].startswith("BKG-")
    assert row["ticket_status"] == Ticket.Status.ISSUED
    # A **string**, not a Decimal or a float. The rows go through
    # `ManifestPrepaidRowSerializer` precisely so this matches what the
    # generated `schema.ts` promises — a plain dict would have rendered
    # a float and the frontend's `formatMoney` would have been handed
    # something it does not accept.
    assert row["fare"] == str(booking.total_amount)
    assert isinstance(row["fare"], str)


def test_the_manifest_never_carries_passenger_contact_details() -> None:
    """The most identifying screen in the console. An operator matching a
    face to a seat needs a name, not a phone number."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
    booking = _book_and_pay(client, trip, stop_a, stop_b, seat, "m-pii")

    row = _manifest(staff, str(trip.id)).data["results"][0]

    # Asserted by key absence, not by a shape guess — the same posture
    # `/incidents/mine/`'s visibility test takes.
    assert "passenger_email" not in row
    assert "passenger_phone" not in row
    assert booking.passenger.email not in str(row)


def test_a_multi_seat_booking_is_one_row_per_ticket_not_per_booking() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat_a = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_b = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        passenger = PassengerUserFactory(client=client)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[
                {"seat": seat_a, "from_stop": stop_a, "to_stop": stop_b},
                {"seat": seat_b, "from_stop": stop_a, "to_stop": stop_b},
            ],
            idempotency_key="m-multi",
        )
        mark_booking_paid(booking=booking)

    results = _manifest(staff, str(trip.id)).data["results"]

    # Two people are aboard, in two seats. One line per booking would
    # make "who is on this bus" unanswerable.
    assert [row["seat_number"] for row in results] == ["1A", "1B"]
    assert {row["booking_reference"] for row in results} == {booking.reference}


def test_rows_are_ordered_by_seat_rather_than_by_the_models_own_meta() -> None:
    """`Ticket.Meta.ordering` and `Seat.Meta.ordering` are both
    `-created_at`, which scatters a group around the vehicle — the trap
    docs/specs/10-booking-modes.md records for seat allocation."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        # Created in reverse seat order on purpose.
        for index, number in enumerate(["3C", "2B", "1A"]):
            seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number=number)
            _book_and_pay(client, trip, stop_a, stop_b, seat, f"m-order-{index}")

    results = _manifest(staff, str(trip.id)).data["results"]

    assert [row["seat_number"] for row in results] == ["1A", "2B", "3C"]


def test_a_trip_with_no_bookings_is_empty_but_still_says_what_kind_it_is() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, _a, _b, _vt = _reservation_trip(client)

    response = _manifest(staff, str(trip.id))

    # Distinguishable from a pay-as-you-go trip by `kind`, which is the
    # whole reason the envelope carries one.
    assert response.data["kind"] == "prepaid"
    assert response.data["results"] == []
    assert response.data["totals"]["passengers"] == 0


def test_capacity_is_null_when_no_vehicle_is_assigned_not_zero() -> None:
    """Unknowable, not empty. Zero would tell an operator the bus is
    full."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        trip = TripFactory(client=client, route=route, business=route.business, vehicle=None)

    totals = _manifest(staff, str(trip.id)).data["totals"]

    assert totals["capacity"] is None


def test_boarded_counts_only_boarded_tickets() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat_a = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_b = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
    _book_and_pay(client, trip, stop_a, stop_b, seat_a, "m-b1")
    _book_and_pay(client, trip, stop_a, stop_b, seat_b, "m-b2")
    with tenant_context(str(client.id)):
        boarded = Ticket.objects.filter(trip=trip).first()
        assert boarded is not None
        boarded.status = Ticket.Status.BOARDED
        boarded.boarded_at = timezone.now()
        boarded.save(update_fields=["status", "boarded_at"])

    totals = _manifest(staff, str(trip.id)).data["totals"]

    assert totals["passengers"] == 2
    assert totals["boarded"] == 1


# --- cancelled and unpaid --------------------------------------------------


def test_a_cancelled_booking_is_excluded_by_default_and_flagged_when_asked_for() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
    booking = _book_and_pay(client, trip, stop_a, stop_b, seat, "m-cancel")
    with tenant_context(str(client.id)):
        Booking.objects.filter(pk=booking.pk).update(status=Booking.Status.CANCELLED)

    assert _manifest(staff, str(trip.id)).data["results"] == []

    included = _manifest(staff, str(trip.id), include_cancelled="true").data
    assert len(included["results"]) == 1
    assert included["results"][0]["is_cancelled"] is True


def test_a_pending_payment_booking_is_always_on_the_manifest() -> None:
    """An operator needs to know a held seat is unpaid. Hiding it is how
    a seat gets sold twice in practice."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        passenger = PassengerUserFactory(client=client)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="m-unpaid",
        )
        mark_booking_paid(booking=booking)
        # Back to unpaid, keeping the ticket the payment issued — the
        # shape an expiring hold leaves behind.
        Booking.objects.filter(pk=booking.pk).update(status=Booking.Status.PENDING_PAYMENT)

    results = _manifest(staff, str(trip.id)).data["results"]

    assert len(results) == 1
    assert results[0]["booking_status"] == Booking.Status.PENDING_PAYMENT
    assert results[0]["is_cancelled"] is False


def test_a_booking_that_was_never_paid_for_is_on_the_manifest() -> None:
    """The case above manufactures a ticket and then forces the booking
    back to unpaid, so it only ever proved that a *ticketed* row is not
    filtered out by status. A booking that was never paid for has **no
    ticket at all** — a ticket is issued at payment — and a
    `Ticket`-only manifest could not show one.

    That is the real reading of the rule, and slice 2 is what made it
    urgent: with no cash account in the ledger (ADR-0006), a counter
    booking the passenger has not yet paid for is the *ordinary* outcome
    of selling at a desk. An agent who sold a seat and could not then
    see it on the manifest is exactly the "seat gets sold twice"
    failure.
    """
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        passenger = PassengerUserFactory(client=client)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="m-never-paid",
        )
        assert not Ticket.objects.filter(booking=booking).exists()

    body = _manifest(staff, str(trip.id)).data

    assert len(body["results"]) == 1
    row = body["results"][0]
    assert row["booking_reference"] == booking.reference
    assert row["seat_number"] == "1A"
    assert row["booking_status"] == Booking.Status.PENDING_PAYMENT
    # No ticket exists, so both ticket fields are null rather than an
    # invented status no `Ticket` row could ever hold.
    assert row["ticket_id"] is None
    assert row["ticket_status"] is None
    # The fare is the reservation's purchase-time snapshot, present even
    # though nothing has been charged yet.
    assert row["fare"] == str(booking.total_amount)
    # And the header agrees with the rows beneath it.
    assert body["totals"]["passengers"] == 1
    assert body["totals"]["boarded"] == 0


def test_an_unpaid_open_seating_booking_is_one_row_per_place() -> None:
    """No reservations to count, so the row count comes from
    `passenger_count` — the same "never one line for four people" rule
    the ticketed path follows."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, _vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        trip.booking_mode = Business.BookingMode.OPEN_SEATING
        trip.save(update_fields=["booking_mode"])
        passenger = PassengerUserFactory(client=client)
        create_booking(
            trip=trip,
            passenger=passenger,
            passenger_count=3,
            from_stop=stop_a,
            to_stop=stop_b,
            idempotency_key="m-unpaid-open",
        )

    body = _manifest(staff, str(trip.id)).data

    assert len(body["results"]) == 3
    assert body["totals"]["passengers"] == 3
    assert all(row["seat_number"] is None for row in body["results"])


def test_a_cancelled_unpaid_booking_is_hidden_like_any_other() -> None:
    """The new rows go through the same status filter as the ticketed
    ones — otherwise widening the manifest would have quietly widened
    what a cancelled booking can do."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        passenger = PassengerUserFactory(client=client)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="m-unpaid-cancelled",
        )
        Booking.objects.filter(pk=booking.pk).update(status=Booking.Status.CANCELLED)

    assert _manifest(staff, str(trip.id)).data["results"] == []

    included = _manifest(staff, str(trip.id), include_cancelled="true").data
    assert len(included["results"]) == 1
    assert included["results"][0]["is_cancelled"] is True


# --- pay as you go ---------------------------------------------------------


def _payg_trip_with_a_journey(client, *, alighted: bool):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        departure = timezone.now() + timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=departure.date(),
            scheduled_departure_at=departure,
            fare_collection_mode=Business.FareCollectionMode.PAY_AS_YOU_GO,
        )
        passenger = PassengerUserFactory(client=client)
        credential = TapCredentialFactory(client=client, passenger=passenger)
        journey = FareJourney.objects.create(
            client=client,
            business=route.business,
            trip=trip,
            passenger=passenger,
            credential=credential,
            board_stop=stop_a,
            alight_stop=stop_b if alighted else None,
            status=FareJourney.Status.CLOSED if alighted else FareJourney.Status.OPEN,
            amount="300.00" if alighted else None,
            currency=route.business.currency if alighted else "",
            boarded_at=timezone.now() - timedelta(minutes=20),
            alighted_at=timezone.now() if alighted else None,
        )
    return trip, journey, stop_a, stop_b


def test_a_pay_as_you_go_trip_lists_journeys_not_an_empty_booking_list() -> None:
    """The defect `kind` exists to prevent: such a trip sells no bookings
    and issues no tickets, so `results: []` would say the bus is empty
    when it is full."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, _journey, _a, stop_b = _payg_trip_with_a_journey(client, alighted=True)

    response = _manifest(staff, str(trip.id))

    assert response.data["kind"] == "pay_as_you_go"
    assert len(response.data["results"]) == 1
    row = response.data["results"][0]
    assert row["alight_stop"] == stop_b.name
    assert row["fare"] == "300.00"


def test_an_open_journey_reports_no_alight_stop_and_no_fare() -> None:
    """Someone still aboard. Both are genuinely unknown until they tap
    off, and `journey_status` is what says so."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, _journey, _a, _b = _payg_trip_with_a_journey(client, alighted=False)

    row = _manifest(staff, str(trip.id)).data["results"][0]

    assert row["alight_stop"] is None
    assert row["fare"] is None
    assert row["journey_status"] == FareJourney.Status.OPEN


def test_a_pay_as_you_go_trip_counts_every_tap_as_aboard() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, _journey, _a, _b = _payg_trip_with_a_journey(client, alighted=False)

    totals = _manifest(staff, str(trip.id)).data["totals"]

    # A tap *is* the boarding here, so the two agreeing is correct.
    assert totals["passengers"] == 1
    assert totals["boarded"] == 1


# --- cost ------------------------------------------------------------------


def test_manifest_query_count_does_not_scale_with_the_number_aboard() -> None:
    """The N+1 the spec's Failure Modes section names: a full bus fanning
    out to bookings, reservations, seats and users, one query per row.

    Asserted as a **property** — one row costs the same as eight — rather
    than against a magic budget. A fixed number would have to be edited
    every time an unrelated middleware query moved, which is how such a
    test stops being read and starts being bumped.
    """
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client, capacity=8)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="0A")
        _book_and_pay(client, trip, stop_a, stop_b, seat, "m-n1-0")

    with CaptureQueriesContext(connection) as one_row:
        assert len(_manifest(staff, str(trip.id)).data["results"]) == 1

    with tenant_context(str(client.id)):
        for index in range(1, 8):
            extra = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number=f"{index}A")
            _book_and_pay(client, trip, stop_a, stop_b, extra, f"m-n1-{index}")

    with CaptureQueriesContext(connection) as eight_rows:
        assert len(_manifest(staff, str(trip.id)).data["results"]) == 8

    assert len(eight_rows.captured_queries) == len(one_row.captured_queries)


def test_manifest_query_count_does_not_scale_with_unticketed_held_bookings() -> None:
    """The counter-booking path (docs/specs/18-manifest-and-staff-booking.md
    slice 2): a held-but-unpaid booking has no `Ticket` row at all, so it
    is read through a different queryset (`unticketed_booking_queryset`)
    than the one the test above already covers. Same property, same
    reasoning: one row must cost the same as eight.
    """
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _reservation_trip(client, capacity=8)

    def _hold_one_seat(index: int) -> None:
        with tenant_context(str(client.id)):
            seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number=f"{index}A")
            passenger = PassengerUserFactory(client=client)
            create_booking(
                trip=trip,
                passenger=passenger,
                seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
                idempotency_key=f"m-unticketed-n1-{index}",
            )

    _hold_one_seat(0)

    with CaptureQueriesContext(connection) as one_row:
        assert len(_manifest(staff, str(trip.id)).data["results"]) == 1

    for index in range(1, 8):
        _hold_one_seat(index)

    with CaptureQueriesContext(connection) as eight_rows:
        assert len(_manifest(staff, str(trip.id)).data["results"]) == 8

    assert len(eight_rows.captured_queries) == len(one_row.captured_queries)


def test_manifest_query_count_does_not_scale_with_the_number_of_taps() -> None:
    """The pay-as-you-go path is read through a third queryset
    (`journey_queryset`), untested by the two counts above. Same
    property again: the manifest must not fan out per `FareJourney` the
    way it doesn't fan out per `Ticket` or per unticketed `Booking`.
    """
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        departure = timezone.now() + timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=departure.date(),
            scheduled_departure_at=departure,
            fare_collection_mode=Business.FareCollectionMode.PAY_AS_YOU_GO,
        )

    def _tap_one_passenger(index: int) -> None:
        with tenant_context(str(client.id)):
            passenger = PassengerUserFactory(client=client)
            credential = TapCredentialFactory(client=client, passenger=passenger)
            FareJourney.objects.create(
                client=client,
                business=route.business,
                trip=trip,
                passenger=passenger,
                credential=credential,
                board_stop=stop_a,
                alight_stop=stop_b,
                status=FareJourney.Status.CLOSED,
                amount="300.00",
                currency=route.business.currency,
                boarded_at=timezone.now() - timedelta(minutes=20),
                alighted_at=timezone.now(),
            )

    _tap_one_passenger(0)

    with CaptureQueriesContext(connection) as one_row:
        assert len(_manifest(staff, str(trip.id)).data["results"]) == 1

    for index in range(1, 8):
        _tap_one_passenger(index)

    with CaptureQueriesContext(connection) as eight_rows:
        assert len(_manifest(staff, str(trip.id)).data["results"]) == 8

    assert len(eight_rows.captured_queries) == len(one_row.captured_queries)


# --- access ----------------------------------------------------------------


def test_the_manifest_requires_booking_view() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    trip, _a, _b, _vt = _reservation_trip(client)

    assert _manifest(passenger, str(trip.id)).status_code == status.HTTP_403_FORBIDDEN


def test_staff_can_read_a_manifest_without_analytics_view() -> None:
    """The person who most needs this is the one standing at the door.
    The Staff preset holds `booking.view` and deliberately not
    `analytics.view`."""
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])
    trip, _a, _b, _vt = _reservation_trip(client)

    assert _manifest(staff, str(trip.id)).status_code == status.HTTP_200_OK


def test_another_clients_trip_manifest_is_a_404_not_a_403() -> None:
    """A 403 would confirm the trip exists."""
    neighbour = ClientFactory()
    neighbour_trip, _a, _b, _vt = _reservation_trip(neighbour)

    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])

    assert _manifest(staff, str(neighbour_trip.id)).status_code == status.HTTP_404_NOT_FOUND


def test_an_unauthenticated_request_is_rejected() -> None:
    client = ClientFactory()
    trip, _a, _b, _vt = _reservation_trip(client)

    response = APIClient().get(reverse("trip-manifest", args=[str(trip.id)]))

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
