"""HTTP-level tests for GET/POST /settlement-runs/ — Phase 5 Slice 3.
Mirrors test_paystack_account_config.py's IsPlatformStaff-gating shape
exactly."""

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    SuperAdminTokenObtainSerializer,
)
from apps.identity.tests.factories import (
    ClientStaffUserFactory,
    PassengerUserFactory,
    PlatformStaffUserFactory,
)
from apps.ledger.models import JournalEntry
from apps.ledger.services import (
    JournalLineInput,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)

from .factories import PaystackAccountFactory

pytestmark = pytest.mark.django_db

_FAKE_TRANSFER_DATA = {
    "transfer_code": "TRF_abc123",
    "reference": "irrelevant",
    "status": "pending",
}


def _auth_client(user: User, *, platform_staff: bool = False) -> APIClient:
    serializer_cls = (
        SuperAdminTokenObtainSerializer if platform_staff else ClientAdminTokenObtainSerializer
    )
    token = serializer_cls.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _today_period() -> tuple[str, str]:
    today = date.today()
    return (today - timedelta(days=1)).isoformat(), (today + timedelta(days=2)).isoformat()


def test_post_settlement_runs_requires_platform_staff() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    period_start, period_end = _today_period()

    response = _auth_client(staff).post(
        reverse("settlement-run-list-create"),
        {"business": str(business.id), "period_start": period_start, "period_end": period_end},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_post_settlement_runs_rejects_a_passenger_token() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    period_start, period_end = _today_period()

    response = _auth_client(passenger).post(
        reverse("settlement-run-list-create"),
        {"business": str(business.id), "period_start": period_start, "period_end": period_end},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_post_settlement_runs_triggers_a_real_payout_for_platform_staff() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business, recipient_code="RCP_123")
        wallet = get_or_create_wallet_account(
            client=client, business=business, passenger=PassengerUserFactory(client=client)
        )
        clearing = get_or_create_business_clearing_account(client=client, business=business)
        commission = get_or_create_commission_account()
        post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.PAYMENT,
            lines=[
                JournalLineInput(account=wallet, amount=Decimal("-100.00"), currency="NGN"),
                JournalLineInput(account=clearing, amount=Decimal("95.00"), currency="NGN"),
                JournalLineInput(account=commission, amount=Decimal("5.00"), currency="NGN"),
            ],
        )
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with patch("apps.payments.services.initiate_transfer", return_value=dict(_FAKE_TRANSFER_DATA)):
        response = _auth_client(platform_staff, platform_staff=True).post(
            reverse("settlement-run-list-create"),
            {
                "business": str(business.id),
                "period_start": period_start,
                "period_end": period_end,
            },
        )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["status"] == "processing"
    assert response.data["total_amount"] == "95.00"


def test_post_settlement_runs_returns_404_without_a_configured_payout_destination() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    response = _auth_client(platform_staff, platform_staff=True).post(
        reverse("settlement-run-list-create"),
        {"business": str(business.id), "period_start": period_start, "period_end": period_end},
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_get_settlement_runs_filters_by_business() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business_a = BusinessFactory(client=client)
        business_b = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business_a, recipient_code="RCP_a")
        PaystackAccountFactory(client=client, business=business_b, recipient_code="RCP_b")
    platform_staff = PlatformStaffUserFactory()
    period_start, period_end = _today_period()

    with patch("apps.payments.services.initiate_transfer", return_value=dict(_FAKE_TRANSFER_DATA)):
        api = _auth_client(platform_staff, platform_staff=True)
        api.post(
            reverse("settlement-run-list-create"),
            {
                "business": str(business_a.id),
                "period_start": period_start,
                "period_end": period_end,
            },
        )
        api.post(
            reverse("settlement-run-list-create"),
            {
                "business": str(business_b.id),
                "period_start": period_start,
                "period_end": period_end,
            },
        )

    response = _auth_client(platform_staff, platform_staff=True).get(
        reverse("settlement-run-list-create"), {"business": str(business_a.id)}
    )
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 1
    assert str(response.data["results"][0]["business"]) == str(business_a.id)


def test_post_settlement_runs_rejects_period_start_not_before_period_end() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    platform_staff = PlatformStaffUserFactory()
    today = date.today().isoformat()

    response = _auth_client(platform_staff, platform_staff=True).post(
        reverse("settlement-run-list-create"),
        {"business": str(business.id), "period_start": today, "period_end": today},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
