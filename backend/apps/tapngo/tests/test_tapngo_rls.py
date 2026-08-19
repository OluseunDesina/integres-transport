"""Adversarial RLS proof for apps.tapngo — mirrors
apps/booking/tests/test_booking_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
TapCredential/FareJourney/TapEvent automatically; this file proves RLS
itself, not just that it's enabled.
"""

import pytest
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

from .factories import TapCredentialFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_tap_credential_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        credential_b = TapCredentialFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "tapngo_tapcredential" WHERE id = %s',  # noqa: S608
                [str(credential_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
