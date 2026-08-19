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

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.identity.models import User
from apps.network.models import Route, Stop
from apps.scheduling.models import Trip

from .models import FareRule, FareSegmentRule


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


def create_fare_rule(
    *,
    business: Business,
    route: Route,
    amount: Decimal,
    created_by: User,
    effective_from: datetime | None = None,
) -> FareRule:
    starts = effective_from if effective_from is not None else timezone.now()
    try:
        with transaction.atomic():
            fare_rule = FareRule.objects.create(
                client=business.client,
                business=business,
                route=route,
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap(
            "A fare rule for this route already covers that effective period."
        ) from exc
    record_audit_event(
        actor=created_by,
        action="fare_rule.created",
        target=fare_rule,
        amount=str(amount),
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
    historical bookings pointing at it still explain the purchase."""
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
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap(
            "A fare rule for this route already covers that effective period."
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
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap("A fare for this segment already covers that effective period.") from exc
    record_audit_event(
        actor=created_by,
        action="fare_segment_rule.created",
        target=fare_segment_rule,
        amount=str(amount),
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
                amount=amount,
                effective_from=starts,
                effective_to=None,
            )
    except IntegrityError as exc:
        raise FareOverlap("A fare for this segment already covers that effective period.") from exc

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
    if business.fare_pricing_mode == Business.FarePricingMode.FLAT:
        try:
            rule = FareRule.objects.get(_effective_at_filter(as_of=moment), route=trip.route)
        except FareRule.DoesNotExist:
            raise FareNotConfigured(f"No flat fare configured for route {trip.route_id}.") from None
        return FareQuote(
            amount=rule.amount,
            currency=business.currency,
            fare_rule=rule,
            fare_segment_rule=None,
        )

    try:
        segment_rule = FareSegmentRule.objects.get(
            _effective_at_filter(as_of=moment),
            route=trip.route,
            from_stop=from_stop,
            to_stop=to_stop,
        )
    except FareSegmentRule.DoesNotExist:
        raise FareNotConfigured(
            f"No fare configured for segment {from_stop.name} -> {to_stop.name} "
            f"on route {trip.route_id}."
        ) from None
    return FareQuote(
        amount=segment_rule.amount,
        currency=business.currency,
        fare_rule=None,
        fare_segment_rule=segment_rule,
    )
