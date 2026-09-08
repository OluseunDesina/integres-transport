import datetime

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business, Director, KybDocument
from apps.businesses.services import submit_kyb_document
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
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


def test_queue_is_ordered_oldest_submission_first() -> None:
    """FIFO: the business waiting longest is reviewed first.

    Ordering is by `kyb_submitted_at`, not by `Business.Meta.ordering`'s
    inherited `-created_at` — a business registered long ago but
    submitted today used to sink below everything created after it,
    however long it had actually been waiting. This asserts the two
    facts are distinguishable by creating the rows in one order and
    submitting them in the reverse one.
    """
    platform_staff = PlatformStaffUserFactory()
    first_created = _submitted_business_with_document()
    second_created = _submitted_business_with_document()

    # Second-created submits first, so creation order and submission
    # order disagree — the only arrangement that can tell them apart.
    with platform_staff_bypass():
        second_created.kyb_submitted_at = timezone.now() - datetime.timedelta(days=3)
        second_created.save(update_fields=["kyb_submitted_at"])
        first_created.kyb_submitted_at = timezone.now()
        first_created.save(update_fields=["kyb_submitted_at"])

    response = _auth_client(platform_staff, platform_staff=True).get(reverse("kyb-queue-list"))

    assert response.status_code == status.HTTP_200_OK
    ids = [row["id"] for row in response.data["results"]]
    assert ids == [str(second_created.id), str(first_created.id)]


def test_queue_embeds_directors_so_a_reviewer_sees_who_they_are_approving() -> None:
    """docs/specs/11-kyb-directors.md — before this, director identity
    was only inferable from an ID document's filename."""
    business = _submitted_business_with_document()
    with tenant_context(str(business.client_id)):
        Director.objects.create(
            client=business.client,
            business=business,
            full_name="Ada Okafor",
            id_type="nin",
        )
        # Soft-removed directors are included deliberately: one may still
        # be attached to a document in this packet, and hiding them would
        # leave a reviewer looking at an ID whose owner had vanished.
        Director.objects.create(
            client=business.client,
            business=business,
            full_name="Bola Adeyemi",
            id_type="passport",
            is_active=False,
        )
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(
        reverse("kyb-queue-list")
    )

    assert response.status_code == status.HTTP_200_OK
    row = next(r for r in response.data["results"] if r["id"] == str(business.id))
    assert [d["full_name"] for d in row["directors"]] == ["Ada Okafor", "Bola Adeyemi"]


def test_queue_query_count_does_not_scale_with_director_count(
    django_assert_max_num_queries,
) -> None:
    """The sibling test above this one uses businesses with no directors,
    so it cannot catch a per-row director lookup — this one can. Same
    batching requirement `get_documents` already had."""
    platform_staff = PlatformStaffUserFactory()
    for _ in range(5):
        business = _submitted_business_with_document()
        with tenant_context(str(business.client_id)):
            for name in ("Ada Okafor", "Bola Adeyemi", "Chidi Nwosu"):
                Director.objects.create(
                    client=business.client,
                    business=business,
                    full_name=name,
                    id_type="nin",
                )

    with django_assert_max_num_queries(15):
        response = _auth_client(platform_staff, platform_staff=True).get(
            reverse("kyb-queue-list")
        )
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5
    assert all(len(row["directors"]) == 3 for row in response.data["results"])


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

    # The document itself never advanced past `pending` on its own — a
    # decision on the business is a decision on the bundle that earned
    # it. Approved businesses used to render every document as pending.
    with tenant_context(None, is_platform_staff=True):
        document = KybDocument.all_objects.get(business=business)
    assert document.status == KybDocument.Status.APPROVED
    assert document.reviewed_by_id == platform_staff.id
    assert document.reviewed_at is not None


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
    with tenant_context(None, is_platform_staff=True):
        rejected_document = KybDocument.all_objects.get(business=business)
    assert rejected_document.status == KybDocument.Status.REJECTED
    assert rejected_document.rejection_reason == "Missing tax certificate"

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

    # The first document was decided at the rejection — a later approval
    # must not silently relabel history onto it. Only the document
    # submitted afterwards belongs to this approval.
    with tenant_context(None, is_platform_staff=True):
        documents = {
            d.document_type: d for d in KybDocument.all_objects.filter(business=business)
        }
    assert documents["certificate_of_incorporation"].status == KybDocument.Status.REJECTED
    assert documents["tax_certificate"].status == KybDocument.Status.APPROVED
