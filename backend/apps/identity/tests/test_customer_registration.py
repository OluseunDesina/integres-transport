"""POST /api/v1/auth/customer/register/ — passenger self-registration
under the singleton Marketplace Client (docs/adr/0009,
docs/specs/22-marketplace.md). Mirrors
apps.clients.tests.test_registration's shape for the analogous
Client-registration case."""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.clients.models import Client
from apps.clients.services import get_or_create_marketplace_client
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.tests.factories import PassengerUserFactory

pytestmark = pytest.mark.django_db

_TEST_EMAIL = "passenger@example.com"
_TEST_PASSWORD = "a-strong-unguessable-passphrase-42"  # noqa: S105  # nosec B105


def _register(**overrides: str) -> object:
    payload = {
        "email": _TEST_EMAIL,
        "password": _TEST_PASSWORD,
        "first_name": "Ada",
        **overrides,
    }
    return APIClient().post(reverse("customer-register"), payload)


def test_registration_creates_a_user_under_the_marketplace_client() -> None:
    response = _register()
    assert response.status_code == status.HTTP_201_CREATED

    marketplace_client = get_or_create_marketplace_client()
    user = User.objects.get(email=_TEST_EMAIL)
    assert user.client_id == marketplace_client.id
    assert user.is_client_staff is False
    assert user.is_platform_staff is False
    assert user.role_id is None

    access = AccessToken(response.data["access"])
    assert access["aud"] == "integra-customer-app"
    assert access["client_id"] == str(marketplace_client.id)


def test_registration_writes_an_audit_log_entry() -> None:
    _register()
    marketplace_client = get_or_create_marketplace_client()
    entry = AuditLog.objects.get(action="customer.registered")
    assert entry.client_id == marketplace_client.id
    assert entry.target_type == "User"


def test_duplicate_email_under_the_marketplace_client_is_rejected() -> None:
    first = _register()
    assert first.status_code == status.HTTP_201_CREATED

    second = _register(first_name="A Different Name")
    assert second.status_code == status.HTTP_400_BAD_REQUEST
    assert "email" in second.data


def test_same_email_already_used_by_an_operators_own_passenger_still_succeeds() -> None:
    """`unique_email_per_client` is (client, email), not email alone —
    the same address existing under some operator's own Client must not
    block marketplace registration."""
    operator_client = ClientFactory()
    with tenant_context(str(operator_client.id)):
        PassengerUserFactory(client=operator_client, email=_TEST_EMAIL)

    response = _register()

    assert response.status_code == status.HTTP_201_CREATED


def test_weak_password_is_rejected_via_auth_password_validators() -> None:
    response = _register(password="password")
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "password" in response.data


def test_registered_passenger_can_immediately_sign_in() -> None:
    _register()
    login = APIClient().post(
        reverse("customer-token-obtain"),
        {"email": _TEST_EMAIL, "password": _TEST_PASSWORD},  # noqa: S106  # nosec B106
    )
    assert login.status_code == status.HTTP_200_OK


def test_registration_endpoint_requires_no_authentication() -> None:
    response = _register()
    assert response.status_code != status.HTTP_401_UNAUTHORIZED


def test_get_or_create_marketplace_client_is_idempotent() -> None:
    first = get_or_create_marketplace_client()
    second = get_or_create_marketplace_client()

    assert first.id == second.id
    assert Client.objects.filter(is_marketplace=True).count() == 1
