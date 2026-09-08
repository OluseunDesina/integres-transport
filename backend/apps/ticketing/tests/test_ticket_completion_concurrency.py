"""Proves `apps.booking.services.mark_booking_completed_if_fully_boarded`'s
`select_for_update()` lock on `Booking` correctly serializes two
validator devices racing to board the *last two* seats on the same
multi-seat booking — per this repo's own standard, every state-changing
call site gets its own concurrency proof (direct structural precedent:
`test_ticketing_concurrency.py`'s own two tests, same `transaction=True`
+ per-worker `transaction.atomic()`/`tenant_context()` shape).
"""

import threading

import pytest
from django.db import connections, transaction

from apps.booking.models import Booking
from apps.booking.services import mark_booking_paid
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.payments.tests.booking_helpers import booking_with_a_held_seat
from apps.seating.services import create_reservation
from apps.seating.tests.factories import SeatFactory

from ..models import Ticket
from ..services import validate_ticket


@pytest.mark.django_db(transaction=True)
def test_concurrently_boarding_the_last_two_seats_completes_the_booking_exactly_once() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        booking, first_reservation = booking_with_a_held_seat(client, business)
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
        staff = ClientStaffUserFactory(client=client, role=create_default_roles(client)["Owner"])
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        first_ticket = Ticket.all_objects.get(seat_reservation=first_reservation)
        second_ticket = Ticket.all_objects.get(seat_reservation=second_reservation)

    barrier = threading.Barrier(2)
    results: list[str] = []
    lock = threading.Lock()

    def worker(ticket: Ticket, idempotency_key: str) -> None:
        connections.close_all()
        barrier.wait()
        try:
            with transaction.atomic(), tenant_context(str(client.id)):
                boarded = validate_ticket(
                    trip=booking.trip,
                    payload=ticket.signed_payload,
                    validated_by=staff,
                    idempotency_key=idempotency_key,
                )
            with lock:
                results.append(str(boarded.id))
        finally:
            connections.close_all()

    threads = [
        threading.Thread(target=worker, args=(first_ticket, "complete-race-1")),
        threading.Thread(target=worker, args=(second_ticket, "complete-race-2")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 2
    with platform_staff_bypass():
        booking.refresh_from_db()
        completed_events = AuditLog.objects.filter(
            action="booking.completed", target_id=str(booking.id)
        )
    assert booking.status == Booking.Status.COMPLETED
    assert completed_events.count() == 1
