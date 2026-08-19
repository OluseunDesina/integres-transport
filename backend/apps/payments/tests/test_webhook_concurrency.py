"""The mandatory flagship concurrency spike for edge case 7
(docs/specs/5-payments-wallet-ledger.md): N concurrent identical
webhook deliveries for the same `(reference, event_type)`, asserting
exactly one `JournalEntry` is written, exactly one `Booking` transition
happens, and exactly one `WebhookEvent` row exists — enforced by the
two-layer guard (`WebhookEvent`'s own unique constraint +
`PaymentIntent.journal_entry`'s OneToOne uniqueness). Mirrors
apps/tapngo/tests/test_tapngo_concurrency.py's structure: real,
separate connections genuinely racing, `process_paystack_webhook`
called directly (not through the HTTP client) the same way that file
calls `record_tap` directly."""

import threading
from unittest.mock import patch

import pytest
from django.db import connections, transaction

from apps.booking.models import Booking
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.ledger.models import JournalEntry
from apps.seating.models import SeatReservation

from ..models import PaymentIntent, WebhookEvent
from ..services import initiate_payment, process_paystack_webhook
from .booking_helpers import booking_with_a_held_seat
from .factories import PaystackAccountFactory
from .webhook_helpers import paystack_payload, signed_body

WORKER_COUNT = 8

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


@pytest.mark.django_db(transaction=True)
def test_exactly_one_ledger_entry_and_booking_transition_survive_concurrent_webhook_delivery() -> (
    None
):
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    with transaction.atomic():
        booking, reservation = booking_with_a_held_seat(client, business, amount="300.00")
    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        transaction.atomic(),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment(
            booking=booking, passenger=booking.passenger, idempotency_key="init-1"
        )

    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference)
    )

    barrier = threading.Barrier(WORKER_COUNT)
    errors: list[BaseException] = []

    def worker() -> None:
        connections.close_all()
        barrier.wait()
        try:
            process_paystack_webhook(raw_body=raw_body, signature=signature)
        except BaseException as exc:  # noqa: BLE001 - recorded, not swallowed
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker) for _ in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors, f"process_paystack_webhook should never raise, got: {errors}"

    with platform_staff_bypass():
        webhook_events = list(
            WebhookEvent.objects.filter(reference=intent.psp_reference, event_type="charge.success")
        )
        journal_entries = list(
            JournalEntry.all_objects.filter(external_reference=intent.psp_reference)
        )
        booking_after = Booking.all_objects.get(pk=booking.pk)
        reservation_after = SeatReservation.all_objects.get(pk=reservation.pk)
        intent_after = PaymentIntent.all_objects.get(pk=intent.pk)

    assert len(webhook_events) == 1, "exactly one WebhookEvent row should exist"
    assert len(journal_entries) == 1, "exactly one JournalEntry should have been posted"
    assert booking_after.status == Booking.Status.PAID
    assert reservation_after.status == SeatReservation.Status.CONFIRMED
    assert intent_after.status == PaymentIntent.Status.SUCCEEDED
    assert intent_after.journal_entry_id == journal_entries[0].id
