"""Super-admin-only Paystack account config endpoint — mirrors
apps/businesses/tests/test_seat_hold.py's shape exactly."""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    SuperAdminTokenObtainSerializer,
)
from apps.identity.tests.factories import ClientStaffUserFactory, PlatformStaffUserFactory

from ..models import PaystackAccount

pytestmark = pytest.mark.django_db


def _auth_client(user: User, *, platform_staff: bool = False) -> APIClient:
    serializer_cls = (
        SuperAdminTokenObtainSerializer if platform_staff else ClientAdminTokenObtainSerializer
    )
    token = serializer_cls.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_platform_staff_can_configure_a_paystack_account_for_the_first_time() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).patch(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)}),
        {
            "bank_code": "058",
            "account_number": "0123456789",
            "account_name": "Test Business",
        },
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["bank_code"] == "058"
    assert response.data["is_active"] is True
    with tenant_context(str(client.id)):
        assert PaystackAccount.objects.filter(business=business).count() == 1
    entry = AuditLog.objects.get(action="paystack_account.configured")
    assert entry.target_id == response.data["id"]


def test_platform_staff_can_reconfigure_an_existing_paystack_account() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    platform_staff = PlatformStaffUserFactory()
    api = _auth_client(platform_staff, platform_staff=True)
    api.patch(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)}),
        {"bank_code": "058", "account_number": "0123456789", "account_name": "Original"},
    )

    response = api.patch(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)}),
        {"bank_code": "011", "account_number": "9876543210", "account_name": "Renamed"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["bank_code"] == "011"
    with tenant_context(str(client.id)):
        assert PaystackAccount.objects.filter(business=business).count() == 1
    assert AuditLog.objects.filter(action="paystack_account.updated").count() == 1


def test_client_admin_staff_cannot_configure_a_paystack_account() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).patch(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)}),
        {"bank_code": "058", "account_number": "0123456789", "account_name": "Test"},
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_unauthenticated_request_is_rejected() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = APIClient().patch(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)}),
        {"bank_code": "058", "account_number": "0123456789", "account_name": "Test"},
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_get_before_any_config_returns_a_distinct_not_configured_message() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)})
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert response.data["detail"] == "No Paystack account configured for this business yet."


def test_get_after_a_patch_returns_the_persisted_fields() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    platform_staff = PlatformStaffUserFactory()
    api = _auth_client(platform_staff, platform_staff=True)
    api.patch(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)}),
        {
            "bank_code": "058",
            "account_number": "0123456789",
            "account_name": "Test Business",
            "recipient_code": "RCP_test123",
        },
    )

    response = api.get(reverse("paystack-account-config", kwargs={"pk": str(business.id)}))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["bank_code"] == "058"
    assert response.data["recipient_code"] == "RCP_test123"


def test_get_requires_platform_staff() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).get(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)})
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_get_requires_authentication() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = APIClient().get(
        reverse("paystack-account-config", kwargs={"pk": str(business.id)})
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED
