from datetime import timedelta

import pytest
from django.core import mail
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.models import Client, ClientInvitation
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import Role, User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    SuperAdminTokenObtainSerializer,
)
from apps.identity.tests.factories import ClientStaffUserFactory, PlatformStaffUserFactory

pytestmark = pytest.mark.django_db


def _platform_client() -> tuple[User, APIClient]:
    staff = PlatformStaffUserFactory()
    token = SuperAdminTokenObtainSerializer.get_token(staff)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return staff, client


def test_invite_creates_a_pending_invitation_and_queues_email(
    django_capture_on_commit_callbacks,
) -> None:
    _, api = _platform_client()
    with django_capture_on_commit_callbacks(execute=True):
        response = api.post(
            reverse("client-invitation-create"),
            {"name": "Acme Shuttle Co", "email": "founder@acme.example.com"},
        )

    assert response.status_code == status.HTTP_201_CREATED
    invitation = ClientInvitation.objects.get(email="founder@acme.example.com")
    assert invitation.status == ClientInvitation.Status.PENDING
    assert invitation.token

    assert len(mail.outbox) == 1
    assert "founder@acme.example.com" in mail.outbox[0].to
    assert invitation.token in mail.outbox[0].body


def test_invite_writes_an_audit_log_entry(django_capture_on_commit_callbacks) -> None:
    _, api = _platform_client()
    with django_capture_on_commit_callbacks(execute=True):
        api.post(
            reverse("client-invitation-create"),
            {"name": "Acme Shuttle Co", "email": "founder@acme.example.com"},
        )
    assert AuditLog.objects.filter(action="client.invited").exists()


def test_non_platform_staff_cannot_invite_a_client() -> None:
    staff = ClientStaffUserFactory(client=ClientFactory())
    token = ClientAdminTokenObtainSerializer.get_token(staff)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")

    response = api.post(
        reverse("client-invitation-create"),
        {"name": "Acme Shuttle Co", "email": "founder@acme.example.com"},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_invite_rejects_an_email_already_registered_as_a_client() -> None:
    ClientFactory(email="taken@example.com")
    _, api = _platform_client()

    response = api.post(
        reverse("client-invitation-create"),
        {"name": "Acme Shuttle Co", "email": "taken@example.com"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "email" in response.data


def test_resolve_unknown_token_is_a_404() -> None:
    response = APIClient().get(
        reverse("client-invitation-resolve", kwargs={"token": "not-a-real-token"})
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_resolve_requires_no_authentication_and_returns_name_and_email() -> None:
    invitation = ClientInvitation.objects.create(
        name="Acme Shuttle Co",
        email="founder@acme.example.com",
        token="a-known-token",
        expires_at=timezone.now() + timedelta(days=7),
    )

    response = APIClient().get(
        reverse("client-invitation-resolve", kwargs={"token": invitation.token})
    )
    assert response.status_code == status.HTTP_200_OK
    assert response.data["name"] == "Acme Shuttle Co"
    assert response.data["email"] == "founder@acme.example.com"
    assert response.data["status"] == "pending"


def test_complete_produces_identical_state_to_direct_registration() -> None:
    invitation = ClientInvitation.objects.create(
        name="Acme Shuttle Co",
        email="founder@acme.example.com",
        token="complete-me-token",
        expires_at=timezone.now() + timedelta(days=7),
    )

    response = APIClient().post(
        reverse("client-invitation-complete", kwargs={"token": invitation.token}),
        {"phone": "+2348012345678", "password": "a-strong-unguessable-passphrase-42"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert "access" in response.data

    client = Client.objects.get(email="founder@acme.example.com")
    assert client.name == "Acme Shuttle Co"
    assert client.kyc_status == Client.KycStatus.PENDING
    owner = User.objects.get(email="founder@acme.example.com")
    assert owner.client_id == client.id
    assert owner.is_client_staff is True
    assert owner.role_id is not None
    with tenant_context(str(client.id)):
        assert Role.objects.get(pk=owner.role_id).name == "Owner"

    invitation.refresh_from_db()
    assert invitation.status == ClientInvitation.Status.ACCEPTED

    assert AuditLog.objects.filter(action="client.registered", client_id=client.id).exists()
    assert AuditLog.objects.filter(
        action="client.invitation_completed", client_id=client.id
    ).exists()


def test_complete_expired_invitation_is_rejected_clearly() -> None:
    invitation = ClientInvitation.objects.create(
        name="Acme Shuttle Co",
        email="toolate@example.com",
        token="expired-token",
        expires_at=timezone.now() - timedelta(days=1),
    )

    response = APIClient().post(
        reverse("client-invitation-complete", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-77"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "expired" in str(response.data["detail"]).lower()

    invitation.refresh_from_db()
    assert invitation.status == ClientInvitation.Status.EXPIRED


def test_complete_revoked_invitation_is_rejected_clearly() -> None:
    """No revoke endpoint exists yet (same deliberate gap as
    StaffInvitation in Slice 4) — constructing the revoked state directly
    to test the completion-side rejection."""
    invitation = ClientInvitation.objects.create(
        name="Acme Shuttle Co",
        email="revoked@example.com",
        token="revoked-token",
        status=ClientInvitation.Status.REVOKED,
        expires_at=timezone.now() + timedelta(days=7),
    )

    response = APIClient().post(
        reverse("client-invitation-complete", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-77"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "revoked" in str(response.data["detail"]).lower()


def test_complete_rejects_if_email_was_registered_directly_in_the_meantime() -> None:
    invitation = ClientInvitation.objects.create(
        name="Acme Shuttle Co",
        email="raced@example.com",
        token="race-token",
        expires_at=timezone.now() + timedelta(days=7),
    )
    ClientFactory(email="raced@example.com")

    response = APIClient().post(
        reverse("client-invitation-complete", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-77"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_complete_endpoint_requires_no_authentication() -> None:
    invitation = ClientInvitation.objects.create(
        name="Acme Shuttle Co",
        email="founder2@acme.example.com",
        token="no-auth-token",
        expires_at=timezone.now() + timedelta(days=7),
    )
    response = APIClient().post(
        reverse("client-invitation-complete", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-42"},
    )
    assert response.status_code != status.HTTP_401_UNAUTHORIZED
