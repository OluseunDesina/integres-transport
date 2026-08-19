"""The mandatory concurrency spike for edge case 10
(docs/specs/5-payments-wallet-ledger.md): N concurrent
`trigger_settlement_run()` calls for the same `(business, period)`,
asserting exactly one `SettlementRun` survives and every pre-seeded
`JournalEntry` ends up claimed by that one survivor — never
double-claimed, never left behind (edge case 11's own "by construction"
claim, exercised under real concurrent racing here, not just directly
as apps/ledger/tests/test_ledger_settlement_claiming.py does). Mirrors
apps/payments/tests/test_payments_concurrency.py's and
apps/ledger/tests/test_ledger_wallet_account_concurrency.py's structure
exactly: real, separate connections genuinely racing, mocked Paystack
call so no real network I/O is involved."""

import threading
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.db import connections, transaction

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory, PlatformStaffUserFactory
from apps.ledger.models import JournalEntry, SettlementRun
from apps.ledger.services import (
    JournalLineInput,
    SettlementRunAlreadyExists,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)

from ..services import trigger_settlement_run
from .factories import PaystackAccountFactory

WORKER_COUNT = 8
ENTRY_COUNT = 5

_FAKE_TRANSFER_DATA = {
    "transfer_code": "TRF_abc123",
    "reference": "irrelevant",
    "status": "pending",
}


@pytest.mark.django_db(transaction=True)
def test_exactly_one_settlement_run_survives_concurrent_trigger() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_test")
        wallet = get_or_create_wallet_account(
            client=client, business=business, passenger=PassengerUserFactory(client=client)
        )
        clearing = get_or_create_business_clearing_account(client=client, business=business)
        commission = get_or_create_commission_account()
        seeded_entry_ids = []
        for _ in range(ENTRY_COUNT):
            amount = Decimal("100.00")
            commission_cut = Decimal("5.00")
            entry = post_journal_entry(
                business=business,
                entry_type=JournalEntry.EntryType.PAYMENT,
                lines=[
                    JournalLineInput(account=wallet, amount=-amount, currency="NGN"),
                    JournalLineInput(
                        account=clearing, amount=amount - commission_cut, currency="NGN"
                    ),
                    JournalLineInput(account=commission, amount=commission_cut, currency="NGN"),
                ],
            )
            seeded_entry_ids.append(entry.id)

    platform_staff = PlatformStaffUserFactory()
    today = date.today()
    period_start = today - timedelta(days=1)
    period_end = today + timedelta(days=2)

    results: list[SettlementRun] = []
    errors: list[Exception] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker() -> None:
        connections.close_all()
        barrier.wait()
        try:
            with patch(
                "apps.payments.services.initiate_transfer", return_value=dict(_FAKE_TRANSFER_DATA)
            ):
                run = trigger_settlement_run(
                    business=business,
                    period_start=period_start,
                    period_end=period_end,
                    initiated_by=platform_staff,
                )
            results.append(run)
        except SettlementRunAlreadyExists as exc:
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker) for _ in range(WORKER_COUNT)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 1, "exactly one concurrent trigger should have succeeded"
    assert len(errors) == WORKER_COUNT - 1, "every other concurrent trigger should be rejected"

    surviving_run = results[0]
    with transaction.atomic(), platform_staff_bypass():
        runs = list(SettlementRun.all_objects.filter(business=business))
        claimed = list(
            JournalEntry.all_objects.filter(id__in=seeded_entry_ids, settlement_run=surviving_run)
        )
        all_seeded = list(JournalEntry.all_objects.filter(id__in=seeded_entry_ids))

    assert len(runs) == 1
    assert len(claimed) == ENTRY_COUNT, (
        "every seeded entry must be claimed by the one surviving run"
    )
    assert all(entry.settlement_run_id == surviving_run.id for entry in all_seeded), (
        "no entry may be double-claimed or left unclaimed"
    )
