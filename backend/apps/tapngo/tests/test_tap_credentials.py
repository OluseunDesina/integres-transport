import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory

from ..models import TapCredential
from ..services import issue_credential, revoke_credential
from .factories import TapCredentialFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


# --- issue_credential / revoke_credential (service-level) -----------------


def test_issue_credential_stores_only_the_hash_and_returns_the_raw_token_once() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        passenger = PassengerUserFactory(client=client)
        credential, token = issue_credential(passenger=passenger, channel="qr", label="My QR")

    assert len(token) > 20
    assert credential.token_hash != token
    entry = AuditLog.objects.get(action="tap_credential.issued")
    assert entry.target_id == str(credential.id)


def test_revoke_credential_deactivates_and_records_the_action() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        passenger = PassengerUserFactory(client=client)
        credential, _token = issue_credential(passenger=passenger, channel="nfc", label="")
        revoked = revoke_credential(credential=credential, revoked_by=passenger)

    assert revoked.is_active is False
    assert AuditLog.objects.filter(action="tap_credential.revoked").count() == 1


# --- POST /tap-credentials/ ---------------------------------------------


def test_passenger_can_issue_a_qr_credential() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).post(
        reverse("tap-credential-create"),
        {"channel": "qr", "label": "Phone QR"},
        format="json",
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["channel"] == "qr"
    assert response.data["label"] == "Phone QR"
    assert len(response.data["token"]) > 20
    with tenant_context(str(client.id)):
        credential = TapCredential.objects.get(pk=response.data["id"])
    assert credential.token_hash != response.data["token"]


def test_passenger_can_issue_an_nfc_credential() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).post(
        reverse("tap-credential-create"), {"channel": "nfc"}, format="json"
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["channel"] == "nfc"


def test_issue_credential_rejects_an_unauthenticated_request() -> None:
    response = APIClient().post(reverse("tap-credential-create"), {"channel": "qr"}, format="json")
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


# --- GET /tap-credentials/mine/ ------------------------------------------


def test_tap_credentials_mine_never_exposes_the_token() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        TapCredentialFactory(client=client, passenger=passenger, channel="qr")

    response = _auth_client(passenger).get(reverse("tap-credential-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 1
    assert "token" not in response.data["results"][0]


def test_tap_credentials_mine_lists_only_the_callers_own_credentials() -> None:
    client = ClientFactory()
    passenger_a = PassengerUserFactory(client=client)
    passenger_b = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        own = TapCredentialFactory(client=client, passenger=passenger_a)
        TapCredentialFactory(client=client, passenger=passenger_b)

    response = _auth_client(passenger_a).get(reverse("tap-credential-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(own.id)]


# --- PATCH /tap-credentials/{id}/ ----------------------------------------


def test_passenger_can_revoke_their_own_credential() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        credential = TapCredentialFactory(client=client, passenger=passenger)

    response = _auth_client(passenger).patch(
        reverse("tap-credential-update", kwargs={"pk": str(credential.id)}),
        {"is_active": False},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["is_active"] is False


def test_revoking_someone_elses_credential_is_forbidden() -> None:
    client = ClientFactory()
    owner = PassengerUserFactory(client=client)
    other = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        credential = TapCredentialFactory(client=client, passenger=owner)

    response = _auth_client(other).patch(
        reverse("tap-credential-update", kwargs={"pk": str(credential.id)}),
        {"is_active": False},
        format="json",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_reactivating_a_credential_is_rejected() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        credential = TapCredentialFactory(client=client, passenger=passenger, is_active=False)

    response = _auth_client(passenger).patch(
        reverse("tap-credential-update", kwargs={"pk": str(credential.id)}),
        {"is_active": True},
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
