import datetime

import pytest
from django.utils import timezone
from psycopg.types.range import Range

from apps.booking.models import Booking
from apps.booking.tests.factories import BookingFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleTypeFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory

from ..models import SeatReservation
from ..tasks import expire_seat_holds
from .factories import SeatFactory
from .helpers import fare_pricing_for

pytestmark = pytest.mark.django_db


def _held_reservation(client: object, *, booking: Booking, held_until: datetime.datetime):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client, business=booking.business)
        stop_a = StopFactory(client=client, business=booking.business)
        stop_b = StopFactory(client=client, business=booking.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=booking.business, capacity=1)
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        pricing = fare_pricing_for(client=client, route=route, business=booking.business)
        return SeatReservation.objects.create(
            client=client,
            trip=booking.trip,
            seat=seat,
            booking=booking,
            from_stop=stop_a,
            to_stop=stop_b,
            segment_range=Range(1, 2),
            status=SeatReservation.Status.HELD,
            held_until=held_until,
            amount=pricing["amount"],
            fare_rule=pricing["fare_rule"],
        )


def test_expire_seat_holds_expires_a_stale_hold_and_its_booking() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client)
    reservation = _held_reservation(
        client, booking=booking, held_until=timezone.now() - datetime.timedelta(minutes=1)
    )

    expire_seat_holds()

    with tenant_context(str(client.id)):
        reservation.refresh_from_db()
        booking.refresh_from_db()
    assert reservation.status == SeatReservation.Status.EXPIRED
    assert booking.status == Booking.Status.EXPIRED


def test_expire_seat_holds_leaves_a_future_hold_untouched() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client)
    reservation = _held_reservation(
        client, booking=booking, held_until=timezone.now() + datetime.timedelta(minutes=10)
    )

    expire_seat_holds()

    with tenant_context(str(client.id)):
        reservation.refresh_from_db()
        booking.refresh_from_db()
    assert reservation.status == SeatReservation.Status.HELD
    assert booking.status == Booking.Status.PENDING_PAYMENT


def test_expire_seat_holds_does_not_expire_a_booking_with_a_still_held_reservation() -> None:
    """A Booking covering two seats where only one hold has gone stale —
    the Booking itself must stay pending_payment until *every* seat is
    resolved, matching docs/specs/4-fares-seating-booking.md §2's "a
    Booking's SeatReservations always share one held_until" note (this
    scenario is the deliberately-uncommon exception: created at
    different times in this test, not by the real booking-creation flow
    which sets them all identically — worth covering anyway)."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client)
    stale = _held_reservation(
        client, booking=booking, held_until=timezone.now() - datetime.timedelta(minutes=1)
    )
    fresh = _held_reservation(
        client, booking=booking, held_until=timezone.now() + datetime.timedelta(minutes=10)
    )

    expire_seat_holds()

    with tenant_context(str(client.id)):
        stale.refresh_from_db()
        fresh.refresh_from_db()
        booking.refresh_from_db()
    assert stale.status == SeatReservation.Status.EXPIRED
    assert fresh.status == SeatReservation.Status.HELD
    assert booking.status == Booking.Status.PENDING_PAYMENT
