"""docs/specs/12-fare-matrix.md — GET/PUT /routes/{id}/fare-matrix/."""

from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory

from ..models import FareSegmentRule
from .factories import FareSegmentRuleFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _owner(client) -> User:  # type: ignore[no-untyped-def]
    roles = create_default_roles(client)
    return ClientStaffUserFactory(client=client, role=roles["Owner"])


def _per_segment_route(stop_count: int = 3):  # type: ignore[no-untyped-def]
    """A Client + per-segment Business + Route with `stop_count` ordered
    stops. Three stops is the smallest route with more than one forward
    pair, which is what makes an upper-triangular grid meaningful."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(
            client=client,
            kyb_status=Business.KybStatus.APPROVED,
            fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT,
        )
        route = RouteFactory(client=client, business=business)
        stops = []
        for i in range(stop_count):
            stop = StopFactory(client=client, business=business, name=f"Stop {i + 1}")
            RouteStopFactory(client=client, route=route, stop=stop, sequence=i + 1)
            stops.append(stop)
    return client, business, route, stops


def _url(route, trip_class: str = "") -> str:  # type: ignore[no-untyped-def]
    """`?trip_class=` is required since spec 15. The default here is the
    wildcard grid — the only grid that existed when these tests were
    written, so every one of them keeps asserting exactly what it did
    before classes existed."""
    path = reverse("route-fare-matrix", kwargs={"pk": str(route.id)})
    return f"{path}?trip_class={trip_class}"


def _cell(payload: dict, from_stop, to_stop) -> dict:  # type: ignore[no-untyped-def]
    return next(
        c
        for c in payload["cells"]
        if c["from_stop"] == str(from_stop.id) and c["to_stop"] == str(to_stop.id)
    )


# --- GET ---------------------------------------------------------------


def test_get_returns_only_forward_pairs() -> None:
    """A 3-stop route has 3 forward pairs, not 9. Emitting the full
    square would invite pricing a segment nobody can book — the reverse
    direction is what BookingCreateSerializer rejects as
    `invalid_segment_order`."""
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    response = api.get(_url(route))

    assert response.status_code == status.HTTP_200_OK
    pairs = {(c["from_stop"], c["to_stop"]) for c in response.data["cells"]}
    assert pairs == {
        (str(stops[0].id), str(stops[1].id)),
        (str(stops[0].id), str(stops[2].id)),
        (str(stops[1].id), str(stops[2].id)),
    }


def test_get_reports_unpriced_cells_as_null_rather_than_omitting_them() -> None:
    """The grid must render every bookable segment, priced or not — an
    omitted cell is indistinguishable from a segment that doesn't
    exist, and the operator would never know to price it."""
    client, business, route, stops = _per_segment_route()
    with tenant_context(str(client.id)):
        FareSegmentRuleFactory(
            client=client,
            business=business,
            route=route,
            from_stop=stops[0],
            to_stop=stops[1],
            amount="150.00",
        )
    api = _auth_client(_owner(client))

    response = api.get(_url(route))

    priced = _cell(response.data, stops[0], stops[1])
    unpriced = _cell(response.data, stops[1], stops[2])
    # A string, not a Decimal: DRF's DecimalField coerces to string by
    # default and every other money field in this API already does the
    # same, so the grid receives the same shape as the fare list does.
    assert priced["amount"] == "150.00"
    assert priced["fare_segment_rule"] is not None
    assert unpriced["amount"] is None
    assert unpriced["fare_segment_rule"] is None


def test_get_carries_the_currency_and_pricing_mode_from_the_business() -> None:
    """The frontend reads the currency from here rather than looking it
    up elsewhere — a previous slice shipped a bug reading a `currency`
    field off a model that has none."""
    client, business, route, _stops = _per_segment_route()
    api = _auth_client(_owner(client))

    response = api.get(_url(route))

    assert response.data["currency"] == business.currency
    assert response.data["fare_pricing_mode"] == "per_segment"
    assert response.data["route"] == str(route.id)


def test_get_on_a_route_with_one_stop_returns_no_cells() -> None:
    client, _business, route, _stops = _per_segment_route(stop_count=1)
    api = _auth_client(_owner(client))

    response = api.get(_url(route))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["cells"] == []
    assert len(response.data["stops"]) == 1


def test_get_ignores_a_rule_whose_window_has_already_closed() -> None:
    """The grid must show what `get_fare()` would charge right now, not
    the newest row — they differ exactly when a price has been retired."""
    client, business, route, stops = _per_segment_route()
    now = timezone.now()
    with tenant_context(str(client.id)):
        FareSegmentRuleFactory(
            client=client,
            business=business,
            route=route,
            from_stop=stops[0],
            to_stop=stops[1],
            amount="100.00",
            effective_from=now - timezone.timedelta(days=10),
            effective_to=now - timezone.timedelta(days=1),
        )
    api = _auth_client(_owner(client))

    response = api.get(_url(route))

    assert _cell(response.data, stops[0], stops[1])["amount"] is None


# --- PUT ---------------------------------------------------------------


def test_put_creates_rules_for_previously_unpriced_cells() -> None:
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {
                    "from_stop": str(stops[0].id),
                    "to_stop": str(stops[1].id),
                    "amount": "200.00",
                },
                {
                    "from_stop": str(stops[1].id),
                    "to_stop": str(stops[2].id),
                    "amount": "300.00",
                },
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["created"] == 2
    with tenant_context(str(client.id)):
        assert FareSegmentRule.objects.filter(route=route).count() == 2


def test_put_supersedes_rather_than_mutating_a_changed_cell() -> None:
    """The whole reason the grid goes through the service layer: a
    historical SeatReservation must still point at the rule that priced
    it, so a price change adds a version rather than editing one."""
    client, business, route, stops = _per_segment_route()
    with tenant_context(str(client.id)):
        original = FareSegmentRuleFactory(
            client=client,
            business=business,
            route=route,
            from_stop=stops[0],
            to_stop=stops[1],
            amount="150.00",
        )
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "175.00"}
            ]
        },
        format="json",
    )

    assert response.data["superseded"] == 1
    original.refresh_from_db()
    assert original.amount == Decimal("150.00"), "the priced-at amount must survive untouched"
    assert original.effective_to is not None, "the old window must be closed, not deleted"
    with tenant_context(str(client.id)):
        successor = FareSegmentRule.objects.get(
            route=route, from_stop=stops[0], to_stop=stops[1], effective_to=None
        )
    assert successor.amount == Decimal("175.00")
    assert successor.effective_from == original.effective_to, "the timeline must stay gapless"


def test_put_skips_unchanged_cells_entirely() -> None:
    """No successor row and no audit event for a cell that did not
    change. Without this, saving one edit on a 10-stop route would churn
    45 version histories and bury the real change in 45 audit rows."""
    client, business, route, stops = _per_segment_route()
    with tenant_context(str(client.id)):
        FareSegmentRuleFactory(
            client=client,
            business=business,
            route=route,
            from_stop=stops[0],
            to_stop=stops[1],
            amount="150.00",
        )
    api = _auth_client(_owner(client))
    audit_before = AuditLog.objects.count()

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "150.00"},
                {"from_stop": str(stops[1].id), "to_stop": str(stops[2].id), "amount": None},
            ]
        },
        format="json",
    )

    assert response.data == {"created": 0, "superseded": 0, "closed": 0, "unchanged": 2}
    with tenant_context(str(client.id)):
        assert FareSegmentRule.objects.filter(route=route).count() == 1
    assert AuditLog.objects.count() == audit_before


def test_put_blanking_a_cell_closes_its_rule_with_no_successor() -> None:
    """"Stop selling this segment". The row stays for provenance, the
    timeline just ends — and booking that segment then fails with
    FareNotConfigured, which is why the UI confirms first."""
    client, business, route, stops = _per_segment_route()
    with tenant_context(str(client.id)):
        rule = FareSegmentRuleFactory(
            client=client,
            business=business,
            route=route,
            from_stop=stops[0],
            to_stop=stops[1],
            amount="150.00",
        )
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": None}
            ]
        },
        format="json",
    )

    assert response.data["closed"] == 1
    rule.refresh_from_db()
    assert rule.effective_to is not None
    with tenant_context(str(client.id)):
        assert not FareSegmentRule.objects.filter(
            route=route, from_stop=stops[0], to_stop=stops[1], effective_to=None
        ).exists()


def test_put_uses_one_effective_from_for_every_cell() -> None:
    """A matrix save is a single coherent price change, not N timelines
    drifting apart by milliseconds."""
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "10.00"},
                {"from_stop": str(stops[0].id), "to_stop": str(stops[2].id), "amount": "20.00"},
                {"from_stop": str(stops[1].id), "to_stop": str(stops[2].id), "amount": "30.00"},
            ]
        },
        format="json",
    )

    with tenant_context(str(client.id)):
        starts = {r.effective_from for r in FareSegmentRule.objects.filter(route=route)}
    assert len(starts) == 1


def test_put_is_atomic_so_one_bad_cell_persists_none_of_them() -> None:
    """A partly-priced route is worse than a rejected edit: it produces
    FareNotConfigured at booking time on exactly the segments the
    operator believed they had just priced."""
    client, _business, route, stops = _per_segment_route()
    other_client = ClientFactory()
    with tenant_context(str(other_client.id)):
        foreign_business = BusinessFactory(client=other_client)
        foreign_stop = StopFactory(client=other_client, business=foreign_business)
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "10.00"},
                # Not on this route — rejected, taking the good cell with it.
                {"from_stop": str(stops[0].id), "to_stop": str(foreign_stop.id), "amount": "20.00"},
            ]
        },
        format="json",
    )

    assert response.status_code in (
        status.HTTP_400_BAD_REQUEST,
        status.HTTP_409_CONFLICT,
    )
    with tenant_context(str(client.id)):
        assert FareSegmentRule.objects.filter(route=route).count() == 0


def test_put_rejects_a_pair_that_is_no_longer_on_the_route() -> None:
    """Route reordering hard-deletes and recreates RouteStop rows, so a
    concurrently-edited route can invalidate a submitted pair. Naming
    it beats silently dropping it — a dropped cell only surfaces later,
    as a booking failure."""
    client, business, route, stops = _per_segment_route()
    with tenant_context(str(client.id)):
        orphan = StopFactory(client=client, business=business, name="Removed Stop")
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(orphan.id), "amount": "10.00"}
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert "Removed Stop" in response.data["detail"]


def test_put_rejects_a_reversed_pair() -> None:
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[2].id), "to_stop": str(stops[0].id), "amount": "10.00"}
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_409_CONFLICT


def test_put_refuses_a_business_that_prices_flat() -> None:
    """Segment rules written under flat mode would be stored and then
    never read — `get_fare()` picks the rule type from the Business at
    lookup time. Silently accepting them is the worst outcome."""
    client, business, route, stops = _per_segment_route()
    with tenant_context(str(client.id)):
        business.fare_pricing_mode = Business.FarePricingMode.FLAT
        business.save(update_fields=["fare_pricing_mode"])
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "10.00"}
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert "fare pricing mode" in response.data["detail"]
    with tenant_context(str(client.id)):
        assert FareSegmentRule.objects.filter(route=route).count() == 0


def test_put_rejects_a_zero_amount() -> None:
    """A genuinely free segment is a policy decision, not a 0.00 fare
    that looks indistinguishable from a data-entry slip."""
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "0.00"}
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_put_rejects_the_same_segment_twice() -> None:
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "10.00"},
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "20.00"},
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


# --- permissions and isolation ------------------------------------------


def test_a_passenger_cannot_read_the_matrix() -> None:
    """`fares.view` is a staff codename; passengers hold no Role at all.

    Deliberately a passenger rather than a role-less staff user:
    `ClientStaffUserFactory` grants Owner-equivalent access unless a Role
    is passed explicitly, so `role=None` would silently still be an
    Owner and the test would prove nothing."""
    client, _business, route, _stops = _per_segment_route()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(_url(route))

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_put_requires_fares_manage_not_merely_fares_view() -> None:
    """Staff can read the grid and must not be able to reprice it."""
    client, _business, route, stops = _per_segment_route()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])
    api = _auth_client(staff)

    assert api.get(_url(route)).status_code == status.HTTP_200_OK
    response = api.put(
        _url(route),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "10.00"}
            ]
        },
        format="json",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_another_clients_route_is_a_404_on_get() -> None:
    _client_a, _business_a, route_a, _stops_a = _per_segment_route()
    client_b = ClientFactory()
    api = _auth_client(_owner(client_b))

    assert api.get(_url(route_a)).status_code == status.HTTP_404_NOT_FOUND


def test_another_clients_route_is_a_404_on_put() -> None:
    client_a, _business_a, route_a, stops_a = _per_segment_route()
    client_b = ClientFactory()
    api = _auth_client(_owner(client_b))

    response = api.put(
        _url(route_a),
        {
            "cells": [
                {"from_stop": str(stops_a[0].id), "to_stop": str(stops_a[1].id), "amount": "10.00"}
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    with tenant_context(str(client_a.id)):
        assert FareSegmentRule.objects.filter(route=route_a).count() == 0


def test_get_query_count_does_not_scale_with_stop_count(
    django_assert_max_num_queries,
) -> None:
    """A 10-stop route is 45 cells; a per-cell rule lookup would be 45
    queries. The rules are fetched once and indexed in Python."""
    client, _business, route, _stops = _per_segment_route(stop_count=10)
    api = _auth_client(_owner(client))

    with django_assert_max_num_queries(12):
        response = api.get(_url(route))

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["cells"]) == 45, "10 stops is 45 forward pairs"


def test_put_409s_when_the_tip_it_is_superseding_was_closed_underneath_it() -> None:
    """Two operators saving the same route concurrently.

    The GiST exclusion constraint is the real backstop — unlike
    `docs/adr/0008`'s count invariant, this one *is* expressible as a
    database constraint and already is one. This exercises the losing
    side of that race deterministically by closing the rule between the
    grid being read and saved, which is what the winning transaction
    would have done.

    It must be a 409 rather than a 500 or a silent overwrite: the
    operator needs to know their price was not applied and reload.
    """
    client, business, route, stops = _per_segment_route()
    with tenant_context(str(client.id)):
        rule = FareSegmentRuleFactory(
            client=client,
            business=business,
            route=route,
            from_stop=stops[0],
            to_stop=stops[1],
            amount="150.00",
        )
    api = _auth_client(_owner(client))

    # The rival save lands first, closing the open-ended tip.
    with tenant_context(str(client.id)):
        rule.effective_to = timezone.now()
        rule.save(update_fields=["effective_to"])
        FareSegmentRuleFactory(
            client=client,
            business=business,
            route=route,
            from_stop=stops[0],
            to_stop=stops[1],
            amount="999.00",
            effective_from=rule.effective_to,
        )

    # This save was composed against the pre-race grid, so its
    # `effective_from` predates the rival's window.
    response = api.put(
        _url(route),
        {
            "effective_from": (rule.effective_to - timezone.timedelta(minutes=5)).isoformat(),
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": "175.00"}
            ],
        },
        format="json",
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    with tenant_context(str(client.id)):
        # The rival's price stands; nothing of the loser's landed.
        current = FareSegmentRule.objects.get(
            route=route, from_stop=stops[0], to_stop=stops[1], effective_to=None
        )
    assert current.amount == Decimal("999.00")
