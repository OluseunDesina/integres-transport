import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.clients.models import Client
from apps.core.models import AuditLog
from apps.identity.models import User

pytestmark = pytest.mark.django_db


def _register(**overrides: str) -> object:
    payload = {
        "name": "Acme Shuttle Co",
        "email": "owner@acme.example.com",
        "phone": "+2348012345678",
        "password": "a-strong-unguessable-passphrase-42",
        **overrides,
    }
    return APIClient().post(reverse("client-register"), payload)


def test_registration_creates_client_and_owner_and_returns_tokens() -> None:
    response = _register()
    assert response.status_code == status.HTTP_201_CREATED

    client = Client.objects.get(email="owner@acme.example.com")
    assert client.kyc_status == Client.KycStatus.PENDING
    owner = User.objects.get(email="owner@acme.example.com")
    assert owner.client_id == client.id
    assert owner.is_client_staff is True

    access = AccessToken(response.data["access"])
    assert access["aud"] == "integra-client-admin-app"
    assert access["client_id"] == str(client.id)


def test_registration_writes_an_audit_log_entry() -> None:
    _register()
    client = Client.objects.get(email="owner@acme.example.com")
    entry = AuditLog.objects.get(action="client.registered")
    assert entry.client_id == client.id
    assert entry.target_type == "Client"


def test_duplicate_client_email_is_rejected_with_a_clear_field_error() -> None:
    first = _register()
    assert first.status_code == status.HTTP_201_CREATED

    second = _register(name="A Different Name")
    assert second.status_code == status.HTTP_400_BAD_REQUEST
    assert "email" in second.data


def test_weak_password_is_rejected_via_auth_password_validators() -> None:
    response = _register(password="password")
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "password" in response.data


def test_registered_owner_can_immediately_sign_in() -> None:
    _register()
    login = APIClient().post(
        reverse("client-admin-token-obtain"),
        {"email": "owner@acme.example.com", "password": "a-strong-unguessable-passphrase-42"},
    )
    assert login.status_code == status.HTTP_200_OK


def test_registration_endpoint_requires_no_authentication() -> None:
    response = _register()
    assert response.status_code != status.HTTP_401_UNAUTHORIZED
