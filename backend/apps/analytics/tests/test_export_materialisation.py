"""The one property `apps/analytics/exports.py` cannot be allowed to lose.

`TenancyMiddleware` wraps each request in its own `transaction.atomic()`
and resets the Python tenancy contextvars in a `finally`. A response
whose body is produced lazily therefore runs its queries **after** both
are gone: RLS fails closed, `TenantScopedQuerySet` returns `self.none()`,
and the operator downloads an empty CSV that reports `200 OK`.

Three guards in `exports.py` fail at build time (mypy runs in CI). These
are the runtime backstop, and the reason they can be ordinary
`django_db` tests is a happy accident worth stating: the RLS session
GUCs survive into a test's body access, because they are scoped to the
outer test transaction — but the **Python contextvar reset does not**,
and `TenantScopedQuerySet` consults it first. So a lazy implementation
produces a headers-only file here exactly as it would in production, with
no `transaction=True` and no `--create-db` cost.
"""

from decimal import Decimal

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.analytics.exports import EXPORTS
from apps.analytics.filters import resolve_filters
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory

from .helpers import (
    auth_client,
    business_for,
    csv_text,
    export_url,
    pay_a_booking,
    required_export_params,
)

pytestmark = pytest.mark.django_db


def test_no_query_runs_once_the_response_has_left_the_view() -> None:
    """The whole point of not streaming.

    Asserted as "zero queries while the body is read" rather than "not a
    `StreamingHttpResponse`", so it catches a lazy iterator whatever
    class ends up carrying it. The body is checked to be non-empty in the
    same breath, so this can never pass against an empty file — which is
    precisely the failure it exists to detect.
    """
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", channel="card", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    response = auth_client(staff).get(export_url("transactions"), {"business": str(business.id)})
    assert response.status_code == 200

    with CaptureQueriesContext(connection) as captured:
        body = response.content.decode("utf-8-sig")

    assert captured.captured_queries == []
    assert not getattr(response, "streaming", False)
    assert "1000.00" in body


@pytest.mark.parametrize("resource", sorted(EXPORTS))
def test_every_resources_rows_are_a_materialised_list(resource: str) -> None:
    """Registry-driven with no allowlist, the shape
    `apps/core/tests/test_row_level_security.py` already uses — a
    resource added later gets this check for free rather than needing to
    remember it."""
    client = ClientFactory()
    business = business_for(client)
    # A real trip, so a resource that declares `required_filters` has
    # something to be pointed at rather than being skipped — see
    # `required_export_params`.
    booking, _intent = pay_a_booking(client, business, amount="1.00", idempotency_key="mat")

    with tenant_context(str(client.id)):
        filters = resolve_filters(
            {
                "business": str(business.id),
                **required_export_params(resource, trip_id=str(booking.trip_id)),
            }
        )
        rows = EXPORTS[resource].rows(filters)

    assert type(rows) is list


def test_a_populated_export_is_not_headers_only() -> None:
    """The end-to-end shape of the same failure.

    This is the test that goes red if the rows ever become lazy again:
    the contextvar reset in `TenancyMiddleware`'s `finally` would leave
    every queryset matching nothing, and the file would be its header row
    and nothing else.
    """
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(
        client, business, amount="1000.00", channel="card", idempotency_key="k1"
    )
    staff = ClientStaffUserFactory(client=client)

    body = csv_text(
        auth_client(staff).get(export_url("transactions"), {"business": str(business.id)})
    )
    lines = [line for line in body.splitlines() if line.strip()]

    assert len(lines) == 2, body
    assert str(booking.passenger.email) in lines[1]


def test_money_reaching_the_csv_as_a_decimal_is_a_loud_failure() -> None:
    """`_cell`'s Decimal guard, asserted rather than trusted.

    Analytics money shipped as JSON floats in slice 2 because nothing
    stopped a bare `Decimal` reaching the wire. This is the CSV-side
    mirror of that boundary, and a `TypeError` at build time beats a
    number that is subtly the wrong shape in a spreadsheet.
    """
    from apps.analytics.exports import _cell

    with pytest.raises(TypeError, match="decimal string"):
        _cell(Decimal("10.00"))
