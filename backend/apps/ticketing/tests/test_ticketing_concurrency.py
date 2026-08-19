"""Proves `mark_booking_paid()`'s existing `select_for_update()` lock
(already relied on for the `booking.status` idempotency guard) extends
correctly to Ticket issuance now that `issue_ticket()` runs inside the
same locked block — per this repo's own standard, every state-changing
call site gets its own concurrency proof, even when the locking
mechanism is already proven elsewhere (`apps/tapngo/tests/test_tapngo_concurrency.py`
is the direct structural precedent this mirrors: same `transaction=True`
requirement for real, separate, genuinely racing connections, same
`transaction.atomic()` + `tenant_context` nesting for RLS session
variables).
"""

import threading

import pytest
from django.db import connections, transaction

from apps.booking.services import mark_booking_paid
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.payments.tests.booking_helpers import booking_with_a_held_seat

from ..models import Ticket
from ..services import validate_ticket

WORKER_COUNT = 8


@pytest.mark.django_db(transaction=True)
def test_concurrent_mark_booking_paid_issues_exactly_one_ticket() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        # booking_with_a_held_seat's own tenant_context call sets
        # Postgres session vars with SET LOCAL semantics — they only
        # persist for the enclosing transaction, and this test's
        # `transaction=True` marker means there is no ambient one
        # outside this `with` block (mirrors
        # apps/tapngo/tests/test_tapngo_concurrency.py's own single
        # combined `with transaction.atomic(), tenant_context(...):`
        # setup block for the identical reason).
        booking, reservation = booking_with_a_held_seat(client, business)

    barrier = threading.Barrier(WORKER_COUNT)

    def worker() -> None:
        connections.close_all()
        barrier.wait()
        try:
            mark_booking_paid(booking=booking)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker) for _ in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    with platform_staff_bypass():
        tickets = list(Ticket.all_objects.filter(seat_reservation=reservation))
    assert len(tickets) == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_validate_under_one_idempotency_key_boards_exactly_once() -> None:
    """Proves `validate_ticket()`'s `select_for_update()` +
    Idempotency-Key combination the same way the issuance test above
    proves `mark_booking_paid()`'s — N racing validate calls under the
    *same* key must produce exactly one `boarded_at` timestamp, not a
    race between two "first" scans."""
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        booking, reservation = booking_with_a_held_seat(client, business)
        staff = ClientStaffUserFactory(client=client, role=create_default_roles(client)["Owner"])
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        ticket = Ticket.all_objects.get(seat_reservation=reservation)

    barrier = threading.Barrier(WORKER_COUNT)
    results: list[object] = []
    lock = threading.Lock()

    def worker() -> None:
        connections.close_all()
        barrier.wait()
        try:
            # validate_ticket (unlike mark_booking_paid) has no bypass
            # of its own — it expects a request-scoped tenancy context,
            # same as apps.tapngo.services.record_tap. Each worker needs
            # its own combined transaction.atomic()+tenant_context()
            # block for the same SET LOCAL reason documented on the
            # issuance test above.
            with transaction.atomic(), tenant_context(str(client.id)):
                outcome = validate_ticket(
                    trip=booking.trip,
                    payload=ticket.signed_payload,
                    validated_by=staff,
                    idempotency_key="concurrent-validate",
                )
            with lock:
                results.append(outcome.boarded_at)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker) for _ in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == WORKER_COUNT
    assert len({str(boarded_at) for boarded_at in results}) == 1  # every result identical
    with platform_staff_bypass():
        ticket.refresh_from_db()
    assert ticket.status == Ticket.Status.BOARDED
