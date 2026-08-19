"""Adversarial RLS proof for Business and KybDocument — spec §8 names
both explicitly (unlike Slice 2, where only KycDocument existed yet).
Mirrors apps/clients/tests/test_kyc_rls.py's pattern.
"""

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection

from apps.businesses.models import Business, KybDocument
from apps.businesses.services import submit_kyb_document
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_business_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{Business._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(business_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_allows_platform_staff_to_see_any_clients_business_via_raw_sql() -> None:
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)

    set_rls_session_vars(None, is_platform_staff=True)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{Business._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(business_b.id)],
            )
            assert cursor.fetchone() is not None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_kyb_document_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_b = ClientStaffUserFactory(client=client_b)

    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
        document_b = submit_kyb_document(
            business=business_b,
            document_type="proof_of_address",
            file=SimpleUploadedFile("doc.pdf", b"%PDF-1.4 fake"),
            uploaded_by=staff_b,
        )

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{KybDocument._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(document_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
