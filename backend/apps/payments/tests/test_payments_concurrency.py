"""The mandatory concurrency spike for edge case 5
(docs/specs/5-payments-wallet-ledger.md): N concurrent
`initiate_payment()` calls for the same booking, asserting exactly one
`pending` `PaymentIntent` survives. Mirrors
apps/ledger/tests/test_ledger_wallet_account_concurrency.py's structure
exactly — real, separate connections genuinely racing, mocked Paystack
call so no real network I/O is involved."""

import threading
from unittest.mock import patch

import pytest
from django.db import connections, transaction

from apps.booking.tests.factories import BookingFactory
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory

from ..models import PaymentIntent
from ..services import PaymentAlreadyPending, initiate_payment
from .factories import PaystackAccountFactory

WORKER_COUNT = 8

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


@pytest.mark.django_db(transaction=True)
def test_exactly_one_pending_payment_intent_survives_concurrent_initiation() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    results: list[object] = []
    errors: list[object] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker(index: int) -> None:
        connections.close_all()
        barrier.wait()
        try:
            with (
                patch(
                    "apps.payments.services.initialize_transaction",
                    return_value=dict(_FAKE_INIT_DATA),
                ),
                transaction.atomic(),
                tenant_context(str(client.id)),
            ):
                intent = initiate_payment(
                    booking=booking, passenger=passenger, idempotency_key=f"worker-{index}"
                )
            results.append(intent)
        except PaymentAlreadyPending as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 1, "exactly one concurrent initiation should have succeeded"
    assert len(errors) == WORKER_COUNT - 1, "every other concurrent initiation should be rejected"

    with transaction.atomic(), tenant_context(str(client.id)):
        pending = list(
            PaymentIntent.objects.filter(booking=booking, status=PaymentIntent.Status.PENDING)
        )
    assert len(pending) == 1
