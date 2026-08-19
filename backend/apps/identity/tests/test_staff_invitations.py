from datetime import timedelta

import pytest
from django.core import mail
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import StaffInvitation, User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _owner_with_client() -> tuple[User, dict[str, object]]:
    client = ClientFactory()
    roles = create_default_roles(client)
    owner = ClientStaffUserFactory(client=client, role=roles["Owner"])
    return owner, roles


def test_invite_creates_a_pending_invitation_and_queues_email(
    django_capture_on_commit_callbacks,
) -> None:
    owner, roles = _owner_with_client()
    with django_capture_on_commit_callbacks(execute=True):
        response = _auth_client(owner).post(
            reverse("staff-invitation-create"),
            {"email": "newhire@example.com", "role": str(roles["Staff"].id)},
        )

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(owner.client_id)):
        invitation = StaffInvitation.objects.get(email="newhire@example.com")
    assert invitation.status == StaffInvitation.Status.PENDING
    assert invitation.token

    assert len(mail.outbox) == 1
    assert "newhire@example.com" in mail.outbox[0].to
    assert invitation.token in mail.outbox[0].body


def test_invite_writes_an_audit_log_entry(django_capture_on_commit_callbacks) -> None:
    owner, roles = _owner_with_client()
    with django_capture_on_commit_callbacks(execute=True):
        _auth_client(owner).post(
            reverse("staff-invitation-create"),
            {"email": "newhire@example.com", "role": str(roles["Staff"].id)},
        )
    entry = AuditLog.objects.get(action="staff.invited")
    assert entry.client_id == owner.client_id


def test_cannot_invite_someone_already_a_member_of_the_same_client() -> None:
    owner, roles = _owner_with_client()
    ClientStaffUserFactory(client=owner.client, email="existing@example.com", role=roles["Staff"])

    response = _auth_client(owner).post(
        reverse("staff-invitation-create"),
        {"email": "existing@example.com", "role": str(roles["Staff"].id)},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "email" in response.data


def test_can_invite_someone_who_is_staff_at_a_different_client() -> None:
    owner, roles = _owner_with_client()
    other_client = ClientFactory()
    other_roles = create_default_roles(other_client)
    ClientStaffUserFactory(
        client=other_client, email="shared@example.com", role=other_roles["Staff"]
    )

    response = _auth_client(owner).post(
        reverse("staff-invitation-create"),
        {"email": "shared@example.com", "role": str(roles["Staff"].id)},
    )
    assert response.status_code == status.HTTP_201_CREATED


def test_non_inviter_role_cannot_invite_staff() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])

    response = _auth_client(staff).post(
        reverse("staff-invitation-create"),
        {"email": "newhire@example.com", "role": str(roles["Staff"].id)},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_resolve_unknown_token_is_a_404() -> None:
    response = APIClient().get(
        reverse("staff-invitation-resolve", kwargs={"token": "not-a-real-token"})
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_resolve_requires_no_authentication_and_returns_client_and_role_name() -> None:
    owner, roles = _owner_with_client()
    with tenant_context(str(owner.client_id)):
        invitation = StaffInvitation.objects.create(
            client=owner.client,
            email="newhire@example.com",
            role=roles["Staff"],
            invited_by=owner,
            token="a-known-token",
            expires_at=timezone.now() + timedelta(days=7),
        )

    response = APIClient().get(
        reverse("staff-invitation-resolve", kwargs={"token": invitation.token})
    )
    assert response.status_code == status.HTTP_200_OK
    assert response.data["client_name"] == owner.client.name
    assert response.data["role_name"] == "Staff"
    assert response.data["status"] == "pending"


def test_accept_creates_staff_user_with_correct_role_and_client() -> None:
    owner, roles = _owner_with_client()
    with tenant_context(str(owner.client_id)):
        invitation = StaffInvitation.objects.create(
            client=owner.client,
            email="newhire@example.com",
            role=roles["Manager"],
            invited_by=owner,
            token="accept-me-token",
            expires_at=timezone.now() + timedelta(days=7),
        )

    response = APIClient().post(
        reverse("staff-invitation-accept", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-77"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert "access" in response.data
    new_user = User.objects.get(email="newhire@example.com")
    assert new_user.client_id == owner.client_id
    assert new_user.is_client_staff is True
    with tenant_context(str(owner.client_id)):
        assert new_user.role_id == roles["Manager"].id
        invitation.refresh_from_db()
    assert invitation.status == StaffInvitation.Status.ACCEPTED


def test_accept_expired_invitation_is_rejected_clearly() -> None:
    owner, roles = _owner_with_client()
    with tenant_context(str(owner.client_id)):
        invitation = StaffInvitation.objects.create(
            client=owner.client,
            email="toolate@example.com",
            role=roles["Staff"],
            invited_by=owner,
            token="expired-token",
            expires_at=timezone.now() - timedelta(days=1),
        )

    response = APIClient().post(
        reverse("staff-invitation-accept", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-77"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "expired" in str(response.data["detail"]).lower()

    with tenant_context(str(owner.client_id)):
        invitation.refresh_from_db()
    assert invitation.status == StaffInvitation.Status.EXPIRED


def test_accept_revoked_invitation_is_rejected_clearly() -> None:
    """No revoke endpoint exists yet (spec gap, see plan) — constructing
    the revoked state directly to test the acceptance-side rejection."""
    owner, roles = _owner_with_client()
    with tenant_context(str(owner.client_id)):
        invitation = StaffInvitation.objects.create(
            client=owner.client,
            email="revoked@example.com",
            role=roles["Staff"],
            invited_by=owner,
            token="revoked-token",
            status=StaffInvitation.Status.REVOKED,
            expires_at=timezone.now() + timedelta(days=7),
        )

    response = APIClient().post(
        reverse("staff-invitation-accept", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-77"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "revoked" in str(response.data["detail"]).lower()


def test_accept_already_accepted_invitation_is_rejected_clearly() -> None:
    owner, roles = _owner_with_client()
    with tenant_context(str(owner.client_id)):
        invitation = StaffInvitation.objects.create(
            client=owner.client,
            email="already@example.com",
            role=roles["Staff"],
            invited_by=owner,
            token="already-token",
            status=StaffInvitation.Status.ACCEPTED,
            expires_at=timezone.now() + timedelta(days=7),
        )

    response = APIClient().post(
        reverse("staff-invitation-accept", kwargs={"token": invitation.token}),
        {"password": "a-strong-unguessable-passphrase-77"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_staff_list_query_count_does_not_scale_with_staff_count(
    django_assert_max_num_queries,
) -> None:
    """Regression test for an N+1 found during the Phase 1 self-check:
    `StaffSerializer`'s nested `role`/`role.permissions` used to run two
    queries per staff row. Fixed via `select_related("role")` +
    `prefetch_related("role__permissions")` — asserts the query count
    stays flat, not proportional to row count."""
    owner, roles = _owner_with_client()
    for _ in range(5):
        ClientStaffUserFactory(client=owner.client, role=roles["Staff"])

    with django_assert_max_num_queries(15):
        response = _auth_client(owner).get(reverse("staff-list"))
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 6


def test_staff_list_and_update() -> None:
    owner, roles = _owner_with_client()
    member = ClientStaffUserFactory(client=owner.client, role=roles["Staff"])

    listing = _auth_client(owner).get(reverse("staff-list"))
    assert listing.status_code == status.HTTP_200_OK
    emails = {row["email"] for row in listing.data["results"]}
    assert {owner.email, member.email} <= emails

    update = _auth_client(owner).patch(
        reverse("staff-update", kwargs={"user_id": str(member.id)}),
        {"role": str(roles["Manager"].id)},
    )
    assert update.status_code == status.HTTP_200_OK
    assert update.data["role"]["name"] == "Manager"

    deactivate = _auth_client(owner).patch(
        reverse("staff-update", kwargs={"user_id": str(member.id)}), {"is_active": False}
    )
    assert deactivate.status_code == status.HTTP_200_OK
    assert deactivate.data["is_active"] is False


def test_staff_list_requires_staff_manage_permission() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])

    response = _auth_client(staff).get(reverse("staff-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN
