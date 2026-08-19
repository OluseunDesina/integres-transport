import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.models import WhiteLabelConfig
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _owner_with_client() -> User:
    client = ClientFactory()
    roles = create_default_roles(client)
    return ClientStaffUserFactory(client=client, role=roles["Owner"])


def test_get_creates_a_default_config_on_first_access() -> None:
    owner = _owner_with_client()
    with tenant_context(str(owner.client_id)):
        assert not WhiteLabelConfig.objects.filter(client=owner.client).exists()

    response = _auth_client(owner).get(reverse("white-label"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["domain"] == ""
    with tenant_context(str(owner.client_id)):
        assert WhiteLabelConfig.objects.filter(client=owner.client).exists()


def test_patch_updates_fields_and_writes_an_audit_log_entry() -> None:
    owner = _owner_with_client()

    response = _auth_client(owner).patch(
        reverse("white-label"),
        {"domain": "acme.integra-afc.example.com", "primary_color": "#112233"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["domain"] == "acme.integra-afc.example.com"
    assert response.data["primary_color"] == "#112233"
    assert AuditLog.objects.filter(action="white_label.updated", client_id=owner.client_id).exists()


def test_non_whitelabel_manage_role_is_forbidden() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    manager = ClientStaffUserFactory(client=client, role=roles["Manager"])

    response = _auth_client(manager).get(reverse("white-label"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_resolve_returns_branding_for_a_known_domain() -> None:
    owner = _owner_with_client()
    _auth_client(owner).patch(
        reverse("white-label"),
        {"domain": "acme.integra-afc.example.com", "primary_color": "#112233"},
    )

    response = APIClient().get(
        reverse("white-label-resolve"), HTTP_HOST="acme.integra-afc.example.com"
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["client_id"] == str(owner.client_id)
    assert response.data["primary_color"] == "#112233"


def test_resolve_returns_404_for_an_unknown_domain() -> None:
    response = APIClient().get(
        reverse("white-label-resolve"), HTTP_HOST="unknown.integra-afc.example.com"
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_resolve_requires_no_authentication() -> None:
    response = APIClient().get(
        reverse("white-label-resolve"), HTTP_HOST="unknown.integra-afc.example.com"
    )
    assert response.status_code != status.HTTP_401_UNAUTHORIZED
