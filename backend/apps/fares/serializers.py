"""Serializers for apps.fares — see
docs/specs/4-fares-seating-booking.md §3.

**Deviation from the spec's literal phrasing, noted here rather than
silently built**: the spec describes a single `GET /fare-rules/?route=`
that "returns whichever of `FareRule`/`FareSegmentRule` applies." This
implements that as two distinct list-create endpoints instead
(`/fare-rules/` for flat, `/fare-segment-rules/` for per-segment) —
one polymorphic endpoint whose response shape depends on runtime
Business state is exactly the kind of ambiguity
`apps.network.views.RouteListCreateView`'s own `extend_schema_view`
comment already flags as a real drf-spectacular/schema-generation
problem in this codebase (a single serializer class is what
`api-client`'s generated `schema.ts` types against). Two concrete
endpoints keep the generated frontend types honest; the frontend still
only calls whichever one matches `business.fare_pricing_mode`.

PATCH is a supersede, not an in-place mutation: the response body is
the newly created successor row (a different `id` from the path).
"""

from datetime import datetime
from decimal import Decimal
from typing import Any

from rest_framework import serializers

from apps.businesses.models import Business
from apps.network.models import Route, RouteStop, Stop

from .models import FareRule, FareSegmentRule
from .services import (
    FareOverlap,
    FareRuleClosed,
    create_fare_rule,
    create_fare_segment_rule,
    supersede_fare_rule,
    supersede_fare_segment_rule,
)


def _resolve_business(value: Any) -> Business:
    try:
        return Business.objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


def _resolve_route(value: Any) -> Route:
    try:
        return Route.objects.get(pk=value)
    except Route.DoesNotExist:
        raise serializers.ValidationError("Unknown route.", code="unknown_route") from None


def _resolve_stop(value: Any) -> Stop:
    try:
        return Stop.objects.get(pk=value)
    except Stop.DoesNotExist:
        raise serializers.ValidationError("Unknown stop.", code="unknown_stop") from None


class FareListQuerySerializer(serializers.Serializer):
    """Shared `?business=&route=` query shape for both list endpoints —
    mirrors apps.network.serializers.NetworkListQuerySerializer's own
    tenant-scoped-lookup-or-400 convention deliberately: an unknown or
    another Client's id must fail the same way here as it does on
    write, not silently return an empty/unfiltered list."""

    business = serializers.UUIDField(required=False)
    route = serializers.UUIDField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate_route(self, value: Any) -> Route:
        return _resolve_route(value)


class FareRuleSerializer(serializers.ModelSerializer[FareRule]):
    """Read shape. `business`/`route` are never writable after creation.
    PATCH uses `FareRuleSupersedeSerializer` — amount changes create a
    new version rather than mutating this row."""

    class Meta:
        model = FareRule
        fields = [
            "id",
            "business",
            "route",
            "amount",
            "effective_from",
            "effective_to",
            "created_at",
        ]
        read_only_fields = fields


class FareRuleCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    route = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"))
    effective_from = serializers.DateTimeField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate_route(self, value: Any) -> Route:
        return _resolve_route(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        business: Business = attrs["business"]
        route: Route = attrs["route"]
        if route.business_id != business.id:
            raise serializers.ValidationError(
                {"route": "This route does not belong to the given business."},
                code="cross_business_route",
            )
        if business.fare_pricing_mode != Business.FarePricingMode.FLAT:
            raise serializers.ValidationError(
                {"business": "This business is not configured for flat-fare pricing."},
                code="wrong_pricing_mode",
            )
        return attrs

    def create(self, validated_data: dict[str, Any]) -> FareRule:
        request = self.context["request"]
        try:
            return create_fare_rule(created_by=request.user, **validated_data)
        except FareOverlap as exc:
            raise serializers.ValidationError(
                {"effective_from": str(exc)}, code="fare_overlap"
            ) from exc


class FareRuleSupersedeSerializer(serializers.Serializer):
    """PATCH body — closes the path's rule and returns a new successor.
    `effective_from` omitted means "now"; a future value schedules the
    change without affecting today's quote."""

    amount = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"))
    effective_from = serializers.DateTimeField(required=False)

    def update(self, instance: FareRule, validated_data: dict[str, Any]) -> FareRule:
        request = self.context["request"]
        amount: Decimal = validated_data["amount"]
        effective_from: datetime | None = validated_data.get("effective_from")
        try:
            return supersede_fare_rule(
                fare_rule=instance,
                amount=amount,
                updated_by=request.user,
                effective_from=effective_from,
            )
        except FareRuleClosed as exc:
            raise serializers.ValidationError({"status": str(exc)}, code="fare_closed") from exc
        except FareOverlap as exc:
            raise serializers.ValidationError(
                {"effective_from": str(exc)}, code="fare_overlap"
            ) from exc


class FareSegmentRuleSerializer(serializers.ModelSerializer[FareSegmentRule]):
    class Meta:
        model = FareSegmentRule
        fields = [
            "id",
            "business",
            "route",
            "from_stop",
            "to_stop",
            "amount",
            "effective_from",
            "effective_to",
            "created_at",
        ]
        read_only_fields = fields


class FareSegmentRuleCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    route = serializers.UUIDField()
    from_stop = serializers.UUIDField()
    to_stop = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"))
    effective_from = serializers.DateTimeField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _resolve_business(value)

    def validate_route(self, value: Any) -> Route:
        return _resolve_route(value)

    def validate_from_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

    def validate_to_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        business: Business = attrs["business"]
        route: Route = attrs["route"]
        from_stop: Stop = attrs["from_stop"]
        to_stop: Stop = attrs["to_stop"]

        if route.business_id != business.id:
            raise serializers.ValidationError(
                {"route": "This route does not belong to the given business."},
                code="cross_business_route",
            )
        if business.fare_pricing_mode != Business.FarePricingMode.PER_SEGMENT:
            raise serializers.ValidationError(
                {"business": "This business is not configured for per-segment pricing."},
                code="wrong_pricing_mode",
            )

        route_stop_sequence = {
            route_stop.stop_id: route_stop.sequence
            for route_stop in RouteStop.objects.filter(
                route=route, stop_id__in=[from_stop.id, to_stop.id]
            )
        }
        if from_stop.id not in route_stop_sequence or to_stop.id not in route_stop_sequence:
            raise serializers.ValidationError(
                "Both stops must be on the route.", code="stop_not_on_route"
            )
        if route_stop_sequence[from_stop.id] >= route_stop_sequence[to_stop.id]:
            raise serializers.ValidationError(
                "from_stop must come before to_stop on the route.",
                code="invalid_segment_order",
            )
        return attrs

    def create(self, validated_data: dict[str, Any]) -> FareSegmentRule:
        request = self.context["request"]
        try:
            return create_fare_segment_rule(created_by=request.user, **validated_data)
        except FareOverlap as exc:
            raise serializers.ValidationError(
                {"effective_from": str(exc)}, code="fare_overlap"
            ) from exc


class FareSegmentRuleSupersedeSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"))
    effective_from = serializers.DateTimeField(required=False)

    def update(self, instance: FareSegmentRule, validated_data: dict[str, Any]) -> FareSegmentRule:
        request = self.context["request"]
        amount: Decimal = validated_data["amount"]
        effective_from: datetime | None = validated_data.get("effective_from")
        try:
            return supersede_fare_segment_rule(
                fare_segment_rule=instance,
                amount=amount,
                updated_by=request.user,
                effective_from=effective_from,
            )
        except FareRuleClosed as exc:
            raise serializers.ValidationError({"status": str(exc)}, code="fare_closed") from exc
        except FareOverlap as exc:
            raise serializers.ValidationError(
                {"effective_from": str(exc)}, code="fare_overlap"
            ) from exc


class TripFareQuerySerializer(serializers.Serializer):
    """Query shape for GET /trips/{id}/fare/ — from_stop/to_stop are
    resolved to real Stop instances the same way every other
    passenger/staff-facing lookup in this codebase resolves a
    class-body-unsafe FK, never via a PrimaryKeyRelatedField(queryset=)."""

    from_stop = serializers.UUIDField()
    to_stop = serializers.UUIDField()

    def validate_from_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

    def validate_to_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)


class TripFareQuoteSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=10, decimal_places=2)
    currency = serializers.CharField()
