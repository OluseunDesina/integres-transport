import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business, KybDocument
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _upload(
    client_api: APIClient, business_id: str, document_type: str = "proof_of_address"
) -> object:
    upload = SimpleUploadedFile("doc.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    return client_api.post(
        reverse("business-kyb-document-upload", kwargs={"business_id": business_id}),
        {"document_type": document_type, "file": upload},
        format="multipart",
    )


def test_upload_transitions_pending_business_to_submitted() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _upload(_auth_client(staff), str(business.id))

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.SUBMITTED
    assert business.kyb_submitted_at is not None


def test_upload_transitions_rejected_business_back_to_submitted() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(
            client=client,
            kyb_status=Business.KybStatus.REJECTED,
            kyb_rejection_reason="blurry scan",
        )

    response = _upload(_auth_client(staff), str(business.id))

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.SUBMITTED


def test_upload_writes_an_audit_log_entry() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    _upload(_auth_client(staff), str(business.id))

    entry = AuditLog.objects.get(action="business.kyb_document_submitted")
    assert entry.client_id == client.id


def test_upload_requires_authentication() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _upload(APIClient(), str(business.id))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_passenger_cannot_upload_kyb_documents() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _upload(_auth_client(passenger), str(business.id))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_cannot_upload_to_another_clients_business() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)

    response = _upload(_auth_client(staff_a), str(business_b.id))
    assert response.status_code == status.HTTP_404_NOT_FOUND
    with tenant_context(None, is_platform_staff=True):
        assert KybDocument.all_objects.filter(business=business_b).count() == 0
