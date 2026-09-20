"""`mark_booking_completed_if_fully_boarded` — see this app's own
services.py docstring and docs/specs/6-ticketing.md's Implementation
note. Exercises the service function directly, not through the
validator HTTP endpoint (that's apps/ticketing/tests/
test_ticket_validation.py's job) — this file only cares about the
Booking-side transition logic.
"""

import pytest

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.payments.tests.booking_helpers import booking_with_a_held_seat
from apps.seating.services import create_reservation
from apps.seating.tests.factories import SeatFactory
from apps.ticketing.models import Ticket

from ..models import Booking
from ..services import mark_booking_completed_if_fully_boarded, mark_booking_paid

pytestmark = pytest.mark.django_db


def test_completes_a_single_seat_booking_once_its_one_ticket_boards() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation = booking_with_a_held_seat(client, business)
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        ticket = Ticket.all_objects.get(seat_reservation=reservation)
        ticket.status = Ticket.Status.BOARDED
        ticket.save(update_fields=["status"])

    completed, did_transition = mark_booking_completed_if_fully_boarded(booking=booking)

    assert did_transition is True
    assert completed.status == Booking.Status.COMPLETED
    assert AuditLog.objects.filter(action="booking.completed", target_id=str(booking.id)).exists()


def test_stays_paid_until_every_seat_on_a_multi_seat_booking_has_boarded() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, first_reservation = booking_with_a_held_seat(client, business)
    with tenant_context(str(client.id)):
        second_seat = SeatFactory(client=client, vehicle_type=first_reservation.seat.vehicle_type)
        second_reservation = create_reservation(
            trip=booking.trip,
            seat=second_seat,
            from_stop=first_reservation.from_stop,
            to_stop=first_reservation.to_stop,
            booking=booking,
            hold_minutes=business.seat_hold_minutes,
            amount=first_reservation.amount,
            fare_rule=first_reservation.fare_rule,
        )
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        first_ticket = Ticket.all_objects.get(seat_reservation=first_reservation)
        first_ticket.status = Ticket.Status.BOARDED
        first_ticket.save(update_fields=["status"])

    still_paid, did_transition = mark_booking_completed_if_fully_boarded(booking=booking)
    assert did_transition is False
    assert still_paid.status == Booking.Status.PAID

    with platform_staff_bypass():
        second_ticket = Ticket.all_objects.get(seat_reservation=second_reservation)
        second_ticket.status = Ticket.Status.BOARDED
        second_ticket.save(update_fields=["status"])

    completed, did_transition = mark_booking_completed_if_fully_boarded(booking=booking)
    assert did_transition is True
    assert completed.status == Booking.Status.COMPLETED


def test_is_a_no_op_on_a_booking_still_pending_payment() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)

    result, did_transition = mark_booking_completed_if_fully_boarded(booking=booking)

    assert did_transition is False
    assert result.status == Booking.Status.PENDING_PAYMENT


def test_is_a_no_op_on_a_paid_booking_with_no_tickets_yet() -> None:
    """Defensive: a paid Booking should always have Tickets (issued by
    mark_booking_paid itself), but this must not silently "complete" one
    that somehow has none rather than assume the invariant holds."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)
    with platform_staff_bypass():
        booking = Booking.all_objects.get(pk=booking.pk)
        booking.status = Booking.Status.PAID
        booking.save(update_fields=["status"])

    result, did_transition = mark_booking_completed_if_fully_boarded(booking=booking)

    assert did_transition is False
    assert result.status == Booking.Status.PAID


def test_is_a_no_op_replayed_against_an_already_completed_booking() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation = booking_with_a_held_seat(client, business)
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        ticket = Ticket.all_objects.get(seat_reservation=reservation)
        ticket.status = Ticket.Status.BOARDED
        ticket.save(update_fields=["status"])
    mark_booking_completed_if_fully_boarded(booking=booking)

    result, did_transition = mark_booking_completed_if_fully_boarded(booking=booking)

    assert did_transition is False
    assert result.status == Booking.Status.COMPLETED
    assert (
        AuditLog.objects.filter(action="booking.completed", target_id=str(booking.id)).count() == 1
    )
