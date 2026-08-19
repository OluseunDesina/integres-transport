"""transfer.success/transfer.failed webhook handling — Phase 5 Slice 3
(docs/specs/5-payments-wallet-ledger.md's "API surface > Slice 3"
webhook extension). Mirrors test_webhook_charge_success.py's/
test_webhook_edge_cases.py's shape: fire a real signed webhook POST at
apps.payments.views.PaystackWebhookView, then inspect the resulting
SettlementRun/WebhookEvent state directly."""

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory, PlatformStaffUserFactory
from apps.ledger.models import JournalEntry, SettlementRun
from apps.ledger.services import (
    JournalLineInput,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)

from ..models import WebhookEvent
from ..services import trigger_settlement_run
from .factories import PaystackAccountFactory
from .webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db

_FAKE_TRANSFER_DATA = {
    "transfer_code": "TRF_abc123",
    "reference": "irrelevant",
    "status": "pending",
}


def _processing_settlement_run(*, amount: Decimal = Decimal("100.00")) -> SettlementRun:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_123")
        wallet = get_or_create_wallet_account(
            client=client, business=business, passenger=PassengerUserFactory(client=client)
        )
        clearing = get_or_create_business_clearing_account(client=client, business=business)
        commission = get_or_create_commission_account()
        commission_cut = (amount * Decimal("0.05")).quantize(Decimal("0.01"))
        post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.PAYMENT,
            lines=[
                JournalLineInput(account=wallet, amount=-amount, currency="NGN"),
                JournalLineInput(account=clearing, amount=amount - commission_cut, currency="NGN"),
                JournalLineInput(account=commission, amount=commission_cut, currency="NGN"),
            ],
        )
    platform_staff = PlatformStaffUserFactory()
    today = date.today()
    with patch("apps.payments.services.initiate_transfer", return_value=dict(_FAKE_TRANSFER_DATA)):
        return trigger_settlement_run(
            business=business,
            period_start=today - timedelta(days=1),
            period_end=today + timedelta(days=2),
            initiated_by=platform_staff,
        )


def _post_webhook(*, event: str, reference: str) -> None:
    raw_body, signature = signed_body(paystack_payload(event=event, reference=reference))
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == status.HTTP_200_OK


def test_transfer_success_marks_the_run_paid_out() -> None:
    run = _processing_settlement_run()

    _post_webhook(event="transfer.success", reference=run.psp_transfer_reference)

    with platform_staff_bypass():
        run.refresh_from_db()
        event = _webhook_event(reference=run.psp_transfer_reference, event_type="transfer.success")
    assert run.status == SettlementRun.Status.PAID_OUT
    assert run.executed_at is not None
    assert run.psp_transfer_status == "success"
    assert event.processing_status == event.ProcessingStatus.PROCESSED


def test_transfer_failed_marks_the_run_failed() -> None:
    run = _processing_settlement_run()

    _post_webhook(event="transfer.failed", reference=run.psp_transfer_reference)

    with platform_staff_bypass():
        run.refresh_from_db()
    assert run.status == SettlementRun.Status.FAILED
    assert run.executed_at is None
    assert run.psp_transfer_status == "failed"


def test_transfer_success_for_an_unknown_reference_is_ignored() -> None:
    _post_webhook(event="transfer.success", reference="no-such-reference")

    with platform_staff_bypass():
        event = _webhook_event(reference="no-such-reference", event_type="transfer.success")
    assert event.processing_status == event.ProcessingStatus.IGNORED


def test_transfer_success_delivered_twice_is_deduped_by_webhook_event() -> None:
    """Edge case 7: a byte-identical replayed delivery for the same
    `(provider, reference, event_type)` is deduped by `WebhookEvent`'s
    own unique constraint before dispatch even runs a second time — one
    `WebhookEvent` row, one `paid_out` transition."""
    run = _processing_settlement_run()

    _post_webhook(event="transfer.success", reference=run.psp_transfer_reference)
    with platform_staff_bypass():
        run.refresh_from_db()
    executed_at_first = run.executed_at

    _post_webhook(event="transfer.success", reference=run.psp_transfer_reference)

    with platform_staff_bypass():
        run.refresh_from_db()
        events = list(
            _webhook_events(reference=run.psp_transfer_reference, event_type="transfer.success")
        )
    assert len(events) == 1, "WebhookEvent's unique constraint should dedup the replay"
    assert run.executed_at == executed_at_first


def _webhook_event(*, reference: str, event_type: str) -> WebhookEvent:
    return WebhookEvent.objects.get(reference=reference, event_type=event_type)


def _webhook_events(*, reference: str, event_type: str):  # type: ignore[no-untyped-def]
    return WebhookEvent.objects.filter(reference=reference, event_type=event_type)
