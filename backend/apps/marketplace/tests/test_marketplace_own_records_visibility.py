"""The five "my own records" views widened for docs/adr/0009: a
marketplace passenger's own Booking, PaymentIntent, Ticket and
Notification rows carry the *operator's* Client, not the passenger's
own (Marketplace) one — these prove each view still surfaces them, and
that an unrelated passenger still sees nothing.
"""

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.services import create_booking, mark_booking_paid
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import CustomerTokenObtainSerializer
from apps.notifications.models import Notification

from .test_marketplace_booking_flow import _marketplace_passenger, _operator_trip_with_seat

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = CustomerTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _paid_cross_client_booking():  # type: ignore[no-untyped-def]
    operator_client = ClientFactory()
    # A future departure: Ticket.expires_at is anchored to
    # scheduled_departure_at, and the fixture's default is a fixed past
    # date — issuing a ticket against it would violate
    # ticket_expires_after_issued.
    future_departure = timezone.now() + timezone.timedelta(days=7)
    trip, stop_a, stop_b, seat = _operator_trip_with_seat(
        operator_client,
        service_date=future_departure.date(),
        scheduled_departure_at=future_departure,
    )
    passenger = _marketplace_passenger()
    with tenant_context(str(operator_client.id)):
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="own-records-visibility-1",
        )
    # mark_booking_paid opens its own platform_staff_bypass() — the same
    # "no ambient tenancy context" path the real Paystack webhook uses.
    booking, _ = mark_booking_paid(booking=booking)
    return operator_client, booking, passenger


def test_payment_intent_mine_shows_a_marketplace_payment() -> None:
    from apps.payments.tests.factories import PaymentIntentFactory

    operator_client, booking, passenger = _paid_cross_client_booking()
    with tenant_context(str(operator_client.id)):
        intent = PaymentIntentFactory(client=operator_client, booking=booking)

    mine = _auth_client(passenger).get(reverse("payment-mine"), {})
    detail = _auth_client(passenger).get(reverse("payment-detail", args=[intent.id]))

    assert mine.status_code == status.HTTP_200_OK
    assert detail.status_code == status.HTTP_200_OK
    assert detail.data["id"] == str(intent.id)

    other_passenger = _marketplace_passenger()
    other_detail = _auth_client(other_passenger).get(reverse("payment-detail", args=[intent.id]))
    assert other_detail.status_code == status.HTTP_404_NOT_FOUND


def test_booking_tickets_view_shows_a_marketplace_ticket() -> None:
    operator_client, booking, passenger = _paid_cross_client_booking()

    response = _auth_client(passenger).get(reverse("booking-tickets", args=[booking.id]))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 1

    other_passenger = _marketplace_passenger()
    other_response = _auth_client(other_passenger).get(
        reverse("booking-tickets", args=[booking.id])
    )
    assert other_response.status_code == status.HTTP_403_FORBIDDEN


def _cross_client_notification(operator_client: object, passenger: User) -> Notification:  # type: ignore[no-untyped-def]
    with tenant_context(str(operator_client.id)):  # type: ignore[attr-defined]
        return Notification.all_objects.create(
            client=operator_client,
            recipient=passenger,
            notification_type=Notification.NotificationType.TICKET_UNUSED_REMINDER,
            title="Your ticket is waiting",
            body="Board within the hour.",
            notified_for_date=timezone.localdate(),
        )


def test_notification_mine_shows_a_notification_from_an_operator_client() -> None:
    operator_client = ClientFactory()
    passenger = _marketplace_passenger()
    _cross_client_notification(operator_client, passenger)

    response = _auth_client(passenger).get(reverse("notification-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 1

    other_passenger = _marketplace_passenger()
    other_response = _auth_client(other_passenger).get(reverse("notification-mine"))
    assert other_response.data["results"] == []


def test_notification_read_marks_a_cross_client_notification_read() -> None:
    operator_client = ClientFactory()
    passenger = _marketplace_passenger()
    notification = _cross_client_notification(operator_client, passenger)

    response = _auth_client(passenger).post(reverse("notification-read", args=[notification.id]))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["read_at"] is not None
