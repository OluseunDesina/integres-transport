"""The ADR-0004-mandated concurrency spike: N concurrent transactions
requesting overlapping segments on one seat, asserting exactly one
succeeds. This is the test that promotes docs/adr/0004's status from
"Decided, pending its own proof" to fully "Accepted" — see that
document's Consequences section.

Uses `pytest.mark.django_db(transaction=True)` (pytest-django's
`TransactionTestCase`-equivalent), not the default `django_db` mark —
the default wraps each test in one rolled-back transaction shared by
the whole test, which would mask real cross-connection concurrent
behaviour entirely (every "concurrent" write would actually be
serialized through one connection's one transaction). Real behaviour
requires real, separate connections genuinely racing.

Because `transaction=True` tests do **not** get pytest-django's usual
implicit outer-atomic-per-test wrapping, `apps.core.tests.tenancy.tenant_context`
(which only sets Postgres's `SET LOCAL`-scoped RLS session variables,
relying on that outer wrapping per its own docstring) must be nested
inside an explicit `transaction.atomic()` block here — both in setup
and in each worker thread — or the RLS session variables would vanish
before the next statement runs, the same class of gap
`apps.core.rls.platform_staff_bypass` already had to solve for Celery
tasks.
"""

import threading

import pytest
from django.db import connections, transaction

from apps.booking.tests.factories import BookingFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory

from ..models import SeatReservation
from ..services import SeatUnavailable, create_reservation
from .factories import SeatFactory
from .helpers import fare_pricing_for

WORKER_COUNT = 6


@pytest.mark.django_db(transaction=True)
def test_exactly_one_concurrent_reservation_succeeds_for_an_overlapping_segment() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business, capacity=1)
        vehicle = VehicleFactory(client=client, business=route.business, vehicle_type=vehicle_type)
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        trip = TripFactory(client=client, route=route, business=route.business, vehicle=vehicle)
        bookings = [
            BookingFactory(client=client, trip=trip, business=route.business)
            for _ in range(WORKER_COUNT)
        ]
        # Create the fare snapshot once before the race — each worker
        # calling fare_pricing_for would race on the open-ended FareRule
        # GiST exclusion and poison the transaction.
        pricing = fare_pricing_for(client=client, route=route, business=route.business)

    results: list[object] = []
    errors: list[object] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker(booking: object) -> None:
        connections.close_all()
        barrier.wait()
        try:
            with transaction.atomic(), tenant_context(str(client.id)):
                reservation = create_reservation(
                    trip=trip,
                    seat=seat,
                    from_stop=stop_a,
                    to_stop=stop_b,
                    booking=booking,  # type: ignore[arg-type]
                    hold_minutes=15,
                    **pricing,
                )
            results.append(reservation)
        except SeatUnavailable as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(booking,)) for booking in bookings]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 1, "exactly one concurrent reservation should have succeeded"
    assert len(errors) == WORKER_COUNT - 1, "every other concurrent reservation should be rejected"

    with transaction.atomic(), tenant_context(str(client.id)):
        held = list(
            SeatReservation.objects.filter(seat=seat, trip=trip, status=SeatReservation.Status.HELD)
        )
        all_rows = list(SeatReservation.objects.filter(seat=seat, trip=trip))
    # The losing attempts' own inner transaction.atomic() (inside
    # create_reservation) rolls back on IntegrityError via a savepoint —
    # no partial/failed rows should ever have persisted.
    assert len(held) == 1
    assert len(all_rows) == 1


@pytest.mark.django_db(transaction=True)
def test_non_overlapping_segments_on_the_same_seat_do_not_conflict() -> None:
    """Sanity check the other direction: the constraint must not be
    over-restrictive. Two passengers boarding/alighting at adjacent,
    non-overlapping segments of the same seat/trip ([1,2) and [2,3))
    must both succeed — this is a real, legitimate booking pattern, not
    a conflict."""
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_1 = StopFactory(client=client, business=route.business)
        stop_2 = StopFactory(client=client, business=route.business)
        stop_3 = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_1, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_2, sequence=2)
        RouteStopFactory(client=client, route=route, stop=stop_3, sequence=3)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business, capacity=1)
        vehicle = VehicleFactory(client=client, business=route.business, vehicle_type=vehicle_type)
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        trip = TripFactory(client=client, route=route, business=route.business, vehicle=vehicle)
        booking_1 = BookingFactory(client=client, trip=trip, business=route.business)
        booking_2 = BookingFactory(client=client, trip=trip, business=route.business)

        pricing = fare_pricing_for(client=client, route=route, business=route.business)
        reservation_1 = create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_1,
            to_stop=stop_2,
            booking=booking_1,
            hold_minutes=15,
            **pricing,
        )
        reservation_2 = create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_2,
            to_stop=stop_3,
            booking=booking_2,
            hold_minutes=15,
            **pricing,
        )

    assert reservation_1.status == SeatReservation.Status.HELD
    assert reservation_2.status == SeatReservation.Status.HELD
