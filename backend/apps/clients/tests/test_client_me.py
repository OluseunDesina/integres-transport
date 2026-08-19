import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.models import Client
from apps.clients.services import submit_kyc_document
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _owner_with_client() -> tuple[User, Client]:
    client = ClientFactory()
    roles = create_default_roles(client)
    owner = ClientStaffUserFactory(client=client, role=roles["Owner"])
    return owner, client


def test_returns_own_client_kyc_fields() -> None:
    owner, client = _owner_with_client()

    response = _auth_client(owner).get(reverse("client-me"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kyc_status"] == Client.KycStatus.PENDING
    assert response.data["kyc_submitted_at"] is None
    assert response.data["kyc_rejection_reason"] == ""
    assert response.data["documents"] == []


def test_documents_reflects_an_uploaded_kyc_document() -> None:
    owner, client = _owner_with_client()
    upload = SimpleUploadedFile("cert.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    with tenant_context(str(client.id)):
        submit_kyc_document(
            client=client,
            document_type="certificate_of_incorporation",
            file=upload,
            uploaded_by=owner,
        )

    response = _auth_client(owner).get(reverse("client-me"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["kyc_status"] == Client.KycStatus.SUBMITTED
    assert len(response.data["documents"]) == 1
    assert response.data["documents"][0]["document_type"] == "certificate_of_incorporation"


def test_passenger_is_forbidden() -> None:
    passenger = PassengerUserFactory()

    response = _auth_client(passenger).get(reverse("client-me"))

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_requires_authentication() -> None:
    response = APIClient().get(reverse("client-me"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_query_count_does_not_scale_with_document_count(django_assert_max_num_queries) -> None:
    """Phase 2 self-check: `GET /clients/me/` was the one new endpoint
    this phase added and had never had its query count checked (unlike
    every list/queue endpoint, which the Phase 1 self-check's N+1 sweep
    already covers). `ClientMeSerializer.get_documents` runs one
    `KycDocument.objects.filter(client=obj)` query regardless of how many
    documents exist — asserts that stays flat, not proportional."""
    owner, client = _owner_with_client()
    with tenant_context(str(client.id)):
        for i in range(5):
            upload = SimpleUploadedFile(
                f"cert{i}.pdf", b"%PDF-1.4 fake", content_type="application/pdf"
            )
            submit_kyc_document(
                client=client,
                document_type="certificate_of_incorporation",
                file=upload,
                uploaded_by=owner,
            )

    with django_assert_max_num_queries(10):
        response = _auth_client(owner).get(reverse("client-me"))

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["documents"]) == 5
