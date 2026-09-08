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


def _trip_class_field(**kwargs: Any) -> serializers.ChoiceField:
    """A class choice that also accepts `""`, the wildcard meaning "any
    class" — docs/specs/15-trip-classes.md. `allow_blank` is what makes
    the wildcard expressible over HTTP at all.

    Callers that want it optional pass `required=True` off and **no**
    `default=`: a serializer default makes drf-spectacular emit the field
    as *required* in the generated request type (the quirk
    `RouteCreate.code` already carries), which would force every existing
    caller to start sending it. Omitted means absent from
    `validated_data`, and the service's own `ANY_TRIP_CLASS` default
    applies — one default, in one place.
    """
    return serializers.ChoiceField(
        choices=Business.TripClass.choices,
        allow_blank=True,
        **kwargs,
    )


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

    # Spec 14 slice 3b: client-admin's fare list used to resolve this
    # through the shared root RouteStore, so a fare whose route sat
    # outside that store's loaded page rendered as a raw UUID — and any
    # other screen filtering or paginating that store could cause it
    # mid-session. The list view already `select_related("route")`s.
    route_name = serializers.CharField(source="route.name", read_only=True)
    # Declared explicitly rather than left to ModelSerializer: the model
    # field is `blank=True`, but the inferred read-only ChoiceField loses
    # that, and the generated frontend type then claimed `trip_class` was
    # always one of the four classes. Every rule that predates spec 15
    # returns `""`, so that type was wrong about every row in the
    # database — the kind of lie a consumer only discovers by switching
    # on a value the types said could not occur.
    trip_class = _trip_class_field(read_only=True)

    class Meta:
        model = FareRule
        fields = [
            "id",
            "business",
            "route",
            "route_name",
            "trip_class",
            "amount",
            "effective_from",
            "effective_to",
            "created_at",
        ]
        read_only_fields = fields


class FareRuleCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    route = serializers.UUIDField()
    # Defaults to the wildcard, which is what every rule created before
    # spec 15 effectively was — so an omitted class keeps meaning
    # "prices every class", not "prices none of them".
    trip_class = _trip_class_field(required=False)
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
    # Same reasoning as FareRuleSerializer.route_name — the segment list
    # additionally needed *stop* names, which it was resolving through
    # the shared root StopStore with the same failure mode.
    route_name = serializers.CharField(source="route.name", read_only=True)
    from_stop_name = serializers.CharField(source="from_stop.name", read_only=True)
    to_stop_name = serializers.CharField(source="to_stop.name", read_only=True)
    # Same reasoning as FareRuleSerializer.trip_class above.
    trip_class = _trip_class_field(read_only=True)

    class Meta:
        model = FareSegmentRule
        fields = [
            "id",
            "business",
            "route",
            "route_name",
            "from_stop",
            "from_stop_name",
            "to_stop",
            "to_stop_name",
            "trip_class",
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
    trip_class = _trip_class_field(required=False)
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


# --- Fare matrix (docs/specs/12-fare-matrix.md) ---------------------------


class FareMatrixStopSerializer(serializers.Serializer):
    """Schema-only shape for a stop in the matrix's axis list."""

    id = serializers.UUIDField()
    name = serializers.CharField()
    sequence = serializers.IntegerField()


class FareMatrixCellSerializer(serializers.Serializer):
    """One forward stop pair. `amount` is null where the segment has no
    currently-effective rule — an unpriced cell, which the grid renders
    as empty and booking rejects as `FareNotConfigured`.

    `fare_segment_rule` is echoed so a later save can tell that the tip
    it is superseding has moved since the grid was loaded."""

    from_stop = serializers.UUIDField()
    to_stop = serializers.UUIDField()
    amount = serializers.DecimalField(
        max_digits=10, decimal_places=2, allow_null=True
    )
    fare_segment_rule = serializers.UUIDField(allow_null=True)


class FareMatrixSerializer(serializers.Serializer):
    """GET response. `currency` comes from the Business that owns the
    route, deliberately read from this payload by the frontend rather
    than looked up elsewhere — a previous slice shipped a bug reading a
    `currency` field off `LedgerAccount`, which has none."""

    route = serializers.UUIDField()
    currency = serializers.CharField()
    fare_pricing_mode = serializers.CharField()
    # Which class's grid this is — echoed back so a client can never
    # render one class's prices under another's heading.
    trip_class = serializers.CharField(allow_blank=True)
    stops = FareMatrixStopSerializer(many=True)
    cells = FareMatrixCellSerializer(many=True)


class FareMatrixQuerySerializer(serializers.Serializer):
    """`?trip_class=` on both GET and PUT — **required**, and the one
    place spec 15's changes are not purely additive to a caller.

    A missing parameter is a 400 rather than a silent edit of the
    wildcard grid. Spec 12's own rule is why: the grid already submits
    only edited cells, because a stale `null` for an untouched cell
    would *close* a rule another operator created. Widening that blast
    radius to "the wrong class's grid entirely" is not acceptable, so
    the class has to be said out loud.

    `""` is a legal, explicit value — the wildcard grid.
    """

    trip_class = _trip_class_field()


class FareMatrixCellWriteSerializer(serializers.Serializer):
    """One submitted cell. A null `amount` means "stop selling this
    segment" and closes the rule with no successor.

    `min_value` is exclusive of zero deliberately: a genuinely free
    segment is a policy decision, not a `0.00` fare, which looks
    indistinguishable from a data-entry slip.
    """

    from_stop = serializers.UUIDField()
    to_stop = serializers.UUIDField()
    amount = serializers.DecimalField(
        max_digits=10,
        decimal_places=2,
        allow_null=True,
        min_value=Decimal("0.01"),
    )

    def validate_from_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

    def validate_to_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)


class FareMatrixWriteSerializer(serializers.Serializer):
    """PUT body. One `effective_from` for the whole submission, so a
    matrix save is a single coherent price change rather than N
    independent timelines drifting apart by milliseconds."""

    effective_from = serializers.DateTimeField(required=False)
    cells = FareMatrixCellWriteSerializer(many=True)

    def validate_cells(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen: set[tuple[str, str]] = set()
        for cell in value:
            key = (str(cell["from_stop"].id), str(cell["to_stop"].id))
            if key in seen:
                raise serializers.ValidationError(
                    f"Segment {cell['from_stop'].name} -> {cell['to_stop'].name} "
                    "appears more than once.",
                    code="duplicate_segment",
                )
            seen.add(key)
        return value


class FareMatrixSaveResultSerializer(serializers.Serializer):
    """What a save actually did. `unchanged` is reported rather than
    hidden so the operator can see that submitting the whole grid did
    not churn every cell's version history."""

    created = serializers.IntegerField()
    superseded = serializers.IntegerField()
    closed = serializers.IntegerField()
    unchanged = serializers.IntegerField()
