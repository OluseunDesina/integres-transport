"""Service-level tests for apps.payments.services.initiate_payment —
see docs/specs/5-payments-wallet-ledger.md."""

from unittest.mock import patch

import pytest
from django.conf import settings

from apps.booking.models import Booking
from apps.booking.tests.factories import BookingFactory
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory

from ..models import PaymentIntent
from ..psp.paystack import PaystackAPIError
from ..services import (
    BookingNotPayable,
    PaymentAlreadyPending,
    PspNotConfigured,
    initiate_payment,
)
from .booking_helpers import booking_with_a_held_seat
from .factories import PaystackAccountFactory

pytestmark = pytest.mark.django_db

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "will-be-overridden",
}


def test_initiate_payment_rejects_a_business_with_no_paystack_account() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)
        with pytest.raises(PspNotConfigured):
            initiate_payment(booking=booking, passenger=passenger, idempotency_key="k1")


def test_initiate_payment_rejects_a_booking_not_pending_payment() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(
            client=client, business=business, passenger=passenger, status=Booking.Status.CANCELLED
        )
        with pytest.raises(BookingNotPayable):
            initiate_payment(booking=booking, passenger=passenger, idempotency_key="k1")


def test_initiate_payment_success_creates_a_pending_intent_and_refreshes_seat_holds() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, reservation = booking_with_a_held_seat(client, business)
    with tenant_context(str(client.id)):
        original_held_until = reservation.held_until
        business.seat_hold_minutes = 30
        business.save(update_fields=["seat_hold_minutes"])

    with (
        patch(
            "apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)
        ) as mock_init,
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment(
            booking=booking, passenger=booking.passenger, idempotency_key="k1"
        )

    assert mock_init.call_count == 1
    assert intent.status == PaymentIntent.Status.PENDING
    assert intent.amount == booking.total_amount
    assert intent.currency == booking.currency
    assert intent.psp_authorization_url == _FAKE_INIT_DATA["authorization_url"]
    with tenant_context(str(client.id)):
        reservation.refresh_from_db()
    assert reservation.held_until > original_held_until
    entry = AuditLog.objects.get(action="payment.initiated")
    assert entry.target_id == str(intent.id)


def test_initiate_payment_sends_paystack_a_callback_url_pointed_at_customer_app() -> None:
    """Without a callback_url, Paystack has nothing to redirect the
    browser back to after checkout — this is the concrete fix for the
    "payment page doesn't redirect" bug, not just an incidental field."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business)

    with (
        patch(
            "apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)
        ) as mock_init,
        tenant_context(str(client.id)),
    ):
        initiate_payment(booking=booking, passenger=booking.passenger, idempotency_key="k1")

    assert mock_init.call_args.kwargs["callback_url"] == f"{settings.CUSTOMER_APP_URL}/my-bookings"


def test_initiate_payment_rejects_a_second_pending_payment_for_the_same_booking() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        initiate_payment(booking=booking, passenger=passenger, idempotency_key="k1")
        with pytest.raises(PaymentAlreadyPending):
            initiate_payment(booking=booking, passenger=passenger, idempotency_key="k2")


def test_initiate_payment_replay_with_the_same_key_and_body_returns_the_original() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        first = initiate_payment(booking=booking, passenger=passenger, idempotency_key="replay")
        second = initiate_payment(booking=booking, passenger=passenger, idempotency_key="replay")
    assert first.id == second.id
    with tenant_context(str(client.id)):
        assert PaymentIntent.objects.count() == 1


def test_initiate_payment_raises_conflict_for_a_reused_key_with_a_different_body() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger_a = PassengerUserFactory(client=client)
        passenger_b = PassengerUserFactory(client=client)
        booking_a = BookingFactory(client=client, business=business, passenger=passenger_a)
        booking_b = BookingFactory(client=client, business=business, passenger=passenger_b)

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        initiate_payment(booking=booking_a, passenger=passenger_a, idempotency_key="dupe")
        with pytest.raises(IdempotencyKeyConflict):
            initiate_payment(booking=booking_b, passenger=passenger_b, idempotency_key="dupe")


def test_initiate_payment_leaves_no_row_behind_when_paystack_is_unreachable() -> None:
    """PSP-downtime failure mode: the Paystack call happens before any
    row is written, so a failure there leaves nothing to roll back and
    a retry under the same key is clean."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    with patch(
        "apps.payments.services.initialize_transaction",
        side_effect=PaystackAPIError("Paystack is down"),
    ):
        with tenant_context(str(client.id)), pytest.raises(PaystackAPIError):
            initiate_payment(booking=booking, passenger=passenger, idempotency_key="k1")
        with tenant_context(str(client.id)):
            assert PaymentIntent.objects.count() == 0

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment(booking=booking, passenger=passenger, idempotency_key="k1")
    assert intent.status == PaymentIntent.Status.PENDING
