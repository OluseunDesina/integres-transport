"""Director CRUD and the document→director link — docs/specs/11-kyb-directors.md."""

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db.models import ProtectedError
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business, Director, KybDocument
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


def _payload(**overrides: str) -> dict[str, str]:
    return {
        "full_name": "Ada Okafor",
        "id_type": "nin",
        "id_number": "12345678901",
        **overrides,
    }


def _list_url(business_id: str) -> str:
    return reverse("business-director-list-create", kwargs={"business_id": business_id})


# --- create / list -------------------------------------------------------


def test_client_staff_can_add_a_director() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).post(_list_url(str(business.id)), _payload())

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["full_name"] == "Ada Okafor"
    assert response.data["is_active"] is True
    with tenant_context(str(client.id)):
        director = Director.objects.get(pk=response.data["id"])
    assert director.business_id == business.id
    assert director.client_id == client.id


def test_a_business_can_have_several_directors() -> None:
    """The reason this is its own model rather than fields on Business —
    Nigerian CAC filings routinely list two or more."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    api = _auth_client(staff)

    first = api.post(_list_url(str(business.id)), _payload(full_name="Ada Okafor"))
    second = api.post(
        _list_url(str(business.id)), _payload(full_name="Bola Adeyemi", id_type="passport")
    )

    assert first.status_code == status.HTTP_201_CREATED
    assert second.status_code == status.HTTP_201_CREATED
    listed = api.get(_list_url(str(business.id)))
    assert [row["full_name"] for row in listed.data["results"]] == [
        "Ada Okafor",
        "Bola Adeyemi",
    ]


def test_id_number_is_optional() -> None:
    """An operator may be recording directors before they have every
    document to hand."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).post(
        _list_url(str(business.id)), {"full_name": "Ada Okafor", "id_type": "nin"}
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["id_number"] == ""


def test_creation_writes_an_audit_log_entry() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    _auth_client(staff).post(_list_url(str(business.id)), _payload())

    assert AuditLog.objects.filter(action="director.created").exists()


def test_passenger_cannot_add_a_director() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).post(_list_url(str(business.id)), _payload())

    assert response.status_code == status.HTTP_403_FORBIDDEN


# --- patch / soft-remove -------------------------------------------------


def test_patch_updates_a_director_and_is_audit_logged() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        director = Director.objects.create(
            client=client, business=business, full_name="Ada Okafor", id_type="nin"
        )

    response = _auth_client(staff).patch(
        reverse("director-update", kwargs={"pk": str(director.id)}),
        {"id_type": "passport"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["id_type"] == "passport"
    assert AuditLog.objects.filter(action="director.updated").exists()


def test_a_director_is_soft_removed_not_deleted() -> None:
    """`is_active=False`, never a hard delete — a director attached to a
    submitted or approved KYB packet must not vanish from the record."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        director = Director.objects.create(
            client=client, business=business, full_name="Ada Okafor", id_type="nin"
        )

    response = _auth_client(staff).patch(
        reverse("director-update", kwargs={"pk": str(director.id)}), {"is_active": False}
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        director.refresh_from_db()
    assert director.is_active is False


def test_deleting_a_director_with_documents_is_protected() -> None:
    """`on_delete=PROTECT` makes the hard case raise rather than silently
    destroying evidence — this is what makes the soft-remove rule above
    enforceable rather than merely advisory."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        director = Director.objects.create(
            client=client, business=business, full_name="Ada Okafor", id_type="nin"
        )
        KybDocument.objects.create(
            client=client,
            business=business,
            director=director,
            document_type=KybDocument.DocumentType.DIRECTORS_ID,
            file="kyb-documents/2026/08/id.pdf",
        )

        with pytest.raises(ProtectedError):
            director.delete()


# --- cross-client isolation ----------------------------------------------


def test_list_only_returns_the_callers_own_directors() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(str(client_a.id)):
        business_a = BusinessFactory(client=client_a)
        Director.objects.create(
            client=client_a, business=business_a, full_name="Ada Okafor", id_type="nin"
        )
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
        Director.objects.create(
            client=client_b, business=business_b, full_name="Chidi Nwosu", id_type="nin"
        )

    response = _auth_client(staff_a).get(_list_url(str(business_a.id)))

    assert response.status_code == status.HTTP_200_OK
    assert [row["full_name"] for row in response.data["results"]] == ["Ada Okafor"]


def test_cross_client_create_is_a_404_not_a_403() -> None:
    """Addressing another Client's business_id must 404 rather than leak
    that it exists — the same convention every sibling endpoint uses."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)

    response = _auth_client(staff_a).post(_list_url(str(business_b.id)), _payload())

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_cross_client_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
        director_b = Director.objects.create(
            client=client_b, business=business_b, full_name="Chidi Nwosu", id_type="nin"
        )

    response = _auth_client(staff_a).patch(
        reverse("director-update", kwargs={"pk": str(director_b.id)}),
        {"full_name": "Hijacked"},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- document -> director link -------------------------------------------


def _upload(
    api: APIClient, business_id: str, document_type: str, director: str | None = None
) -> object:
    upload = SimpleUploadedFile("id.pdf", b"%PDF-1.4 fake", content_type="application/pdf")
    body: dict[str, object] = {"document_type": document_type, "file": upload}
    if director is not None:
        body["director"] = director
    return api.post(
        reverse("business-kyb-document-upload", kwargs={"business_id": business_id}),
        body,
        format="multipart",
    )


def test_a_directors_id_can_be_linked_to_its_director() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        director = Director.objects.create(
            client=client, business=business, full_name="Ada Okafor", id_type="nin"
        )

    response = _upload(
        _auth_client(staff), str(business.id), "directors_id", str(director.id)
    )

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        document = KybDocument.objects.get(pk=response.data["id"])
    assert document.director_id == director.id
    # The *response* must carry the director's id, not its name. Asserting
    # only the model above missed a real bug: the declared UUIDField
    # serialized the Director instance through str(), returning
    # "Ada Okafor" where the OpenAPI schema promises a uuid — found by a
    # live round-trip, so it is pinned here.
    assert response.data["director"] == str(director.id)


def test_a_directors_id_with_no_director_is_rejected() -> None:
    """A director ID pointing at nobody looks filed but proves nothing —
    worse than a rejected upload."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _upload(_auth_client(staff), str(business.id), "directors_id")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "director" in response.data


def test_a_company_level_document_needs_no_director() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _upload(_auth_client(staff), str(business.id), "proof_of_address")

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        document = KybDocument.objects.get(pk=response.data["id"])
    assert document.director_id is None


def test_a_director_from_another_business_is_rejected() -> None:
    """Both Businesses belong to the same Client, so tenancy scoping
    alone would let this through — the serializer's own business check
    is what catches it."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        other_business = BusinessFactory(client=client)
        other_director = Director.objects.create(
            client=client,
            business=other_business,
            full_name="Bola Adeyemi",
            id_type="nin",
        )

    response = _upload(
        _auth_client(staff), str(business.id), "directors_id", str(other_director.id)
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "director" in response.data


def test_client_admin_can_list_its_own_kyb_documents() -> None:
    """This endpoint was POST-only, so the KYB screen could only offer
    another blank upload — never show what was already supplied."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        director = Director.objects.create(
            client=client, business=business, full_name="Ada Okafor", id_type="nin"
        )
    api = _auth_client(staff)
    _upload(api, str(business.id), "proof_of_address")
    _upload(api, str(business.id), "directors_id", str(director.id))

    response = api.get(
        reverse("business-kyb-document-upload", kwargs={"business_id": str(business.id)})
    )

    assert response.status_code == status.HTTP_200_OK
    by_type = {row["document_type"]: row for row in response.data}
    assert set(by_type) == {"proof_of_address", "directors_id"}
    assert by_type["directors_id"]["director"] == str(director.id)
    assert by_type["proof_of_address"]["director"] is None


def test_listing_another_clients_kyb_documents_is_a_404() -> None:
    """404, not an empty list — an empty list would read to the caller as
    'this business has no documents yet'."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)

    response = _auth_client(staff_a).get(
        reverse("business-kyb-document-upload", kwargs={"business_id": str(business_b.id)})
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_upload_still_transitions_the_business_to_submitted() -> None:
    """The director link must not have changed submit_kyb_document's
    existing status behaviour."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        director = Director.objects.create(
            client=client, business=business, full_name="Ada Okafor", id_type="nin"
        )

    _upload(_auth_client(staff), str(business.id), "directors_id", str(director.id))

    with tenant_context(str(client.id)):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.SUBMITTED
