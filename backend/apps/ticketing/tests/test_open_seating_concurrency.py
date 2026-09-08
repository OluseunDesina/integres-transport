"""The ADR-0008-mandated concurrency test for open-seating capacity —
docs/specs/10-booking-modes.md.

**It asserts what the system actually guarantees, which is not what
ADR-0008 first assumed.** That ADR expected capacity to be enforced:
"N racing requests for the last place yield exactly one success". A
product decision (2026-08-27) changed the unit of counting to issued
tickets, so unpaid bookings hold nothing, and an oversold departure is
remedied commercially instead. Under that design N racing *bookings*
can all succeed, because none of them has paid yet and so none is
visible to the count.

Writing this as "exactly one succeeds" would therefore assert a
property the system no longer has, and would fail for the right reason
while telling the reader the wrong story. What is genuinely guaranteed,
and what these tests pin down:

1. **A consistent count under the lock.** Concurrent *issuances* cannot
   both read a stale total; the number of tickets that end up on a trip
   is exactly the number issued.
2. **No silent oversell.** Every oversold departure produces exactly
   one `trip.oversold` audit record — which is what makes the refund /
   wallet-credit remedy actionable rather than hypothetical.
3. **A demonstrably full departure still refuses new bookings.** The
   capacity gate at booking time is real; it just cannot see in-flight
   payments.

Uses `pytest.mark.django_db(transaction=True)` for the same reason
`apps/seating/tests/test_seat_concurrency.py` does — see that module's
docstring for the full explanation of why real concurrency needs real
separate connections, and why `tenant_context` must be nested inside an
explicit `transaction.atomic()` in setup and in every worker.
"""

import datetime
import threading

import pytest
from django.db import connections, transaction
from django.utils import timezone

from apps.booking.models import Booking
from apps.booking.services import create_booking, mark_booking_paid
from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory
from apps.ticketing.capacity import TripSoldOut
from apps.ticketing.models import Ticket

WORKER_COUNT = 4


def _open_seating_trip(client, *, capacity):  # type: ignore[no-untyped-def]
    business = BusinessFactory(
        client=client,
        booking_mode_default=Business.BookingMode.OPEN_SEATING,
        capacity_enforced=True,
    )
    route = RouteFactory(client=client, business=business)
    stop_a = StopFactory(client=client, business=business)
    stop_b = StopFactory(client=client, business=business)
    RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
    RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
    vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=capacity)
    vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
    # A real near-future departure, not TripFactory's fixed past
    # calendar date: issue_ticket anchors expires_at to
    # scheduled_departure_at, and the ticket_expires_after_issued check
    # constraint rejects a ticket that expired before it was issued.
    # Same trap apps/payments/tests/booking_helpers.py already documents.
    departure = timezone.now() + datetime.timedelta(hours=2)
    trip = TripFactory(
        client=client,
        route=route,
        business=business,
        vehicle=vehicle,
        booking_mode=Business.BookingMode.OPEN_SEATING,
        service_date=departure.date(),
        scheduled_departure_at=departure,
    )
    FareRuleFactory(client=client, route=route, business=business, amount="500.00")
    return trip, stop_a, stop_b


@pytest.mark.django_db(transaction=True)
def test_concurrent_issuance_never_loses_or_duplicates_a_ticket() -> None:
    """Guarantee 1: the count under the lock is consistent.

    Four bookings pay at once for a 4-place vehicle. Every one must get
    its ticket, and no ticket may be issued twice — a lost update here
    would silently under-count capacity for everyone after it.
    """
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        trip, stop_a, stop_b = _open_seating_trip(client, capacity=WORKER_COUNT)
        bookings = [
            create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stop_a,
                to_stop=stop_b,
                idempotency_key=f"race-{index}",
            )
            for index in range(WORKER_COUNT)
        ]

    barrier = threading.Barrier(WORKER_COUNT)

    def worker(booking: Booking) -> None:
        connections.close_all()
        barrier.wait()
        try:
            mark_booking_paid(booking=booking)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(booking,)) for booking in bookings]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    with platform_staff_bypass():
        tickets = list(Ticket.all_objects.filter(trip=trip))
        oversells = list(AuditLog.objects.filter(action="trip.oversold"))

    assert len(tickets) == WORKER_COUNT, "every paid booking should produce exactly one ticket"
    assert {t.booking_id for t in tickets} == {b.id for b in bookings}
    # Exactly at capacity, so nothing was oversold.
    assert oversells == []


@pytest.mark.django_db(transaction=True)
def test_every_oversell_is_recorded_exactly_once() -> None:
    """Guarantee 2: no oversell is silent.

    Four bookings race to pay for a 2-place vehicle. All four succeed —
    that is the accepted consequence of counting only issued tickets —
    but the departure must not go oversold *quietly*, or nobody knows
    which passengers to refund.

    The count of `trip.oversold` records is asserted rather than merely
    being non-zero: a duplicated record would double-refund, and a
    missing one would strand a passenger.
    """
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        trip, stop_a, stop_b = _open_seating_trip(client, capacity=2)
        bookings = [
            create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stop_a,
                to_stop=stop_b,
                idempotency_key=f"oversell-{index}",
            )
            for index in range(WORKER_COUNT)
        ]

    barrier = threading.Barrier(WORKER_COUNT)

    def worker(booking: Booking) -> None:
        connections.close_all()
        barrier.wait()
        try:
            mark_booking_paid(booking=booking)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(booking,)) for booking in bookings]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    with platform_staff_bypass():
        tickets = list(Ticket.all_objects.filter(trip=trip))
        oversells = list(AuditLog.objects.filter(action="trip.oversold"))

    assert len(tickets) == WORKER_COUNT
    # Two places, four sold — the third and fourth issuance each crossed
    # the line and each recorded it.
    assert len(oversells) == WORKER_COUNT - 2
    assert all(record.target_id == str(trip.id) for record in oversells)


@pytest.mark.django_db(transaction=True)
def test_a_full_departure_still_refuses_new_bookings() -> None:
    """Guarantee 3: the booking-time gate is real.

    Counting only issued tickets weakens the guarantee against in-flight
    payments — it does not remove it. Once the places are actually sold,
    a new booking is refused outright rather than adding to an oversell.
    """
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        trip, stop_a, stop_b = _open_seating_trip(client, capacity=1)
        booking = create_booking(
            trip=trip,
            passenger=PassengerUserFactory(client=client),
            passenger_count=1,
            from_stop=stop_a,
            to_stop=stop_b,
            idempotency_key="fills-the-bus",
        )

    mark_booking_paid(booking=booking)

    with transaction.atomic(), tenant_context(str(client.id)), pytest.raises(TripSoldOut):
        create_booking(
            trip=trip,
            passenger=PassengerUserFactory(client=client),
            passenger_count=1,
            from_stop=stop_a,
            to_stop=stop_b,
            idempotency_key="too-late",
        )
