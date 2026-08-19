"""Adversarial RLS proof for Seat/SeatReservation — mirrors
apps/network/tests/test_network_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
both models automatically; this file proves RLS itself, not just that
it's enabled.
"""

import pytest
from django.db import connection

from apps.booking.tests.factories import BookingFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory

from ..services import create_reservation
from .factories import SeatFactory
from .helpers import fare_pricing_for

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_seat_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        seat_b = SeatFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "seating_seat" WHERE id = %s',  # noqa: S608
                [str(seat_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_seat_reservation_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        route = RouteFactory(client=client_b)
        stop_a = StopFactory(client=client_b, business=route.business)
        stop_b = StopFactory(client=client_b, business=route.business)
        RouteStopFactory(client=client_b, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client_b, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client_b, business=route.business, capacity=1)
        vehicle = VehicleFactory(
            client=client_b, business=route.business, vehicle_type=vehicle_type
        )
        trip = TripFactory(client=client_b, route=route, business=route.business, vehicle=vehicle)
        seat = SeatFactory(client=client_b, vehicle_type=vehicle_type)
        booking = BookingFactory(client=client_b, trip=trip, business=route.business)
        reservation_b = create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=15,
            **fare_pricing_for(client=client_b, route=route, business=route.business),
        )

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "seating_seatreservation" WHERE id = %s',  # noqa: S608
                [str(reservation_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
