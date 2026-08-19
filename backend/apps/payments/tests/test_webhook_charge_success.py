"""charge.success webhook handling — the normal path and edge case 6's
residual "booking already gone by delivery time" case
(docs/specs/5-payments-wallet-ledger.md)."""

from decimal import Decimal
from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.models import Booking
from apps.booking.services import cancel_booking
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.ledger.models import LedgerAccount
from apps.seating.models import SeatReservation

from ..models import PaymentIntent, WebhookEvent
from ..services import initiate_payment
from .booking_helpers import booking_with_a_held_seat
from .factories import PaystackAccountFactory
from .webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


def _create_pending_intent(client, business, booking):  # type: ignore[no-untyped-def]
    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        return initiate_payment(
            booking=booking, passenger=booking.passenger, idempotency_key="init-1"
        )


def test_charge_success_pays_the_booking_confirms_seats_and_posts_a_balanced_entry() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, reservation = booking_with_a_held_seat(client, business, amount="200.00")
    intent = _create_pending_intent(client, business, booking)

    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference)
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == status.HTTP_200_OK

    with platform_staff_bypass():
        intent.refresh_from_db()
        booking_after = Booking.all_objects.get(pk=booking.pk)
        reservation_after = SeatReservation.all_objects.get(pk=reservation.pk)
        wallet = LedgerAccount.all_objects.get(
            business=business,
            passenger=booking.passenger,
            account_type=LedgerAccount.AccountType.WALLET,
        )
        clearing = LedgerAccount.all_objects.get(
            business=business, account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
        )

    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.journal_entry_id is not None
    assert intent.requires_manual_refund is False
    assert booking_after.status == Booking.Status.PAID
    assert reservation_after.status == SeatReservation.Status.CONFIRMED

    # Wallet debit is negative — nothing this phase ever credits a
    # wallet (no top-up, no tap-and-go spend-down), so a passenger's
    # wallet balance is legitimately negative after every payment. This
    # is the spec's own literal three-line commission-split shape, not
    # a bug to "fix".
    assert wallet.cached_balance == Decimal("-200.00")
    assert clearing.cached_balance > Decimal("0.00")

    event = WebhookEvent.objects.get(reference=intent.psp_reference, event_type="charge.success")
    assert event.processing_status == WebhookEvent.ProcessingStatus.PROCESSED
    assert AuditLog.objects.filter(action="payment.succeeded").exists()
    assert AuditLog.objects.filter(action="booking.paid").exists()


def test_charge_success_after_the_booking_was_already_cancelled_flags_manual_refund() -> None:
    """Edge case 6's residual case: the seat hold/booking was already
    gone by the time a successful payment webhook lands. Real money
    moved — the ledger entry still posts — but the booking is left
    alone and the intent is flagged for manual attention rather than
    silently dropped."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, reservation = booking_with_a_held_seat(client, business, amount="150.00")
    intent = _create_pending_intent(client, business, booking)

    with tenant_context(str(client.id)):
        cancel_booking(booking=booking, cancelled_by=booking.passenger, reason="changed my mind")

    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference)
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == status.HTTP_200_OK

    with platform_staff_bypass():
        intent.refresh_from_db()
        booking_after = Booking.all_objects.get(pk=booking.pk)

    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.journal_entry_id is not None
    assert intent.requires_manual_refund is True
    assert booking_after.status == Booking.Status.CANCELLED
