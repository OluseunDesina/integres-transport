"""`manage.py prune_e2e_test_data` — self-check 2026-09-12-specs19-21's
F8: a stray Business created through the KYB submission flow carried a
`KybDocument` (`on_delete=PROTECT`), so this command's own
`business.delete()` raised `ProtectedError` and silently skipped it
forever. Fixed by deleting a stray Business's own documents (and any
Director those documents alone reference) first.
"""

import pytest
from django.core.files.base import ContentFile
from django.core.management import call_command
from django.db.models import ProtectedError

from apps.businesses.models import Business, Director, KybDocument
from apps.businesses.services import create_business, create_director, submit_kyb_document
from apps.clients.tests.factories import ClientFactory
from apps.core.management.commands.seed_e2e_users import E2E_CLIENT_NAME
from apps.core.rls import platform_staff_bypass
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory

pytestmark = pytest.mark.django_db


def _stray_business_with_kyb_document(client):  # type: ignore[no-untyped-def]
    """A throwaway e2e Business with a company-level document and a
    director's own document — the two document/director combinations
    `submit_kyb_document` supports."""
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with platform_staff_bypass():
        business = create_business(
            client=client,
            vertical=Business.Vertical.SHUTTLE,
            name="Stray E2E Business",
            currency="NGN",
            timezone_name="Africa/Lagos",
            booking_mode_default=Business.BookingMode.RESERVATION,
            created_by=staff,
        )
        director = create_director(
            business=business,
            full_name="Stray Director",
            id_type=Director.IdType.NIN,
            id_number="00000000000",
            created_by=staff,
        )
        submit_kyb_document(
            business=business,
            document_type=KybDocument.DocumentType.CERTIFICATE_OF_INCORPORATION,
            file=ContentFile(b"stray-certificate", name="certificate.pdf"),
            uploaded_by=staff,
        )
        submit_kyb_document(
            business=business,
            document_type=KybDocument.DocumentType.DIRECTORS_ID,
            file=ContentFile(b"stray-director-id", name="director-id.pdf"),
            uploaded_by=staff,
            director=director,
        )
    return business, director


def test_a_stray_business_with_a_kyb_document_is_no_longer_permanently_protected() -> None:
    client = ClientFactory(name=E2E_CLIENT_NAME)
    business, director = _stray_business_with_kyb_document(client)

    call_command("prune_e2e_test_data")

    with platform_staff_bypass():
        assert not Business.all_objects.filter(pk=business.pk).exists()
        assert not Director.all_objects.filter(pk=director.pk).exists()
        assert not KybDocument.all_objects.filter(business_id=business.pk).exists()


def test_dry_run_deletes_nothing_and_reports_the_document_count() -> None:
    client = ClientFactory(name=E2E_CLIENT_NAME)
    business, director = _stray_business_with_kyb_document(client)

    call_command("prune_e2e_test_data", "--dry-run")

    with platform_staff_bypass():
        assert Business.all_objects.filter(pk=business.pk).exists()
        assert Director.all_objects.filter(pk=director.pk).exists()
        assert KybDocument.all_objects.filter(business_id=business.pk).count() == 2


def test_a_directors_id_document_still_blocks_deleting_the_director_directly() -> None:
    """The command's own cascade is scoped to a *stray Business* being
    pruned — it must not weaken `KybDocument.director`'s own PROTECT for
    any other caller, which exists specifically so a director can never
    be deleted out from under their own ID document (Director.is_active
    is the real removal path)."""
    client = ClientFactory(name=E2E_CLIENT_NAME)
    _business, director = _stray_business_with_kyb_document(client)

    with platform_staff_bypass(), pytest.raises(ProtectedError):
        director.delete()
