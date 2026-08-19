"""The one-open-journey-per-passenger concurrency spike required by
docs/specs/4b-tap-and-go.md's Test plan section: N concurrent board taps
for the same (business, passenger), asserting exactly one succeeds.

Mirrors apps/seating/tests/test_seat_concurrency.py's structure and
reasoning exactly — same `transaction=True` requirement (real, separate
connections genuinely racing, not one shared rolled-back transaction),
same explicit `transaction.atomic()` nesting around
`apps.core.tests.tenancy.tenant_context` for the same reason (RLS
session variables are `SET LOCAL`-scoped and vanish without an open
transaction). The mechanism under test is simpler than seating's GiST
exclusion constraint — a plain Postgres partial unique index — but the
"always attempt the write, let the database decide, prove it under real
concurrency" standard is the same (docs/specs/4b-tap-and-go.md's Test
plan section says so explicitly).
"""

import threading

import pytest
from django.db import connections, transaction

from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory

from ..models import FareJourney
from ..services import OpenJourneyExists, issue_credential, record_tap

WORKER_COUNT = 6


@pytest.mark.django_db(transaction=True)
def test_exactly_one_concurrent_board_tap_opens_a_journey_for_the_same_passenger() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        trip = TripFactory(
            client=client, route=route, business=route.business, booking_mode="tap_and_go"
        )
        passenger = PassengerUserFactory(client=client)
        _credential, token = issue_credential(passenger=passenger, channel="qr", label="")

    results: list[object] = []
    errors: list[object] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker(index: int) -> None:
        connections.close_all()
        barrier.wait()
        try:
            with transaction.atomic(), tenant_context(str(client.id)):
                tap_event = record_tap(
                    trip=trip,
                    token=token,
                    tap_type="board",
                    stop=stop_a,
                    idempotency_key=f"worker-{index}",
                )
            results.append(tap_event)
        except OpenJourneyExists as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 1, "exactly one concurrent board tap should have succeeded"
    assert len(errors) == WORKER_COUNT - 1, "every other concurrent board tap should be rejected"

    with transaction.atomic(), tenant_context(str(client.id)):
        open_journeys = list(
            FareJourney.objects.filter(passenger=passenger, status=FareJourney.Status.OPEN)
        )
        all_journeys = list(FareJourney.objects.filter(passenger=passenger))
    assert len(open_journeys) == 1
    assert len(all_journeys) == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_board_taps_for_different_passengers_do_not_conflict() -> None:
    """Sanity check the other direction: the constraint must not be
    over-restrictive — different passengers boarding the same trip at
    the same instant is a real, legitimate pattern, not a conflict."""
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        trip = TripFactory(
            client=client, route=route, business=route.business, booking_mode="tap_and_go"
        )
        tokens = []
        for _ in range(WORKER_COUNT):
            passenger = PassengerUserFactory(client=client)
            _credential, token = issue_credential(passenger=passenger, channel="qr", label="")
            tokens.append(token)

    results: list[object] = []
    errors: list[object] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker(index: int) -> None:
        connections.close_all()
        barrier.wait()
        try:
            with transaction.atomic(), tenant_context(str(client.id)):
                tap_event = record_tap(
                    trip=trip,
                    token=tokens[index],
                    tap_type="board",
                    stop=stop_a,
                    idempotency_key=f"different-passenger-{index}",
                )
            results.append(tap_event)
        except OpenJourneyExists as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == WORKER_COUNT
    assert len(errors) == 0
