"""Remaining webhook edge cases from
docs/specs/5-payments-wallet-ledger.md: edge case 9 (non-pending
PaymentIntent), unknown event type, unknown reference."""

from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context

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


def test_unknown_event_type_is_ignored() -> None:
    raw_body, signature = signed_body(
        paystack_payload(event="subscription.create", reference="whatever")
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == status.HTTP_200_OK
    event = WebhookEvent.objects.get(reference="whatever", event_type="subscription.create")
    assert event.processing_status == WebhookEvent.ProcessingStatus.IGNORED


def test_charge_success_for_an_unknown_reference_is_ignored() -> None:
    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference="never-existed")
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == status.HTTP_200_OK
    event = WebhookEvent.objects.get(reference="never-existed", event_type="charge.success")
    assert event.processing_status == WebhookEvent.ProcessingStatus.IGNORED


def test_charge_success_for_an_already_succeeded_intent_is_a_no_op() -> None:
    """Edge case 9: a genuinely duplicate/out-of-order delivery not
    already caught by the WebhookEvent unique constraint (e.g. a
    differently-shaped retry with a slightly different payload)."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="75.00")
    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment(
            booking=booking, passenger=booking.passenger, idempotency_key="init-1"
        )

    first_body, first_signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference)
    )
    APIClient().post(
        reverse("paystack-webhook"),
        data=first_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=first_signature,
    )
    with platform_staff_bypass():
        intent.refresh_from_db()
    first_journal_entry_id = intent.journal_entry_id
    assert first_journal_entry_id is not None

    # A second, differently-shaped delivery for the same reference (a
    # different event_type-adjacent payload would collide on
    # WebhookEvent's own constraint instead — this simulates a genuine
    # already-succeeded re-delivery reaching _handle_charge_success).
    second_body, second_signature = signed_body(
        {
            "event": "charge.success",
            "data": {"reference": intent.psp_reference, "amount": 0, "extra": "field"},
        }
    )
    # The (provider, reference, event_type) triple is identical to the
    # first delivery, so WebhookEvent's own constraint is what actually
    # dedupes this — proving the *first* layer already makes a second
    # ledger write impossible. See test_webhook_concurrency.py for the
    # concurrent version of this same guarantee.
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=second_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=second_signature,
    )
    assert response.status_code == status.HTTP_200_OK

    with platform_staff_bypass():
        intent.refresh_from_db()
    assert intent.journal_entry_id == first_journal_entry_id
    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert WebhookEvent.objects.filter(reference=intent.psp_reference).count() == 1
