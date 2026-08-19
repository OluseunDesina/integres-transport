import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business, KybDocument
from apps.businesses.services import submit_kyb_document
from apps.businesses.tests.factories import BusinessFactory
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


def _submitted_business_with_document() -> Business:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    upload = SimpleUploadedFile("cert.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        submit_kyb_document(
            business=business,
            document_type="certificate_of_incorporation",
            file=upload,
            uploaded_by=staff,
        )
        business.refresh_from_db()
    return business


def test_queue_query_count_does_not_scale_with_business_count(
    django_assert_max_num_queries,
) -> None:
    """Regression test for an N+1 found during the Phase 1 self-check:
    `BusinessKybQueueSerializer.get_documents` and its `client_name`
    field each used to run one query per Business row. Fixed via a
    batched document lookup and `select_related("client")` — this
    asserts the query count stays flat, not proportional to row count."""
    platform_staff = PlatformStaffUserFactory()
    for _ in range(5):
        _submitted_business_with_document()

    with django_assert_max_num_queries(15):
        response = _auth_client(platform_staff, platform_staff=True).get(
            reverse("kyb-queue-list")
        )
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5


def test_queue_lists_only_submitted_businesses_with_client_context_and_documents() -> None:
    submitted = _submitted_business_with_document()
    with tenant_context(None, is_platform_staff=True):
        BusinessFactory(kyb_status=Business.KybStatus.PENDING)
        BusinessFactory(kyb_status=Business.KybStatus.APPROVED)
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(reverse("kyb-queue-list"))

    assert response.status_code == status.HTTP_200_OK
    ids = [row["id"] for row in response.data["results"]]
    assert ids == [str(submitted.id)]
    row = response.data["results"][0]
    assert row["client_name"] == submitted.client.name
    assert len(row["documents"]) == 1


def test_queue_requires_platform_staff() -> None:
    submitted = _submitted_business_with_document()
    staff = ClientStaffUserFactory(client=submitted.client)

    response = _auth_client(staff).get(reverse("kyb-queue-list"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_queue_requires_authentication() -> None:
    response = APIClient().get(reverse("kyb-queue-list"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_decide_approve_sets_status_and_is_audit_logged() -> None:
    business = _submitted_business_with_document()
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).post(
        reverse("kyb-queue-decide", kwargs={"business_id": str(business.id)}),
        {"decision": "approve"},
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(None, is_platform_staff=True):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.APPROVED
    assert business.kyb_decided_by_id == platform_staff.id
    assert business.kyb_decided_at is not None

    entry = AuditLog.objects.get(action="business.kyb_decided")
    assert entry.metadata["decision"] == "approve"


def test_decide_reject_requires_a_reason() -> None:
    business = _submitted_business_with_document()
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).post(
        reverse("kyb-queue-decide", kwargs={"business_id": str(business.id)}),
        {"decision": "reject"},
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "reason" in response.data


def test_full_create_reject_resubmit_reapprove_flow() -> None:
    business = _submitted_business_with_document()
    platform_staff = PlatformStaffUserFactory()
    queue_api = _auth_client(platform_staff, platform_staff=True)

    reject = queue_api.post(
        reverse("kyb-queue-decide", kwargs={"business_id": str(business.id)}),
        {"decision": "reject", "reason": "Missing tax certificate"},
    )
    assert reject.status_code == status.HTTP_200_OK
    with tenant_context(None, is_platform_staff=True):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.REJECTED

    staff = User.objects.get(client=business.client, is_client_staff=True)
    upload = SimpleUploadedFile("tax.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    with tenant_context(str(business.client_id)):
        submit_kyb_document(
            business=business, document_type="tax_certificate", file=upload, uploaded_by=staff
        )
        assert KybDocument.all_objects.filter(business=business).count() == 2
    with tenant_context(None, is_platform_staff=True):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.SUBMITTED

    approve = queue_api.post(
        reverse("kyb-queue-decide", kwargs={"business_id": str(business.id)}),
        {"decision": "approve"},
    )
    assert approve.status_code == status.HTTP_200_OK
    with tenant_context(None, is_platform_staff=True):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.APPROVED
    assert business.kyb_rejection_reason == ""
