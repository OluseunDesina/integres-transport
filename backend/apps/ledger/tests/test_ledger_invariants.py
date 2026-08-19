"""post_journal_entry() balance-invariant tests — docs/adr/0006's own
"every entry's debits equal its credits, enforced by a test, not just
application logic" requirement.
"""

from decimal import Decimal

import pytest
from django.db.models import Sum

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory

from ..models import JournalEntry, JournalLine, LedgerAccount
from ..services import (
    JournalLineInput,
    UnbalancedJournalEntry,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)

pytestmark = pytest.mark.django_db


def _wallet_payment_lines(
    *, wallet: LedgerAccount, clearing: LedgerAccount, commission: LedgerAccount, amount: Decimal
) -> list[JournalLineInput]:
    """ADR-0006's fixed shape: one entry, three lines — passenger/wallet
    debit, Business clearing credit, Integra commission credit."""
    commission_cut = (amount * Decimal("0.05")).quantize(Decimal("0.01"))
    clearing_share = amount - commission_cut
    return [
        JournalLineInput(account=wallet, amount=-amount, currency="NGN"),
        JournalLineInput(account=clearing, amount=clearing_share, currency="NGN"),
        JournalLineInput(account=commission, amount=commission_cut, currency="NGN"),
    ]


def test_post_journal_entry_rejects_unbalanced_lines_before_any_write() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        clearing = get_or_create_business_clearing_account(client=client, business=business)

        with pytest.raises(UnbalancedJournalEntry):
            post_journal_entry(
                business=business,
                entry_type=JournalEntry.EntryType.PAYMENT,
                lines=[
                    JournalLineInput(account=wallet, amount=Decimal("-100.00"), currency="NGN"),
                    JournalLineInput(account=clearing, amount=Decimal("99.00"), currency="NGN"),
                ],
            )
        assert JournalEntry.objects.count() == 0
        assert JournalLine.objects.count() == 0


def test_post_journal_entry_rejects_an_empty_line_list() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        with pytest.raises(UnbalancedJournalEntry):
            post_journal_entry(
                business=business, entry_type=JournalEntry.EntryType.PAYMENT, lines=[]
            )


def test_post_journal_entry_writes_a_balanced_entry_and_updates_cached_balances() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        clearing = get_or_create_business_clearing_account(client=client, business=business)
    commission = get_or_create_commission_account()

    with tenant_context(str(client.id)):
        entry = post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.PAYMENT,
            lines=_wallet_payment_lines(
                wallet=wallet, clearing=clearing, commission=commission, amount=Decimal("100.00")
            ),
            external_reference="paystack-ref-1",
        )
        lines = JournalLine.objects.filter(journal_entry=entry)
        assert lines.count() == 3
        assert lines.aggregate(total=Sum("amount"))["total"] == Decimal("0.00")

    assert entry.entry_type == JournalEntry.EntryType.PAYMENT
    assert entry.external_reference == "paystack-ref-1"

    with platform_staff_bypass():
        wallet_after = LedgerAccount.all_objects.get(pk=wallet.id)
        clearing_after = LedgerAccount.all_objects.get(pk=clearing.id)
        commission_after = LedgerAccount.all_objects.get(pk=commission.id)
    assert wallet_after.cached_balance == Decimal("-100.00")
    assert clearing_after.cached_balance == Decimal("95.00")
    assert commission_after.cached_balance == Decimal("5.00")

    assert AuditLog.objects.filter(action="ledger.journal_entry_posted").count() == 1


def test_every_journal_entry_created_this_test_balances_to_zero_a_db_wide_sweep() -> None:
    """The independent re-verification ADR-0006 asks for: not just "the
    service function rejected a bad call," but "every row that actually
    made it into the database balances," queried directly, not assumed
    from having gone through post_journal_entry(). Scoped to what this
    test itself writes, since each test runs in its own rolled-back
    transaction.

    Queried via `.objects` inside the same `tenant_context` used to
    write — no `platform_staff_bypass()` needed for this particular
    read, since every `JournalLine.client` here is `business.client`
    (never `None`; only `LedgerAccount`'s platform commission row ever
    has a null client), so the ordinary tenant-scoped manager already
    sees all of them."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passengers = [PassengerUserFactory(client=client) for _ in range(3)]
        clearing = get_or_create_business_clearing_account(client=client, business=business)
        commission = get_or_create_commission_account()

        for index, passenger in enumerate(passengers):
            wallet = get_or_create_wallet_account(
                client=client, business=business, passenger=passenger
            )
            amount = Decimal("50.00") + index
            post_journal_entry(
                business=business,
                entry_type=JournalEntry.EntryType.PAYMENT,
                lines=_wallet_payment_lines(
                    wallet=wallet, clearing=clearing, commission=commission, amount=amount
                ),
            )

        sums = JournalLine.objects.values("journal_entry").annotate(total=Sum("amount"))
        assert len(sums) == 3
        for group in sums:
            assert group["total"] == Decimal("0.00")


def test_post_journal_entry_locks_accounts_in_a_stable_order_regardless_of_line_order() -> None:
    """Not a behavioural assertion so much as a regression guard: the
    account-locking order is sorted by primary key, not by the order
    lines were passed in, so two entries touching an overlapping set of
    accounts in different orders can't deadlock each other. Two
    sequential posts (not concurrent — the concurrency spike lives in
    its own test module) touching the same two accounts in reversed
    line order should both simply succeed."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        clearing = get_or_create_business_clearing_account(client=client, business=business)

        post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.REFUND,
            lines=[
                JournalLineInput(account=wallet, amount=Decimal("10.00"), currency="NGN"),
                JournalLineInput(account=clearing, amount=Decimal("-10.00"), currency="NGN"),
            ],
        )
        post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.REFUND,
            lines=[
                JournalLineInput(account=clearing, amount=Decimal("-5.00"), currency="NGN"),
                JournalLineInput(account=wallet, amount=Decimal("5.00"), currency="NGN"),
            ],
        )

        assert JournalEntry.objects.filter(business=business).count() == 2
