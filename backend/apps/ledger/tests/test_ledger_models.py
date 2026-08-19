"""Model-level constraint tests for apps.ledger — see docs/adr/0006 and
docs/specs/5-payments-wallet-ledger.md. Each constraint is proven by
attempting the write and letting Postgres reject it, not by an
application-level pre-check, matching this codebase's established
"always attempt the write, let the database decide" discipline.
"""

from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory

from ..models import LedgerAccount, SettlementRun
from .factories import LedgerAccountFactory

pytestmark = pytest.mark.django_db


def test_only_one_wallet_account_per_business_and_passenger() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        LedgerAccountFactory(client=client, business=business, passenger=passenger)
        with pytest.raises(IntegrityError), transaction.atomic():
            LedgerAccountFactory(client=client, business=business, passenger=passenger)


def test_a_different_passenger_can_have_their_own_wallet_account_on_the_same_business() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        LedgerAccountFactory(client=client, business=business)
        LedgerAccountFactory(client=client, business=business)  # a second, distinct passenger
        assert LedgerAccount.objects.filter(business=business).count() == 2


def test_only_one_clearing_account_per_business() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        LedgerAccountFactory(
            client=client,
            business=business,
            account_type=LedgerAccount.AccountType.BUSINESS_CLEARING,
            passenger=None,
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            LedgerAccountFactory(
                client=client,
                business=business,
                account_type=LedgerAccount.AccountType.BUSINESS_CLEARING,
                passenger=None,
            )


def test_only_one_refund_contra_account_per_business() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        LedgerAccountFactory(
            client=client,
            business=business,
            account_type=LedgerAccount.AccountType.REFUND_CONTRA,
            passenger=None,
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            LedgerAccountFactory(
                client=client,
                business=business,
                account_type=LedgerAccount.AccountType.REFUND_CONTRA,
                passenger=None,
            )


def test_only_one_psp_suspense_account_per_business_and_provider() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        LedgerAccountFactory(
            client=client,
            business=business,
            account_type=LedgerAccount.AccountType.PSP_SUSPENSE,
            passenger=None,
            psp_provider="paystack",
        )
        # A different provider on the same Business is fine.
        LedgerAccountFactory(
            client=client,
            business=business,
            account_type=LedgerAccount.AccountType.PSP_SUSPENSE,
            passenger=None,
            psp_provider="dpo",
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            LedgerAccountFactory(
                client=client,
                business=business,
                account_type=LedgerAccount.AccountType.PSP_SUSPENSE,
                passenger=None,
                psp_provider="paystack",
            )


def test_only_one_integra_commission_account_platform_wide() -> None:
    # Seeded once already by apps/ledger/migrations/0002 — a second
    # attempt must be rejected by the uniqueness constraint. Attempted
    # under `platform_staff_bypass()`/`all_objects` — a `client=None` row
    # is rejected by RLS itself before it would even reach this
    # constraint for anything less privileged (see test_ledger_rls.py),
    # so this test's job is specifically to prove the constraint, not
    # RLS, which is proven separately.
    #
    # `platform_staff_bypass()` must be the *outer* context and
    # `transaction.atomic()` the inner one, matching
    # `apps.ledger.services.post_journal_entry`'s own nesting — the
    # reverse order leaves the connection in a "needs_rollback" state
    # by the time `platform_staff_bypass()`'s own cleanup tries to run
    # more SQL, which raises `TransactionManagementError` and masks the
    # real `IntegrityError` this test means to prove.
    with pytest.raises(IntegrityError), platform_staff_bypass(), transaction.atomic():
        LedgerAccount.all_objects.create(
            client=None,
            account_type=LedgerAccount.AccountType.INTEGRA_COMMISSION,
            passenger=None,
        )


def test_a_non_wallet_account_cannot_have_a_passenger() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        with pytest.raises(IntegrityError), transaction.atomic():
            LedgerAccount.objects.create(
                client=client,
                business=business,
                account_type=LedgerAccount.AccountType.BUSINESS_CLEARING,
                passenger=passenger,
            )


def test_a_wallet_account_must_have_a_passenger() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        with pytest.raises(IntegrityError), transaction.atomic():
            LedgerAccount.objects.create(
                client=client,
                business=business,
                account_type=LedgerAccount.AccountType.WALLET,
                passenger=None,
            )


def test_a_non_commission_account_must_have_a_business() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)), pytest.raises(IntegrityError), transaction.atomic():
        LedgerAccount.objects.create(
            client=client,
            business=None,
            account_type=LedgerAccount.AccountType.REFUND_CONTRA,
            passenger=None,
        )


def test_only_one_settlement_run_per_business_and_period() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        SettlementRun.objects.create(
            client=client,
            business=business,
            period_start="2026-08-01",
            period_end="2026-08-08",
            total_amount=Decimal("0.00"),
            currency=business.currency,
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            SettlementRun.objects.create(
                client=client,
                business=business,
                period_start="2026-08-01",
                period_end="2026-08-08",
                total_amount=Decimal("0.00"),
                currency=business.currency,
            )
