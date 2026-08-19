"""The mandatory concurrency spike for Phase 5 Slice 1
(docs/specs/5-payments-wallet-ledger.md's Test plan): N concurrent
`get_or_create_wallet_account()` calls for the same `(business,
passenger)`, asserting exactly one `LedgerAccount(wallet)` row survives.

Mirrors apps/tapngo/tests/test_tapngo_concurrency.py's structure and
reasoning exactly — same `transaction=True` requirement (real, separate
connections genuinely racing, not one shared rolled-back transaction),
same explicit `transaction.atomic()` nesting around
`apps.core.tests.tenancy.tenant_context` for the same reason (RLS
session variables are `SET LOCAL`-scoped and vanish without an open
transaction). The mechanism under test is the same kind
`docs/adr/0004` established: a partial unique index, not an
application-level pre-check — Django's own `get_or_create` retries its
`get()` on `IntegrityError`, so "let the database decide" happens
inside the ORM call itself here, not in application code the way
`apps.tapngo.services._record_board` writes it out explicitly.
"""

import threading

import pytest
from django.db import connections, transaction

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory

from ..models import LedgerAccount
from ..services import get_or_create_wallet_account

WORKER_COUNT = 8


@pytest.mark.django_db(transaction=True)
def test_exactly_one_wallet_account_survives_concurrent_get_or_create() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)

    results: list[LedgerAccount] = []
    errors: list[Exception] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker() -> None:
        connections.close_all()
        barrier.wait()
        try:
            with transaction.atomic(), tenant_context(str(client.id)):
                account = get_or_create_wallet_account(
                    client=client, business=business, passenger=passenger
                )
            results.append(account)
        except Exception as exc:  # noqa: BLE001 - recorded for the assertion below, not swallowed
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker) for _ in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors, f"get_or_create_wallet_account should never raise, got: {errors}"
    assert len(results) == WORKER_COUNT
    distinct_ids = {account.id for account in results}
    assert len(distinct_ids) == 1, "every concurrent caller should resolve to the same row"

    with transaction.atomic(), tenant_context(str(client.id)):
        wallet_accounts = list(
            LedgerAccount.objects.filter(
                business=business,
                passenger=passenger,
                account_type=LedgerAccount.AccountType.WALLET,
            )
        )
    assert len(wallet_accounts) == 1


@pytest.mark.django_db(transaction=True)
def test_concurrent_wallet_account_creation_for_different_passengers_does_not_conflict() -> None:
    """Sanity check the other direction: different passengers on the
    same Business must not be serialized against each other by the
    constraint — it's scoped to (business, passenger), not business
    alone."""
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passengers = [PassengerUserFactory(client=client) for _ in range(WORKER_COUNT)]

    results: list[LedgerAccount] = []
    errors: list[Exception] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker(index: int) -> None:
        connections.close_all()
        barrier.wait()
        try:
            with transaction.atomic(), tenant_context(str(client.id)):
                account = get_or_create_wallet_account(
                    client=client, business=business, passenger=passengers[index]
                )
            results.append(account)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors
    assert len({account.id for account in results}) == WORKER_COUNT
