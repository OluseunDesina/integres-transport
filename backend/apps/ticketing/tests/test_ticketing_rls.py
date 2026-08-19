"""Adversarial RLS proof for apps.ticketing — mirrors
apps/tapngo/tests/test_tapngo_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
Ticket automatically; this file proves RLS itself, not just that it's
enabled.
"""

import pytest
from django.db import connection

from apps.booking.services import mark_booking_paid
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass, set_rls_session_vars
from apps.core.tests.tenancy import tenant_context
from apps.payments.tests.booking_helpers import booking_with_a_held_seat

from ..models import Ticket

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_ticket_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
    booking_b, _reservation = booking_with_a_held_seat(client_b, business_b)
    mark_booking_paid(booking=booking_b)
    with platform_staff_bypass():
        ticket_b = Ticket.all_objects.get(booking=booking_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "ticketing_ticket" WHERE id = %s',  # noqa: S608
                [str(ticket_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
