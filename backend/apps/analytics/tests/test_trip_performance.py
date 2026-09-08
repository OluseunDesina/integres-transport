"""Per-trip performance — docs/specs/16-operational-analytics.md.

Most of these assert a `null`. Each one is a case where zero would be a
lie, and reporting zero is exactly how a dashboard becomes confidently
wrong.
"""

from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status

from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.scheduling.models import Trip
from apps.scheduling.services import transition_trip_status

from .helpers import as_decimal, auth_client, business_for, pay_a_booking

pytestmark = pytest.mark.django_db


def _performance(staff, trip_id):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(
        reverse("analytics-trip-performance", kwargs={"pk": str(trip_id)})
    )


def test_a_paid_trip_reports_occupancy_and_ledger_revenue() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    response = _performance(staff, booking.trip_id)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["capacity"]["seats_sold"] == 1
    assert response.data["capacity"]["total_seats"] == 1
    assert as_decimal(response.data["capacity"]["occupancy_rate"]) == Decimal("1.000")
    money = response.data["money"][0]
    assert as_decimal(money["gross"]) == Decimal("1000.00")
    assert as_decimal(money["revenue"]) < as_decimal(money["gross"])
    assert money["revenue_per_seat"] == money["revenue"]


def test_occupancy_is_null_without_a_vehicle_not_zero() -> None:
    """0% would read as "nobody bought a seat" on a departure nobody has
    chosen a bus for. There is no denominator, so there is no rate."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    with tenant_context(str(client.id)):
        Trip.objects.filter(pk=booking.trip_id).update(vehicle=None)
    staff = ClientStaffUserFactory(client=client)

    capacity = _performance(staff, booking.trip_id).data["capacity"]

    assert capacity["total_seats"] is None
    assert capacity["occupancy_rate"] is None
    assert capacity["seats_sold"] == 1


def test_punctuality_is_null_before_the_trip_departs() -> None:
    """A trip that has not left is not "0 minutes late"."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    assert _performance(staff, booking.trip_id).data["punctuality"] is None


def test_delay_is_computed_from_the_actual_departure_time() -> None:
    """Slice 1's whole reason for existing: `status_changed_at` cannot
    answer this once the trip has since completed."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = Trip.objects.get(pk=booking.trip_id)
        transition_trip_status(
            trip=trip, new_status=Trip.Status.IN_PROGRESS, reason="", actor=staff
        )
        # Departed 20 minutes after it was scheduled to.
        Trip.objects.filter(pk=trip.pk).update(
            scheduled_departure_at=trip.actual_departure_at - timezone.timedelta(minutes=20)
        )

    punctuality = _performance(staff, booking.trip_id).data["punctuality"]

    assert punctuality["delay_minutes"] == 20
    assert punctuality["on_time"] is False


def test_a_departure_that_left_early_is_on_time() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = Trip.objects.get(pk=booking.trip_id)
        transition_trip_status(
            trip=trip, new_status=Trip.Status.IN_PROGRESS, reason="", actor=staff
        )
        Trip.objects.filter(pk=trip.pk).update(
            scheduled_departure_at=trip.actual_departure_at + timezone.timedelta(minutes=5)
        )

    punctuality = _performance(staff, booking.trip_id).data["punctuality"]

    assert punctuality["on_time"] is True


def test_a_cancelled_trip_is_reported_but_drags_no_average() -> None:
    """Counted in the dashboard's totals, excluded from occupancy and
    punctuality — this spec's own edge case table."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = Trip.objects.get(pk=booking.trip_id)
        transition_trip_status(
            trip=trip, new_status=Trip.Status.CANCELLED, reason="Vehicle fault", actor=staff
        )

    response = _performance(staff, booking.trip_id)

    assert response.data["cancelled"] is True
    assert response.data["capacity"]["occupancy_rate"] is None
    assert response.data["punctuality"] is None


def test_a_trip_with_no_payments_reports_no_money_rather_than_zero() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    from apps.payments.models import PaymentIntent

    with tenant_context(str(client.id)):
        PaymentIntent.objects.filter(booking=booking).update(
            status=PaymentIntent.Status.CANCELLED
        )
    staff = ClientStaffUserFactory(client=client)

    assert _performance(staff, booking.trip_id).data["money"] == []


def test_another_clients_trip_is_a_404() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    booking, _intent = pay_a_booking(client_b, business_b, amount="1000.00", idempotency_key="k1")
    staff_a = ClientStaffUserFactory(client=client_a)

    assert _performance(staff_a, booking.trip_id).status_code == status.HTTP_404_NOT_FOUND


def test_incidents_filed_against_the_trip_are_counted_whatever_their_status() -> None:
    """Real since docs/specs/17-incidents.md; hardcoded to zero before
    it. Every status counts: a resolved fault still happened on this
    departure, and a performance record that forgot it would be
    reporting the trip's paperwork rather than its day.
    """
    from apps.incidents.models import Incident
    from apps.incidents.tests.factories import IncidentFactory

    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = Trip.objects.get(pk=booking.trip_id)
        IncidentFactory(client=client, business=business, trip=trip)
        IncidentFactory(
            client=client, business=business, trip=trip, status=Incident.Status.CLOSED
        )
        # Filed against the Business but not this trip — must not count.
        IncidentFactory(client=client, business=business)

    assert _performance(staff, booking.trip_id).data["incidents"] == 2
