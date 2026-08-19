"""apps.payments.services.trigger_settlement_run() — Phase 5 Slice 3
(docs/specs/5-payments-wallet-ledger.md's "API surface > Slice 3" and
edge case 10). Seeds real, unsettled JournalEntry rows the same way
apps.ledger.tests.test_ledger_invariants does (via post_journal_entry
directly, not through the payments webhook flow, to keep control over
exactly how many entries exist and their business_clearing share)."""

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory, PlatformStaffUserFactory
from apps.ledger.models import JournalEntry, LedgerAccount, SettlementRun
from apps.ledger.services import (
    JournalLineInput,
    SettlementRunAlreadyExists,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)

from ..psp.paystack import PaystackAPIError
from ..services import PayoutDestinationNotConfigured, trigger_settlement_run
from .factories import PaystackAccountFactory

pytestmark = pytest.mark.django_db

_FAKE_TRANSFER_DATA = {
    "transfer_code": "TRF_abc123",
    "reference": "irrelevant",
    "status": "pending",
}


def _post_unsettled_payment_entry(*, business, amount: Decimal) -> JournalEntry:
    """One real, balanced three-line PAYMENT entry crediting the
    Business's clearing account — the exact shape
    `_handle_charge_success` posts, built directly via
    `post_journal_entry` so the test controls the amount precisely."""
    wallet = get_or_create_wallet_account(
        client=business.client,
        business=business,
        passenger=PassengerUserFactory(client=business.client),
    )
    clearing = get_or_create_business_clearing_account(client=business.client, business=business)
    commission = get_or_create_commission_account()
    commission_cut = (amount * Decimal("0.05")).quantize(Decimal("0.01"))
    clearing_share = amount - commission_cut
    return post_journal_entry(
        business=business,
        entry_type=JournalEntry.EntryType.PAYMENT,
        lines=[
            JournalLineInput(account=wallet, amount=-amount, currency="NGN"),
            JournalLineInput(account=clearing, amount=clearing_share, currency="NGN"),
            JournalLineInput(account=commission, amount=commission_cut, currency="NGN"),
        ],
    )


def _today_period() -> tuple[date, date]:
    # Widened a day on each side of "today" (not freezegun-pinned — no
    # existing precedent for it in this codebase) so a test running
    # close to a UTC/Africa-Lagos day boundary can't flake: the
    # entry's real `created_at` just needs to land somewhere inside
    # this window, not exactly on "today".
    today = date.today()
    return today - timedelta(days=1), today + timedelta(days=2)


def test_trigger_settlement_run_happy_path_claims_entries_and_calls_paystack_transfer() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_123")
        entry = _post_unsettled_payment_entry(business=business, amount=Decimal("200.00"))
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with patch(
        "apps.payments.services.initiate_transfer", return_value=dict(_FAKE_TRANSFER_DATA)
    ) as mock_transfer:
        run = trigger_settlement_run(
            business=business,
            period_start=period_start,
            period_end=period_end,
            initiated_by=platform_staff,
        )

    mock_transfer.assert_called_once()
    assert run.status == run.Status.PROCESSING
    assert run.psp_transfer_reference
    assert run.psp_transfer_status == "pending"
    assert run.total_amount == Decimal("190.00")  # 200.00 - 5% commission

    with platform_staff_bypass():
        entry.refresh_from_db()
    assert entry.settlement_run_id == run.id


def test_trigger_settlement_run_raises_404_equivalent_without_a_configured_recipient_code() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        # is_active PaystackAccount exists, but recipient_code was never
        # PATCHed in — distinct from PspNotConfigured (no account at all).
        PaystackAccountFactory(client=client, business=business, recipient_code="")
        _post_unsettled_payment_entry(business=business, amount=Decimal("100.00"))
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with pytest.raises(PayoutDestinationNotConfigured):
        trigger_settlement_run(
            business=business,
            period_start=period_start,
            period_end=period_end,
            initiated_by=platform_staff,
        )

    with platform_staff_bypass():
        assert not SettlementRun.all_objects.filter(business=business).exists()


def test_trigger_settlement_run_short_circuits_to_paid_out_when_nothing_is_unsettled() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_123")
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with patch("apps.payments.services.initiate_transfer") as mock_transfer:
        run = trigger_settlement_run(
            business=business,
            period_start=period_start,
            period_end=period_end,
            initiated_by=platform_staff,
        )

    mock_transfer.assert_not_called()
    assert run.status == run.Status.PAID_OUT
    assert run.total_amount == Decimal("0.00")
    assert run.executed_at is not None
    assert run.psp_transfer_reference == ""


def test_trigger_settlement_run_rolls_back_the_claim_when_the_transfer_call_fails() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_123")
        entry = _post_unsettled_payment_entry(business=business, amount=Decimal("300.00"))
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with (
        patch("apps.payments.services.initiate_transfer", side_effect=PaystackAPIError("down")),
        pytest.raises(PaystackAPIError),
    ):
        trigger_settlement_run(
            business=business,
            period_start=period_start,
            period_end=period_end,
            initiated_by=platform_staff,
        )

    with platform_staff_bypass():
        assert not SettlementRun.all_objects.filter(business=business).exists()
        entry.refresh_from_db()
    assert entry.settlement_run_id is None, "a rolled-back trigger must leave entries unclaimed"


def test_trigger_settlement_run_rejects_a_duplicate_period() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_123")
        _post_unsettled_payment_entry(business=business, amount=Decimal("50.00"))
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with patch("apps.payments.services.initiate_transfer", return_value=dict(_FAKE_TRANSFER_DATA)):
        trigger_settlement_run(
            business=business,
            period_start=period_start,
            period_end=period_end,
            initiated_by=platform_staff,
        )

        with pytest.raises(SettlementRunAlreadyExists):
            trigger_settlement_run(
                business=business,
                period_start=period_start,
                period_end=period_end,
                initiated_by=platform_staff,
            )


def test_wallet_debit_balances_the_clearing_credit_regardless_of_settlement() -> None:
    """Sanity check that claiming/settling never touches LedgerAccount
    balances themselves (docs/specs's own "named gap, not solved":
    settling only tags entries, it does not write a reversing entry) —
    the clearing account's cached_balance is unchanged by triggering a
    settlement run."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_123")
        _post_unsettled_payment_entry(business=business, amount=Decimal("80.00"))
        clearing_before = get_or_create_business_clearing_account(
            client=client, business=business
        ).cached_balance
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with patch("apps.payments.services.initiate_transfer", return_value=dict(_FAKE_TRANSFER_DATA)):
        trigger_settlement_run(
            business=business,
            period_start=period_start,
            period_end=period_end,
            initiated_by=platform_staff,
        )

    with platform_staff_bypass():
        clearing_after = LedgerAccount.all_objects.get(
            business=business, account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
        )
    assert clearing_after.cached_balance == clearing_before
