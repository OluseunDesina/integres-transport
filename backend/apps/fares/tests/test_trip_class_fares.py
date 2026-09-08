"""Class-aware fare resolution — docs/specs/15-trip-classes.md.

The load-bearing group of spec 15. Everything else in that spec is a
column or a validation rule; this is the part that decides what a
passenger is actually charged, and it is the part that would fail
silently rather than loudly if it were wrong — a classed trip quoting
the wildcard price looks like a working system charging the wrong money.
"""

from decimal import Decimal

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory

from ..models import ANY_TRIP_CLASS, FareRule
from ..services import FareNotConfigured, _class_precedence_order, get_fare
from .factories import FareRuleFactory, FareSegmentRuleFactory

pytestmark = pytest.mark.django_db

PREMIUM = Business.TripClass.PREMIUM
STANDARD = Business.TripClass.STANDARD


def _flat_setup(trip_class: str = PREMIUM):  # type: ignore[no-untyped-def]
    """A flat-priced Business with one route, one trip of `trip_class`,
    and two stops. Returns everything a fare lookup needs."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
        route = RouteFactory(client=client, business=business)
        trip = TripFactory(client=client, route=route, business=business, trip_class=trip_class)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
    return client, business, route, trip, stop_a, stop_b


# --- Precedence ----------------------------------------------------------


def test_exact_class_beats_the_wildcard() -> None:
    """The whole point of the dimension. A Premium trip with both a
    premium rule and a wildcard rule in force pays the premium one."""
    client, business, route, trip, stop_a, stop_b = _flat_setup()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=ANY_TRIP_CLASS,
            amount="500.00",
        )
        FareRuleFactory(
            client=client, route=route, business=business, trip_class=PREMIUM, amount="1200.00"
        )
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)

    assert quote.amount == Decimal("1200.00")
    assert quote.fare_rule is not None
    assert quote.fare_rule.trip_class == PREMIUM


def test_both_rules_in_force_does_not_raise_multiple_objects_returned() -> None:
    """The exact bug this design avoids.

    `get_fare()` used `.get()` before spec 15, which raises
    MultipleObjectsReturned the moment two rules match — and two rules
    matching is precisely the configuration the wildcard exists to
    support. A regression here would be a 500 on every booking of a
    correctly-priced classed trip.
    """
    client, business, route, trip, stop_a, stop_b = _flat_setup()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=ANY_TRIP_CLASS,
            amount="500.00",
        )
        FareRuleFactory(
            client=client, route=route, business=business, trip_class=PREMIUM, amount="1200.00"
        )
        # Would raise MultipleObjectsReturned under the old .get().
        get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)


def test_wildcard_alone_prices_every_class() -> None:
    """Exactly the pre-migration behaviour, preserved. Every rule that
    existed before spec 15 backfilled to the wildcard, so this is the
    assertion that the migration changed no price."""
    client, business, route, trip, stop_a, stop_b = _flat_setup()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=ANY_TRIP_CLASS,
            amount="500.00",
        )
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)

    assert quote.amount == Decimal("500.00")
    assert quote.fare_rule is not None
    assert quote.fare_rule.trip_class == ANY_TRIP_CLASS


def test_a_rule_for_another_class_does_not_price_this_trip() -> None:
    """A standard-class rule must not leak into a Premium quote — with
    no wildcard to fall back on, this is FareNotConfigured, not a
    cheaper fare."""
    client, business, route, trip, stop_a, stop_b = _flat_setup()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client, route=route, business=business, trip_class=STANDARD, amount="500.00"
        )
        with pytest.raises(FareNotConfigured):
            get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)


def test_no_rule_for_the_class_and_no_wildcard_raises() -> None:
    client, business, route, trip, stop_a, stop_b = _flat_setup()
    with tenant_context(str(client.id)), pytest.raises(FareNotConfigured):
        get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)


def test_exact_class_ordering_is_what_puts_it_first() -> None:
    """Asserts the `ORDER BY trip_class DESC` trick directly.

    Precedence rests on a string-ordering fact: any non-empty class
    value sorts before the empty-string wildcard under DESC. That is
    subtle enough that a later tidy-up to `order_by("trip_class")` looks
    harmless — and would silently invert precedence so every classed
    trip quoted the wildcard price. This test fails loudly if the clause
    is touched, which no other test here would.
    """
    assert _class_precedence_order == "-trip_class"

    client, business, route, _trip, _a, _b = _flat_setup()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=ANY_TRIP_CLASS,
            amount="500.00",
        )
        FareRuleFactory(
            client=client, route=route, business=business, trip_class=PREMIUM, amount="1200.00"
        )
        ordered = list(
            FareRule.objects.filter(route=route)
            .filter(trip_class__in=[PREMIUM, ANY_TRIP_CLASS])
            .order_by(_class_precedence_order)
            .values_list("trip_class", flat=True)
        )

    assert ordered[0] == PREMIUM
    assert ordered[-1] == ANY_TRIP_CLASS


# --- Per-segment precedence ---------------------------------------------


def _per_segment_setup(trip_class: str = PREMIUM):  # type: ignore[no-untyped-def]
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(
            client=client,
            kyb_status=Business.KybStatus.APPROVED,
            fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT,
        )
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        trip = TripFactory(client=client, route=route, business=business, trip_class=trip_class)
    return client, business, route, trip, stop_a, stop_b


def test_per_segment_exact_class_beats_the_wildcard() -> None:
    client, business, route, trip, stop_a, stop_b = _per_segment_setup()
    with tenant_context(str(client.id)):
        FareSegmentRuleFactory(
            client=client,
            route=route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            trip_class=ANY_TRIP_CLASS,
            amount="120.00",
        )
        FareSegmentRuleFactory(
            client=client,
            route=route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            trip_class=PREMIUM,
            amount="400.00",
        )
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)

    assert quote.amount == Decimal("400.00")
    assert quote.fare_segment_rule is not None
    assert quote.fare_segment_rule.trip_class == PREMIUM


def test_per_segment_wildcard_alone_prices_every_class() -> None:
    client, business, route, trip, stop_a, stop_b = _per_segment_setup()
    with tenant_context(str(client.id)):
        FareSegmentRuleFactory(
            client=client,
            route=route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            trip_class=ANY_TRIP_CLASS,
            amount="120.00",
        )
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)

    assert quote.amount == Decimal("120.00")


# --- The exclusion constraints ------------------------------------------


def test_two_overlapping_rules_for_the_same_class_are_rejected() -> None:
    client, business, route, _trip, _a, _b = _flat_setup()
    now = timezone.now()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=PREMIUM,
            effective_from=now,
            effective_to=None,
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            FareRuleFactory(
                client=client,
                route=route,
                business=business,
                trip_class=PREMIUM,
                effective_from=now,
                effective_to=None,
            )


def test_two_overlapping_rules_for_different_classes_are_allowed() -> None:
    """Different classes, different prices, same instant — that is the
    entire point of the dimension, and the constraint must not stand in
    its way."""
    client, business, route, _trip, _a, _b = _flat_setup()
    now = timezone.now()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=PREMIUM,
            effective_from=now,
            effective_to=None,
        )
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=STANDARD,
            effective_from=now,
            effective_to=None,
        )

    with tenant_context(str(client.id)):
        assert FareRule.objects.filter(route=route).count() == 2


def test_two_overlapping_wildcard_rules_are_rejected() -> None:
    """The case a nullable column would have let through, and the whole
    reason `trip_class` uses an empty-string sentinel instead.

    Postgres `=` does not match NULL against NULL, so `trip_class WITH =`
    over a nullable column would have found no conflict here and
    silently permitted the duplicate the constraint exists to prevent.
    """
    client, business, route, _trip, _a, _b = _flat_setup()
    now = timezone.now()
    with tenant_context(str(client.id)):
        FareRuleFactory(
            client=client,
            route=route,
            business=business,
            trip_class=ANY_TRIP_CLASS,
            effective_from=now,
            effective_to=None,
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            FareRuleFactory(
                client=client,
                route=route,
                business=business,
                trip_class=ANY_TRIP_CLASS,
                effective_from=now,
                effective_to=None,
            )


def test_segment_rules_for_different_classes_may_overlap() -> None:
    client, business, route, _trip, stop_a, stop_b = _per_segment_setup()
    now = timezone.now()
    with tenant_context(str(client.id)):
        FareSegmentRuleFactory(
            client=client,
            route=route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            trip_class=PREMIUM,
            effective_from=now,
            effective_to=None,
        )
        FareSegmentRuleFactory(
            client=client,
            route=route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            trip_class=STANDARD,
            effective_from=now,
            effective_to=None,
        )
        with pytest.raises(IntegrityError), transaction.atomic():
            FareSegmentRuleFactory(
                client=client,
                route=route,
                business=business,
                from_stop=stop_a,
                to_stop=stop_b,
                trip_class=PREMIUM,
                effective_from=now,
                effective_to=None,
            )


# --- Cross-client isolation ---------------------------------------------


def test_another_clients_premium_rule_is_invisible() -> None:
    """The standing mandatory isolation case, applied to the new
    dimension: a second Client pricing Premium on its own route must not
    reach this Client's quote."""
    client, business, route, trip, stop_a, stop_b = _flat_setup()
    other = ClientFactory()
    with tenant_context(str(other.id)):
        other_business = BusinessFactory(client=other, kyb_status=Business.KybStatus.APPROVED)
        other_route = RouteFactory(client=other, business=other_business)
        FareRuleFactory(
            client=other,
            route=other_route,
            business=other_business,
            trip_class=PREMIUM,
            amount="9999.00",
        )

    with tenant_context(str(client.id)), pytest.raises(FareNotConfigured):
        get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)


# --- Supersede carries the class ----------------------------------------


def test_superseding_a_premium_rule_keeps_it_premium() -> None:
    """A supersede is a price change, never a class move — otherwise one
    call could unprice one class and reprice another."""
    from apps.identity.tests.factories import ClientStaffUserFactory

    from ..services import supersede_fare_rule

    client, business, route, _trip, _a, _b = _flat_setup()
    with tenant_context(str(client.id)):
        staff = ClientStaffUserFactory(client=client)
        rule = FareRuleFactory(
            client=client, route=route, business=business, trip_class=PREMIUM, amount="1200.00"
        )
        successor = supersede_fare_rule(fare_rule=rule, amount=Decimal("1500.00"), updated_by=staff)

    assert successor.trip_class == PREMIUM
    assert successor.amount == Decimal("1500.00")
