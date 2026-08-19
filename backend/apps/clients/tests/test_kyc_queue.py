import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.models import Client, KycDocument
from apps.clients.services import submit_kyc_document
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    SuperAdminTokenObtainSerializer,
)
from apps.identity.tests.factories import ClientStaffUserFactory, PlatformStaffUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User, *, platform_staff: bool = False) -> APIClient:
    serializer_cls = (
        SuperAdminTokenObtainSerializer if platform_staff else ClientAdminTokenObtainSerializer
    )
    token = serializer_cls.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _submitted_client_with_document() -> Client:
    client = ClientFactory(kyc_status=Client.KycStatus.PENDING)
    staff = ClientStaffUserFactory(client=client)
    upload = SimpleUploadedFile("cert.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    with tenant_context(str(client.id)):
        submit_kyc_document(
            client=client,
            document_type="certificate_of_incorporation",
            file=upload,
            uploaded_by=staff,
        )
    client.refresh_from_db()
    return client


def test_queue_query_count_does_not_scale_with_client_count(
    django_assert_max_num_queries,
) -> None:
    """Regression test for an N+1 found during the Phase 1 self-check:
    `ClientKycQueueSerializer.get_documents` used to run one query per
    Client row. Fixed by batching into a single query per page — this
    asserts the query count stays flat, not proportional to row count."""
    platform_staff = PlatformStaffUserFactory()
    for _ in range(5):
        _submitted_client_with_document()

    with django_assert_max_num_queries(15):
        response = _auth_client(platform_staff, platform_staff=True).get(
            reverse("kyc-queue-list")
        )
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5


def test_queue_lists_only_submitted_clients_with_their_documents() -> None:
    submitted = _submitted_client_with_document()
    ClientFactory(kyc_status=Client.KycStatus.PENDING)
    ClientFactory(kyc_status=Client.KycStatus.APPROVED)
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(reverse("kyc-queue-list"))

    assert response.status_code == status.HTTP_200_OK
    ids = [row["id"] for row in response.data["results"]]
    assert ids == [str(submitted.id)]
    assert len(response.data["results"][0]["documents"]) == 1


def test_queue_requires_platform_staff() -> None:
    submitted = _submitted_client_with_document()
    staff = ClientStaffUserFactory(client=submitted)

    response = _auth_client(staff).get(reverse("kyc-queue-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_queue_requires_authentication() -> None:
    response = APIClient().get(reverse("kyc-queue-list"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_decide_approve_sets_status_and_is_audit_logged() -> None:
    client = _submitted_client_with_document()
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).post(
        reverse("kyc-queue-decide", kwargs={"client_id": str(client.id)}),
        {"decision": "approve"},
    )

    assert response.status_code == status.HTTP_200_OK
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.APPROVED
    assert client.kyc_decided_by_id == platform_staff.id
    assert client.kyc_decided_at is not None

    entry = AuditLog.objects.get(action="client.kyc_decided")
    assert entry.metadata["decision"] == "approve"


def test_decide_reject_requires_a_reason() -> None:
    client = _submitted_client_with_document()
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).post(
        reverse("kyc-queue-decide", kwargs={"client_id": str(client.id)}),
        {"decision": "reject"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "reason" in response.data


def test_decide_reject_with_reason_sets_rejection_reason() -> None:
    client = _submitted_client_with_document()
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).post(
        reverse("kyc-queue-decide", kwargs={"client_id": str(client.id)}),
        {"decision": "reject", "reason": "Certificate illegible"},
    )
    assert response.status_code == status.HTTP_200_OK
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.REJECTED
    assert client.kyc_rejection_reason == "Certificate illegible"


def test_full_register_reject_resubmit_reapprove_flow() -> None:
    client = _submitted_client_with_document()
    platform_staff = PlatformStaffUserFactory()
    queue_api = _auth_client(platform_staff, platform_staff=True)

    reject = queue_api.post(
        reverse("kyc-queue-decide", kwargs={"client_id": str(client.id)}),
        {"decision": "reject", "reason": "Missing tax certificate"},
    )
    assert reject.status_code == status.HTTP_200_OK
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.REJECTED

    staff = User.objects.get(client=client, is_client_staff=True)
    upload = SimpleUploadedFile("tax.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    with tenant_context(str(client.id)):
        submit_kyc_document(
            client=client, document_type="tax_certificate", file=upload, uploaded_by=staff
        )
        # RLS resets to anonymous outside this block — assert while still
        # in a permitted session, not after.
        assert KycDocument.all_objects.filter(client=client).count() == 2
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.SUBMITTED

    approve = queue_api.post(
        reverse("kyc-queue-decide", kwargs={"client_id": str(client.id)}),
        {"decision": "approve"},
    )
    assert approve.status_code == status.HTTP_200_OK
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.APPROVED
    assert client.kyc_rejection_reason == ""
