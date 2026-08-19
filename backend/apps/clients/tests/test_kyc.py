import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.models import Client, KycDocument
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _upload(client_api: APIClient, document_type: str = "proof_of_address") -> object:
    upload = SimpleUploadedFile("doc.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    return client_api.post(
        reverse("client-kyc-document-upload"),
        {"document_type": document_type, "file": upload},
        format="multipart",
    )


def test_upload_transitions_pending_client_to_submitted() -> None:
    client = ClientFactory(kyc_status=Client.KycStatus.PENDING)
    staff = ClientStaffUserFactory(client=client)

    response = _upload(_auth_client(staff))

    assert response.status_code == status.HTTP_201_CREATED
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.SUBMITTED
    assert client.kyc_submitted_at is not None


def test_upload_transitions_rejected_client_back_to_submitted() -> None:
    client = ClientFactory(
        kyc_status=Client.KycStatus.REJECTED, kyc_rejection_reason="blurry scan"
    )
    staff = ClientStaffUserFactory(client=client)

    response = _upload(_auth_client(staff))

    assert response.status_code == status.HTTP_201_CREATED
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.SUBMITTED


def test_second_upload_while_already_submitted_does_not_reset_timestamp() -> None:
    client = ClientFactory(kyc_status=Client.KycStatus.PENDING)
    staff = ClientStaffUserFactory(client=client)
    api = _auth_client(staff)

    _upload(api)
    client.refresh_from_db()
    first_submitted_at = client.kyc_submitted_at

    _upload(api, document_type="tax_certificate")
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.SUBMITTED
    assert client.kyc_submitted_at == first_submitted_at
    assert KycDocument.objects.count() == 0  # scoped manager, no active context outside request
    assert KycDocument.all_objects.filter(client=client).count() == 2


def test_upload_writes_an_audit_log_entry() -> None:
    client = ClientFactory(kyc_status=Client.KycStatus.PENDING)
    staff = ClientStaffUserFactory(client=client)

    _upload(_auth_client(staff))

    entry = AuditLog.objects.get(action="client.kyc_document_submitted")
    assert entry.client_id == client.id


def test_upload_requires_authentication() -> None:
    response = _upload(APIClient())
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_passenger_cannot_upload_kyc_documents() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    response = _upload(_auth_client(passenger))
    assert response.status_code == status.HTTP_403_FORBIDDEN
