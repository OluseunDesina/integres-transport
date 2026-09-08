"""Fat-service layer for fare rules and the fare-lookup used by
booking — mirrors apps.network.services's shape (see
docs/specs/4-fares-seating-booking.md §4).

Fare edits are versioned: closing the open-ended current row and
inserting a successor that shares the boundary instant keeps the
timeline gapless under the half-open `[effective_from, effective_to)`
convention, and satisfies the GiST exclusion constraint.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.identity.models import User
from apps.network.models import Route, Stop
from apps.scheduling.models import Trip

from .models import ANY_TRIP_CLASS, FareRule, FareSegmentRule


class FareNotConfigured(Exception):
    """Raised when no fare rule exists for the requested route/segment —
    mapped to a 404 by the view layer, not a 500. See the spec's §5
    edge case: a booking attempt against an unconfigured segment must
    fail clearly, not silently omit a price."""


class FareRuleClosed(Exception):
    """Raised when a PATCH targets a historical (already-closed) rule —
    only the open-ended tip of a timeline can be superseded."""


class FareOverlap(Exception):
    """Raised when a create/supersede would overlap an existing validity
    window for the same route (or route+segment). Mapped to 400."""


@dataclass(frozen=True)
class FareQuote:
    """What `get_fare` returns — amount + currency + the versioned rule
    that produced it, so booking can snapshot provenance rather than
    re-deriving it later."""

    amount: Decimal
    currency: str
    fare_rule: FareRule | None
    fare_segment_rule: FareSegmentRule | None


def _effective_at_filter(*, as_of: datetime) -> Q:
    """Rows whose half-open window `[effective_from, effective_to)`
    covers `as_of`."""
    return Q(effective_from__lte=as_of) & (Q(effective_to__isnull=True) | Q(effective_to__gt=as_of))


# The trip_class values a Trip of `trip_class` may price from, and the
# order they win in: the exact class first, the `""` wildcard as
# fallback. See `_class_precedence_order` below for how that order is
# expressed in SQL.
def _class_candidates(trip_class: str) -> list[str]:
    return [trip_class, ANY_TRIP_CLASS]


# `ORDER BY trip_class DESC` puts any non-empty value before the empty
# string, so it expresses "specific beats wildcard" without a CASE.
#
# That is a subtle thing for the correctness of every fare quote in the
# system to rest on, so it is asserted directly by a test
# (`test_exact_class_ordering_is_what_puts_it_first`) rather than left
# to the reader. Tidying this into `order_by("trip_class")` would
# silently invert precedence and make every classed trip quote the
# wildcard price — a change no other test would catch.
_class_precedence_order = "-trip_class"


def create_fare_rule(
    *,
    business: Business,
    route: Route,
    amount: Decimal,
    created_by: User,
    effective_from: datetime | None = None,
    trip_class: str = ANY_TRIP_CLASS,
) -> FareRule:
    """`trip_class` defaults to the wildcard, which is what every rule
    created before spec 15 effectively was — so an unclassed caller
    keeps producing exactly the rule it always produced."""
    starts = effective_from if effective_from is not None else timezone.now()
    try:
        with transaction.atomic():
            fare_rule = FareRule.objects.create(
                client=business.client,
                business=business,
                route=route,
                trip_class=trip_class,
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap(
            "A fare rule for this route and class already covers that effective period."
        ) from exc
    record_audit_event(
        actor=created_by,
        action="fare_rule.created",
        target=fare_rule,
        amount=str(amount),
        trip_class=trip_class,
        effective_from=starts.isoformat(),
    )
    return fare_rule


def supersede_fare_rule(
    *,
    fare_rule: FareRule,
    amount: Decimal,
    updated_by: User,
    effective_from: datetime | None = None,
) -> FareRule:
    """Close `fare_rule` and insert a successor starting at
    `effective_from` (default: now). The closed row keeps its amount so
    historical bookings pointing at it still explain the purchase.

    The successor inherits `trip_class` from the row it supersedes and
    there is deliberately no way to override it: a supersede is a price
    change, and letting it also move a rule between classes would mean
    one call could silently unprice one class and reprice another.
    Selling a different class is a create, not an edit.
    """
    if fare_rule.effective_to is not None:
        raise FareRuleClosed("Only an open-ended fare rule can be superseded.")

    starts = effective_from if effective_from is not None else timezone.now()
    if starts < fare_rule.effective_from:
        raise FareOverlap("The new fare cannot start before the rule it supersedes took effect.")

    try:
        with transaction.atomic():
            # Re-read under the lock so a concurrent supersede of the
            # same tip cannot leave two open-ended successors.
            locked = FareRule.all_objects.select_for_update().get(pk=fare_rule.pk)
            if locked.effective_to is not None:
                raise FareRuleClosed("Only an open-ended fare rule can be superseded.")
            locked.effective_to = starts
            locked.save(update_fields=["effective_to"])
            successor = FareRule.objects.create(
                client=locked.client,
                business=locked.business,
                route=locked.route,
                trip_class=locked.trip_class,
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap(
            "A fare rule for this route and class already covers that effective period."
        ) from exc

    record_audit_event(
        actor=updated_by,
        action="fare_rule.superseded",
        target=locked,
        successor_id=str(successor.id),
        effective_to=starts.isoformat(),
    )
    record_audit_event(
        actor=updated_by,
        action="fare_rule.created",
        target=successor,
        amount=str(amount),
        effective_from=starts.isoformat(),
        supersedes_id=str(locked.id),
    )
    return successor


def create_fare_segment_rule(
    *,
    business: Business,
    route: Route,
    from_stop: Stop,
    to_stop: Stop,
    amount: Decimal,
    created_by: User,
    effective_from: datetime | None = None,
    trip_class: str = ANY_TRIP_CLASS,
) -> FareSegmentRule:
    starts = effective_from if effective_from is not None else timezone.now()
    try:
        with transaction.atomic():
            fare_segment_rule = FareSegmentRule.objects.create(
                client=business.client,
                business=business,
                route=route,
                from_stop=from_stop,
                to_stop=to_stop,
                trip_class=trip_class,
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap(
            "A fare for this segment and class already covers that effective period."
        ) from exc
    record_audit_event(
        actor=created_by,
        action="fare_segment_rule.created",
        target=fare_segment_rule,
        amount=str(amount),
        trip_class=trip_class,
        effective_from=starts.isoformat(),
    )
    return fare_segment_rule


def supersede_fare_segment_rule(
    *,
    fare_segment_rule: FareSegmentRule,
    amount: Decimal,
    updated_by: User,
    effective_from: datetime | None = None,
) -> FareSegmentRule:
    if fare_segment_rule.effective_to is not None:
        raise FareRuleClosed("Only an open-ended fare segment rule can be superseded.")

    starts = effective_from if effective_from is not None else timezone.now()
    if starts < fare_segment_rule.effective_from:
        raise FareOverlap("The new fare cannot start before the rule it supersedes took effect.")

    try:
        with transaction.atomic():
            locked = FareSegmentRule.all_objects.select_for_update().get(pk=fare_segment_rule.pk)
            if locked.effective_to is not None:
                raise FareRuleClosed("Only an open-ended fare segment rule can be superseded.")
            locked.effective_to = starts
            locked.save(update_fields=["effective_to"])
            successor = FareSegmentRule.objects.create(
                client=locked.client,
                business=locked.business,
                route=locked.route,
                from_stop=locked.from_stop,
                to_stop=locked.to_stop,
                # Inherited, never overridable — see
                # supersede_fare_rule's docstring for why.
                trip_class=locked.trip_class,
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap(
            "A fare for this segment and class already covers that effective period."
        ) from exc

    record_audit_event(
        actor=updated_by,
        action="fare_segment_rule.superseded",
        target=locked,
        successor_id=str(successor.id),
        effective_to=starts.isoformat(),
    )
    record_audit_event(
        actor=updated_by,
        action="fare_segment_rule.created",
        target=successor,
        amount=str(amount),
        effective_from=starts.isoformat(),
        supersedes_id=str(locked.id),
    )
    return successor


def close_fare_segment_rule(
    *,
    fare_segment_rule: FareSegmentRule,
    updated_by: User,
    effective_to: datetime | None = None,
) -> FareSegmentRule:
    """Closes a segment's open-ended rule with **no successor** — the
    segment stops being priced from that instant on.

    The sibling of `supersede_fare_segment_rule`, and the write behind a
    matrix cell being blanked (docs/specs/12-fare-matrix.md). Distinct
    from deleting the row: history must stay intact so an existing
    `SeatReservation` still points at the rule that priced it.

    The consequence is deliberate and severe — `get_fare()` will raise
    `FareNotConfigured` for this segment afterwards, so booking it
    starts failing. That is what "stop selling this segment" means, and
    why the UI requires a confirm before calling it.
    """
    if fare_segment_rule.effective_to is not None:
        raise FareRuleClosed("Only an open-ended fare segment rule can be closed.")

    ends = effective_to if effective_to is not None else timezone.now()
    if ends < fare_segment_rule.effective_from:
        raise FareOverlap("A fare cannot stop applying before it took effect.")

    with transaction.atomic():
        locked = FareSegmentRule.all_objects.select_for_update().get(pk=fare_segment_rule.pk)
        if locked.effective_to is not None:
            raise FareRuleClosed("Only an open-ended fare segment rule can be closed.")
        locked.effective_to = ends
        locked.save(update_fields=["effective_to"])

    record_audit_event(
        actor=updated_by,
        action="fare_segment_rule.closed",
        target=locked,
        effective_to=ends.isoformat(),
    )
    return locked


def route_fare_summary(*, route: Route, as_of: datetime | None = None) -> dict[str, Any]:
    """Whether `route` currently has a price an operator can quote, and
    how many currently-effective rules back it — the check
    docs/specs/19-route-lifecycle.md's `-> active` transition guard
    needs, phrased without a Trip/from_stop/to_stop the way `get_fare`
    requires: any currently-effective rule counts, regardless of
    trip_class or segment, since the guard only cares whether the route
    is priced *at all*, not what a specific journey costs. Also backs
    the route detail screen's fare summary, so both read the same
    definition of "configured".

    Dispatches on `route.business.fare_pricing_mode`, mirroring
    `get_fare`'s own dispatch.
    """
    moment = as_of if as_of is not None else timezone.now()
    if route.business.fare_pricing_mode == Business.FarePricingMode.FLAT:
        rule_count = FareRule.objects.filter(
            _effective_at_filter(as_of=moment), route=route
        ).count()
    else:
        rule_count = FareSegmentRule.objects.filter(
            _effective_at_filter(as_of=moment), route=route
        ).count()
    return {
        "pricing_mode": route.business.fare_pricing_mode,
        "configured": rule_count > 0,
        "rule_count": rule_count,
    }


def get_fare(
    *, trip: Trip, from_stop: Stop, to_stop: Stop, as_of: datetime | None = None
) -> FareQuote:
    """Dispatches on trip.business.fare_pricing_mode. Resolves the rule
    whose validity window covers `as_of` (default: now — purchase time,
    not departure). Raises FareNotConfigured (mapped to a 404 by the
    view layer) if flat mode has no covering FareRule for trip.route,
    or per_segment mode has no exact covering FareSegmentRule for
    (from_stop, to_stop) — no cross-segment inference, see the spec's
    §1 non-goals."""
    moment = as_of if as_of is not None else timezone.now()
    business = trip.business
    candidates = _class_candidates(trip.trip_class)
    if business.fare_pricing_mode == Business.FarePricingMode.FLAT:
        # `.first()` over an ordered queryset, not `.get()`: since spec
        # 15 a trip can legitimately match *two* rules — an explicit one
        # for its class and a `""` wildcard — and `.get()` would raise
        # MultipleObjectsReturned on exactly the configuration the
        # wildcard exists to support.
        rule = (
            FareRule.objects.filter(_effective_at_filter(as_of=moment), route=trip.route)
            .filter(trip_class__in=candidates)
            .order_by(_class_precedence_order)
            .first()
        )
        if rule is None:
            raise FareNotConfigured(
                f"No flat fare configured for route {trip.route_id} "
                f"(class {trip.trip_class})."
            )
        return FareQuote(
            amount=rule.amount,
            currency=business.currency,
            fare_rule=rule,
            fare_segment_rule=None,
        )

    segment_rule = (
        FareSegmentRule.objects.filter(
            _effective_at_filter(as_of=moment),
            route=trip.route,
            from_stop=from_stop,
            to_stop=to_stop,
        )
        .filter(trip_class__in=candidates)
        .order_by(_class_precedence_order)
        .first()
    )
    if segment_rule is None:
        raise FareNotConfigured(
            f"No fare configured for segment {from_stop.name} -> {to_stop.name} "
            f"on route {trip.route_id} (class {trip.trip_class})."
        )
    return FareQuote(
        amount=segment_rule.amount,
        currency=business.currency,
        fare_rule=None,
        fare_segment_rule=segment_rule,
    )
