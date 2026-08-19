"""FareRule versioning + purchase-time snapshot — the plan's own test
plan: supersede creates a second version, as-of resolution, future-
dating, overlap rejection, and historical booking immutability after a
fare edit.
"""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.services import create_booking
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory
from apps.seating.models import SeatReservation
from apps.seating.tests.factories import SeatFactory

from ..models import FareRule
from ..services import FareNotConfigured, get_fare, supersede_fare_rule
from .factories import FareRuleFactory

pytestmark = pytest.mark.django_db


def _auth_client(user):  # type: ignore[no-untyped-def]
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _trip_with_seat(client):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business, capacity=2)
        vehicle = VehicleFactory(client=client, business=route.business, vehicle_type=vehicle_type)
        trip = TripFactory(client=client, route=route, business=route.business, vehicle=vehicle)
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
    return trip, stop_a, stop_b, seat


def test_supersede_closes_the_old_row_and_creates_a_readable_successor() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        original = FareRuleFactory(client=client, amount="100.00")

    boundary = timezone.now() + timedelta(days=1)
    with tenant_context(str(client.id)):
        successor = supersede_fare_rule(
            fare_rule=original,
            amount=Decimal("150.00"),
            updated_by=staff,
            effective_from=boundary,
        )
        original.refresh_from_db()

    assert original.effective_to == boundary
    assert original.amount == Decimal("100.00")
    assert successor.id != original.id
    assert successor.amount == Decimal("150.00")
    assert successor.effective_from == boundary
    assert successor.effective_to is None


def test_get_fare_returns_the_old_amount_before_the_boundary_and_the_new_after() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip, stop_a, stop_b, _seat = _trip_with_seat(client)
    boundary = timezone.now() + timedelta(hours=1)
    with tenant_context(str(client.id)):
        original = FareRuleFactory(
            client=client,
            route=trip.route,
            business=trip.business,
            amount="100.00",
            effective_from=timezone.now() - timedelta(days=1),
        )
        supersede_fare_rule(
            fare_rule=original,
            amount=Decimal("200.00"),
            updated_by=staff,
            effective_from=boundary,
        )
        before = get_fare(
            trip=trip, from_stop=stop_a, to_stop=stop_b, as_of=boundary - timedelta(seconds=1)
        )
        after = get_fare(
            trip=trip, from_stop=stop_a, to_stop=stop_b, as_of=boundary + timedelta(seconds=1)
        )

    assert before.amount == Decimal("100.00")
    assert after.amount == Decimal("200.00")


def test_a_future_dated_fare_does_not_affect_todays_quote() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip, stop_a, stop_b, _seat = _trip_with_seat(client)
    with tenant_context(str(client.id)):
        original = FareRuleFactory(
            client=client,
            route=trip.route,
            business=trip.business,
            amount="100.00",
            effective_from=timezone.now() - timedelta(days=1),
        )
        supersede_fare_rule(
            fare_rule=original,
            amount=Decimal("999.00"),
            updated_by=staff,
            effective_from=timezone.now() + timedelta(days=30),
        )
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)

    assert quote.amount == Decimal("100.00")


def test_database_rejects_overlapping_validity_ranges_for_one_route() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        FareRuleFactory(
            client=client,
            route=route,
            business=route.business,
            amount="100.00",
            effective_from=timezone.now() - timedelta(days=1),
            effective_to=None,
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            FareRule.objects.create(
                client=client,
                business=route.business,
                route=route,
                amount=Decimal("200.00"),
                effective_from=timezone.now(),
                effective_to=None,
            )


def test_booking_records_per_seat_amount_currency_and_originating_rule() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    trip, stop_a, stop_b, seat = _trip_with_seat(client)
    with tenant_context(str(client.id)):
        rule = FareRuleFactory(
            client=client, route=trip.route, business=trip.business, amount="750.00"
        )
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="versioning-key-1",
        )
        reservations = list(SeatReservation.objects.filter(booking=booking))

    assert booking.total_amount == Decimal("750.00")
    assert booking.currency == trip.business.currency
    assert len(reservations) == 1
    assert reservations[0].amount == Decimal("750.00")
    assert reservations[0].fare_rule_id == rule.id
    assert reservations[0].fare_segment_rule_id is None


def test_editing_a_fare_after_a_booking_leaves_the_snapshot_untouched() -> None:
    """The regression test for the original worry: historical bookings
    keep their recorded amounts and rule reference after a fare edit."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    trip, stop_a, stop_b, seat = _trip_with_seat(client)
    with tenant_context(str(client.id)):
        rule = FareRuleFactory(
            client=client, route=trip.route, business=trip.business, amount="750.00"
        )
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="versioning-key-2",
        )
        reservation = SeatReservation.objects.get(booking=booking)
        supersede_fare_rule(
            fare_rule=rule,
            amount=Decimal("999.00"),
            updated_by=staff,
        )
        booking.refresh_from_db()
        reservation.refresh_from_db()
        rule.refresh_from_db()

    assert booking.total_amount == Decimal("750.00")
    assert booking.currency == trip.business.currency
    assert reservation.amount == Decimal("750.00")
    assert reservation.fare_rule_id == rule.id
    assert rule.effective_to is not None
    # A fresh quote sees the new price — only the snapshot is frozen.
    with tenant_context(str(client.id)):
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)
    assert quote.amount == Decimal("999.00")


def test_patching_a_closed_rule_is_rejected() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        original = FareRuleFactory(client=client, amount="100.00")
        supersede_fare_rule(fare_rule=original, amount=Decimal("200.00"), updated_by=staff)

    response = _auth_client(staff).patch(
        reverse("fare-rule-update", kwargs={"pk": str(original.id)}),
        {"amount": "300.00"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_get_fare_raises_when_only_a_future_rule_exists() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, _seat = _trip_with_seat(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=trip.route,
            business=trip.business,
            amount="100.00",
            effective_from=timezone.now() + timedelta(days=7),
        )
        with pytest.raises(FareNotConfigured):
            get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)
