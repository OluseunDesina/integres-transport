"""Shared fixture-building helper for payments tests that need a real
Booking with a real HELD SeatReservation (not just a bare
BookingFactory row) — needed to exercise mark_booking_paid's
SeatReservation -> CONFIRMED side effect and initiate_payment's
held_until refresh."""

from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Any

from django.utils import timezone

from apps.booking.tests.factories import BookingFactory
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory
from apps.seating.services import create_reservation
from apps.seating.tests.factories import SeatFactory


def booking_with_a_held_seat(
    client: Any, business: Any, *, amount: str = "500.00", passenger: Any = None
) -> tuple[Any, Any]:
    """Returns `(booking, reservation)`, both real rows: a Trip with a
    Route/Stops/Vehicle, an open-ended flat FareRule, and one HELD
    SeatReservation created the real way (via
    apps.seating.services.create_reservation), not faked.

    `passenger` defaults to a fresh `PassengerUserFactory` row, as
    before — pass an existing one when a test needs two bookings
    belonging to the same passenger (e.g. a blended-payment test
    draining a shared wallet across two bookings)."""
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=2)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        # A real near-future departure, not TripFactory's own fixed
        # calendar-date default — apps.ticketing.services.issue_ticket
        # (Phase 6 Slice 1) anchors Ticket.expires_at to
        # trip.scheduled_departure_at, which must be after "now" (the
        # ticket's issued_at) for the same reason a real booking is
        # never taken for an already-departed trip.
        departure = timezone.now() + datetime.timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            service_date=departure.date(),
            scheduled_departure_at=departure,
        )
        fare_rule = FareRuleFactory(client=client, route=route, business=business, amount=amount)
        if passenger is None:
            passenger = PassengerUserFactory(client=client)
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = BookingFactory(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            total_amount=Decimal(amount),
            currency=business.currency,
        )
        reservation = create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=business.seat_hold_minutes,
            amount=fare_rule.amount,
            fare_rule=fare_rule,
        )
    return booking, reservation
