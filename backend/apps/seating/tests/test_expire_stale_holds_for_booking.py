"""apps.seating.services.expire_stale_holds_for_booking — the
single-booking, synchronous equivalent of apps.seating.tasks
.expire_seat_holds's periodic sweep, added so
apps.payments.services.initiate_payment/initiate_payment_with_wallet/
pay_booking_from_wallet can close the race window between a hold
lapsing and that once-a-minute sweep actually running —
docs/specs/22-marketplace.md slice 2. Mirrors
test_expire_seat_holds.py's own fixture and shape exactly, one booking
at a time instead of every stale hold platform-wide."""

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
from ..services import expire_stale_holds_for_booking
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


def test_expires_a_stale_hold_and_its_booking_and_reports_it_did() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client)
    reservation = _held_reservation(
        client, booking=booking, held_until=timezone.now() - datetime.timedelta(minutes=1)
    )

    with tenant_context(str(client.id)):
        did_expire = expire_stale_holds_for_booking(booking=booking)

    assert did_expire is True
    with tenant_context(str(client.id)):
        reservation.refresh_from_db()
        booking.refresh_from_db()
    assert reservation.status == SeatReservation.Status.EXPIRED
    assert booking.status == Booking.Status.EXPIRED


def test_leaves_a_future_hold_untouched_and_reports_no_expiry() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client)
    reservation = _held_reservation(
        client, booking=booking, held_until=timezone.now() + datetime.timedelta(minutes=10)
    )

    with tenant_context(str(client.id)):
        did_expire = expire_stale_holds_for_booking(booking=booking)

    assert did_expire is False
    with tenant_context(str(client.id)):
        reservation.refresh_from_db()
        booking.refresh_from_db()
    assert reservation.status == SeatReservation.Status.HELD
    assert booking.status == Booking.Status.PENDING_PAYMENT


def test_does_not_expire_a_booking_with_a_still_held_reservation() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client)
    stale = _held_reservation(
        client, booking=booking, held_until=timezone.now() - datetime.timedelta(minutes=1)
    )
    fresh = _held_reservation(
        client, booking=booking, held_until=timezone.now() + datetime.timedelta(minutes=10)
    )

    with tenant_context(str(client.id)):
        did_expire = expire_stale_holds_for_booking(booking=booking)

    assert did_expire is False
    with tenant_context(str(client.id)):
        stale.refresh_from_db()
        fresh.refresh_from_db()
        booking.refresh_from_db()
    assert stale.status == SeatReservation.Status.EXPIRED
    assert fresh.status == SeatReservation.Status.HELD
    assert booking.status == Booking.Status.PENDING_PAYMENT


def test_is_a_no_op_on_a_booking_that_is_not_pending_payment() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client, status=Booking.Status.CANCELLED)
    _held_reservation(
        client, booking=booking, held_until=timezone.now() - datetime.timedelta(minutes=1)
    )

    with tenant_context(str(client.id)):
        did_expire = expire_stale_holds_for_booking(booking=booking)

    assert did_expire is False


def test_is_a_no_op_on_an_open_seating_booking_with_no_reservations_at_all() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client)

    with tenant_context(str(client.id)):
        did_expire = expire_stale_holds_for_booking(booking=booking)

    assert did_expire is False
    with tenant_context(str(client.id)):
        booking.refresh_from_db()
    assert booking.status == Booking.Status.PENDING_PAYMENT
