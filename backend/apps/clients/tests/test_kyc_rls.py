"""Adversarial RLS proof for KycDocument — the first real (non-diagnostic)
model to exercise Slice 1's mechanism, per
docs/specs/1-identity-client-business.md §8. Mirrors
apps/core/tests/test_row_level_security.py's pattern, run against a real
business model instead of TenancyProbe.
"""

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection

from apps.clients.models import KycDocument
from apps.clients.services import submit_kyc_document
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_kyc_document_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_b = ClientStaffUserFactory(client=client_b)

    with tenant_context(str(client_b.id)):
        document_b = submit_kyc_document(
            client=client_b,
            document_type="proof_of_address",
            file=SimpleUploadedFile("doc.pdf", b"%PDF-1.4 fake"),
            uploaded_by=staff_b,
        )

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{KycDocument._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(document_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_allows_platform_staff_to_see_any_clients_kyc_document_via_raw_sql() -> None:
    client_b = ClientFactory()
    staff_b = ClientStaffUserFactory(client=client_b)

    with tenant_context(str(client_b.id)):
        document_b = submit_kyc_document(
            client=client_b,
            document_type="proof_of_address",
            file=SimpleUploadedFile("doc.pdf", b"%PDF-1.4 fake"),
            uploaded_by=staff_b,
        )

    set_rls_session_vars(None, is_platform_staff=True)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{KycDocument._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(document_b.id)],
            )
            assert cursor.fetchone() is not None
    finally:
        set_rls_session_vars(None, False)
