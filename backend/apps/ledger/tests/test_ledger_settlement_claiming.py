"""apps.ledger.services.claim_settlement_run() — Phase 5 Slice 3
(docs/specs/5-payments-wallet-ledger.md's edge cases 10-11). Narrow
unit coverage of the claiming logic itself; the mandatory concurrency
spike for edge case 10 lives in
apps/payments/tests/test_settlement_run_concurrency.py, since the
orchestration it exercises (the Paystack Transfer call, the
recipient-code precondition) is owned by apps.payments, not here."""

from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.db import IntegrityError
from django.utils import timezone

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory, PlatformStaffUserFactory

from ..models import JournalEntry, LedgerAccount
from ..services import (
    JournalLineInput,
    SettlementRunAlreadyExists,
    claim_settlement_run,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)

pytestmark = pytest.mark.django_db


def _post_payment(*, business, amount: Decimal, created_at=None) -> JournalEntry:  # type: ignore[no-untyped-def]
    wallet = get_or_create_wallet_account(
        client=business.client,
        business=business,
        passenger=PassengerUserFactory(client=business.client),
    )
    clearing = get_or_create_business_clearing_account(client=business.client, business=business)
    commission = get_or_create_commission_account()
    commission_cut = (amount * Decimal("0.05")).quantize(Decimal("0.01"))
    entry = post_journal_entry(
        business=business,
        entry_type=JournalEntry.EntryType.PAYMENT,
        lines=[
            JournalLineInput(account=wallet, amount=-amount, currency="NGN"),
            JournalLineInput(account=clearing, amount=amount - commission_cut, currency="NGN"),
            JournalLineInput(account=commission, amount=commission_cut, currency="NGN"),
        ],
    )
    if created_at is not None:
        JournalEntry.all_objects.filter(pk=entry.pk).update(created_at=created_at)
        entry.refresh_from_db()
    return entry


def _period() -> tuple[date, date]:
    today = date.today()
    return today - timedelta(days=1), today + timedelta(days=2)


def test_claim_settlement_run_claims_only_entries_within_the_window() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        inside = _post_payment(business=business, amount=Decimal("100.00"))
        far_future = timezone.now() + timedelta(days=30)
        outside = _post_payment(business=business, amount=Decimal("50.00"), created_at=far_future)
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _period()

    run = claim_settlement_run(
        business=business,
        period_start=period_start,
        period_end=period_end,
        initiated_by=platform_staff,
    )

    with platform_staff_bypass():
        inside.refresh_from_db()
        outside.refresh_from_db()
    assert inside.settlement_run_id == run.id
    assert outside.settlement_run_id is None


def test_claim_settlement_run_never_reclaims_an_already_claimed_entry() -> None:
    """Edge case 11: two *overlapping* periods both nominally cover the
    same entry's `created_at` — the second claim must find it already
    claimed (`settlement_run__isnull=True` in the claiming query, "by
    construction", not a pre-check) rather than double-claiming it."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        entry = _post_payment(business=business, amount=Decimal("100.00"))
    platform_staff = PlatformStaffUserFactory()
    today = date.today()
    window_a = (today - timedelta(days=1), today + timedelta(days=2))
    # Overlaps window_a (both include "now"), but is a distinct
    # (business, period) pair so it doesn't collide with the unique
    # constraint — the entry is only excluded by its own
    # settlement_run FK already being set, not by the periods matching.
    window_b = (today, today + timedelta(days=3))

    first_run = claim_settlement_run(
        business=business,
        period_start=window_a[0],
        period_end=window_a[1],
        initiated_by=platform_staff,
    )
    with platform_staff_bypass():
        entry.refresh_from_db()
    assert entry.settlement_run_id == first_run.id

    second_run = claim_settlement_run(
        business=business,
        period_start=window_b[0],
        period_end=window_b[1],
        initiated_by=platform_staff,
    )
    assert second_run.total_amount == Decimal("0.00")
    with platform_staff_bypass():
        entry.refresh_from_db()
    assert entry.settlement_run_id == first_run.id, (
        "already-claimed entries must never be reclaimed"
    )


def test_claim_settlement_run_total_amount_sums_only_the_clearing_account_lines() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        _post_payment(business=business, amount=Decimal("200.00"))
        _post_payment(business=business, amount=Decimal("300.00"))
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _period()

    run = claim_settlement_run(
        business=business,
        period_start=period_start,
        period_end=period_end,
        initiated_by=platform_staff,
    )

    # 200.00 - 10.00 commission + 300.00 - 15.00 commission = 475.00 —
    # never 200.00 + 300.00 (which would double-count the wallet-debit/
    # commission-credit lines from the same entries).
    assert run.total_amount == Decimal("475.00")
    with platform_staff_bypass():
        clearing = LedgerAccount.all_objects.get(
            business=business, account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
        )
    assert run.total_amount == clearing.cached_balance


def test_claim_settlement_run_raises_settlement_run_already_exists_for_a_duplicate_period() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        _post_payment(business=business, amount=Decimal("100.00"))
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _period()

    claim_settlement_run(
        business=business,
        period_start=period_start,
        period_end=period_end,
        initiated_by=platform_staff,
    )

    with pytest.raises(SettlementRunAlreadyExists) as exc_info:
        claim_settlement_run(
            business=business,
            period_start=period_start,
            period_end=period_end,
            initiated_by=platform_staff,
        )
    assert not isinstance(exc_info.value, IntegrityError), "must not leak the raw IntegrityError"
