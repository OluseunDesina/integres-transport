from collections import defaultdict
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business
from apps.fares.services import route_fare_summary
from apps.scheduling.models import Schedule

from .models import Route, RouteStop, Stop
from .services import create_route, create_stop, update_route, update_stop


def _validate_trip_classes(value: list[str]) -> list[str]:
    """`Route.available_trip_classes` is a JSONField, so nothing below
    this validates its contents — a typo would save cleanly and only
    surface much later as a Schedule that can never be created on the
    route. Same reasoning as `validate_iana_timezone`'s own docstring in
    apps.businesses.

    An empty list is valid and means **no restriction**.
    """
    valid = set(Business.TripClass.values)
    unknown = [entry for entry in value if entry not in valid]
    if unknown:
        raise serializers.ValidationError(
            f"Unknown trip class(es): {', '.join(sorted(unknown))}.",
            code="unknown_trip_class",
        )
    if len(set(value)) != len(value):
        raise serializers.ValidationError(
            "Duplicate trip classes are not allowed.", code="duplicate_trip_class"
        )
    return value


def _validate_location(attrs: dict[str, Any], instance: Stop | None) -> None:
    """At least one of address or (latitude and longitude) must be
    present after this write — checked against the merged result of
    already-saved instance fields + this request's changes, so a PATCH
    that clears the only location data still gets caught."""

    def resolved(field: str) -> Any:
        if field in attrs:
            return attrs[field]
        return getattr(instance, field, None) if instance is not None else None

    has_address = bool(resolved("address"))
    has_coords = bool(resolved("latitude")) and bool(resolved("longitude"))
    if not has_address and not has_coords:
        raise serializers.ValidationError(
            "Provide an address or both latitude and longitude.", code="missing_location"
        )


class StopSerializer(serializers.ModelSerializer[Stop]):
    """Read + PATCH shape. `business` is read_only here — never
    writable after creation, and DRF never runs validation against
    read_only relational fields, so no queryset-at-import-time trap."""

    class Meta:
        model = Stop
        fields = [
            "id",
            "business",
            "name",
            "address",
            "latitude",
            "longitude",
            "is_active",
            "created_at",
        ]
        read_only_fields = ["id", "business", "created_at"]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        _validate_location(attrs, self.instance)
        return attrs

    def update(self, instance: Stop, validated_data: dict[str, Any]) -> Stop:
        request = self.context["request"]
        return update_stop(stop=instance, updated_by=request.user, **validated_data)


class StopCreateSerializer(serializers.Serializer):
    """POST-only shape — `business` is a genuine client choice here (a
    Client can run several Businesses), resolved manually against the
    live, tenant-scoped Business.objects manager at request time, never
    via a class-body PrimaryKeyRelatedField(queryset=...)."""

    business = serializers.UUIDField()
    name = serializers.CharField(max_length=255)
    address = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    latitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True, default=None
    )
    longitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, required=False, allow_null=True, default=None
    )

    def validate_business(self, value: Any) -> Business:
        try:
            return Business.objects.get(pk=value)
        except Business.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown business.", code="unknown_business"
            ) from None

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        _validate_location(attrs, None)
        return attrs

    def create(self, validated_data: dict[str, Any]) -> Stop:
        request = self.context["request"]
        return create_stop(created_by=request.user, **validated_data)


class RouteStopEntrySerializer(serializers.Serializer):
    """Schema-only shape for `RouteSerializer.get_stops` — a Stop plus
    its position on this Route. A plain Serializer, not a ModelSerializer
    subclass of StopSerializer: never instantiated for real serialization
    (get_stops builds its own dicts for the batched-query reasons in its
    docstring), so there's no Meta.fields to keep in sync — this exists
    purely so drf-spectacular can infer a real type instead of `Any` for
    the frontend's generated schema.ts, same fix as
    apps.clients.serializers.ClientKycQueueSerializer.get_documents's own
    @extend_schema_field precedent."""

    id = serializers.UUIDField()
    business = serializers.UUIDField()
    name = serializers.CharField()
    address = serializers.CharField()
    latitude = serializers.DecimalField(max_digits=9, decimal_places=6, allow_null=True)
    longitude = serializers.DecimalField(max_digits=9, decimal_places=6, allow_null=True)
    is_active = serializers.BooleanField()
    created_at = serializers.DateTimeField()
    sequence = serializers.IntegerField()


class RouteSerializer(serializers.ModelSerializer[Route]):
    """Read + PATCH shape. `stops` embeds the ordered Stop list so
    `GET /routes/` needs no separate detail/nested endpoint — batched
    per-request (not per-row) to avoid the same N+1 shape
    apps.businesses.serializers.BusinessKybQueueSerializer.get_documents
    already fixed once."""

    # Staff screens show every Stop on a Route, including deactivated
    # ones (they're still part of the network being managed).
    # RouteBrowseSerializer flips this — see its own docstring.
    active_stops_only = False

    stops = serializers.SerializerMethodField()
    # Declared explicitly rather than left to ModelSerializer, for the
    # same reason FareRuleSerializer.trip_class is: an inferred
    # JSONField has no item type, so drf-spectacular emits `unknown` and
    # every frontend consumer has to cast it back to a list of strings
    # before it can be read. `RouteCreateSerializer` already declares
    # its own, so without this the read and write shapes of one field
    # disagree in the generated types.
    available_trip_classes = serializers.ListField(
        child=serializers.CharField(), required=False
    )

    class Meta:
        model = Route
        fields = [
            "id",
            "business",
            "name",
            "code",
            "description",
            "available_trip_classes",
            "status",
            "distance_km",
            "estimated_duration_minutes",
            "stops",
            "created_at",
        ]
        # `status` is read-only here on purpose, not merely unmentioned:
        # docs/specs/19-route-lifecycle.md makes
        # apps.network.services.set_route_status the sole writer, so a
        # PATCH naming `status` must be rejected with a message pointing
        # at the status endpoint (see validate() below), not silently
        # ignored the way an undeclared field would be.
        read_only_fields = ["id", "business", "status", "created_at"]

    def validate_available_trip_classes(self, value: list[str]) -> list[str]:
        return _validate_trip_classes(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if "status" in self.initial_data:
            raise serializers.ValidationError(
                {"status": "Use POST /routes/{id}/status/ to change a route's status."},
                code="status_via_status_endpoint",
            )
        # docs/specs/19-route-lifecycle.md edge case: "Editing an
        # archived route: 400; restore first." `archived` is the one
        # status this serializer's own Meta calls locked against edits —
        # checked against self.instance, since this is the PATCH path
        # only (RouteCreateSerializer has no instance to check).
        if self.instance is not None and self.instance.status == Route.Status.ARCHIVED:
            raise serializers.ValidationError(
                "This route is archived. Restore it before editing.",
                code="route_archived",
            )
        return attrs

    @extend_schema_field(RouteStopEntrySerializer(many=True))
    def get_stops(self, obj: Route) -> list[dict[str, Any]]:
        if getattr(self, "_route_stops_cache", None) is None:
            parent_instance = self.parent.instance if self.parent is not None else None
            routes = parent_instance if parent_instance is not None else [obj]
            route_ids = [route.id for route in routes]
            route_stops = RouteStop.objects.filter(route_id__in=route_ids)
            if self.active_stops_only:
                route_stops = route_stops.filter(stop__is_active=True)
            route_stops = route_stops.select_related("stop").order_by("sequence")
            cache: dict[Any, list[RouteStop]] = defaultdict(list)
            for route_stop in route_stops:
                cache[route_stop.route_id].append(route_stop)
            self._route_stops_cache = cache
        ordered = self._route_stops_cache.get(obj.id, [])
        return [
            {**StopSerializer(route_stop.stop).data, "sequence": route_stop.sequence}
            for route_stop in ordered
        ]

    def update(self, instance: Route, validated_data: dict[str, Any]) -> Route:
        request = self.context["request"]
        return update_route(route=instance, updated_by=request.user, **validated_data)


class RouteBusinessSerializer(serializers.Serializer):
    """Schema-only shape for `RouteBrowseSerializer.get_business` —
    mirrors apps.scheduling.serializers.TripRouteSerializer's own {id,
    name} embed, and exists for the same reason: without it
    drf-spectacular infers `Any` for the generated schema.ts."""

    id = serializers.UUIDField()
    name = serializers.CharField()


class RouteBrowseSerializer(RouteSerializer):
    """Passenger-facing read shape for `GET /routes/browse/` — see
    docs/specs/4-fares-seating-booking-frontend.md §3.2. Two deliberate
    differences from the staff `RouteSerializer` it extends:

    - `business` embeds {id, name} rather than a bare FK id: a passenger
      whose Client runs several Businesses (that spec's own `DECISION`)
      needs to see which operator a Route belongs to, and has no
      separate businesses endpoint to resolve the id against.
    - only active Stops are embedded (`active_stops_only`), matching the
      active-stop count RouteBrowseView filters Routes on. Embedding a
      deactivated Stop would offer an unbookable option in the trip
      search's stop picker — the exact class of failure that spec's §3.2
      says to filter out server-side rather than leave for the frontend
      to discover.
    """

    active_stops_only = True

    business = serializers.SerializerMethodField()

    @extend_schema_field(RouteBusinessSerializer)
    def get_business(self, obj: Route) -> dict[str, Any]:
        return {"id": obj.business_id, "name": obj.business.name}


class RouteFareSummarySerializer(serializers.Serializer):
    """Schema-only shape for `RouteDetailSerializer.get_current_fare_summary`
    — mirrors `RouteBusinessSerializer`'s own {id, name} precedent for why
    this needs a real Serializer: without one drf-spectacular infers
    `Any`. Deliberately does not reduce to a single amount: a route can
    have several currently-effective rules at once (one per trip class,
    or one per segment), and picking one to call "the" fare would either
    be arbitrary or silently wrong the moment a Business prices more than
    one class. `configured` is what the `-> active` guard actually
    checks; `rule_count` is context, not a promise about what any one
    journey costs."""

    pricing_mode = serializers.ChoiceField(choices=Business.FarePricingMode.choices)
    configured = serializers.BooleanField()
    rule_count = serializers.IntegerField()


class RouteDetailSerializer(RouteSerializer):
    """GET /routes/{id}/ — docs/specs/19-route-lifecycle.md. Adds the
    counts and fare summary an operator needs to judge a single route,
    which the list/PATCH shape doesn't carry on every row."""

    stop_count = serializers.SerializerMethodField()
    schedule_count = serializers.SerializerMethodField()
    current_fare_summary = serializers.SerializerMethodField()

    class Meta(RouteSerializer.Meta):
        fields = [
            *RouteSerializer.Meta.fields,
            "stop_count",
            "schedule_count",
            "current_fare_summary",
        ]

    def get_stop_count(self, obj: Route) -> int:
        return RouteStop.objects.filter(route=obj).count()

    def get_schedule_count(self, obj: Route) -> int:
        return Schedule.objects.filter(route=obj).count()

    @extend_schema_field(RouteFareSummarySerializer)
    def get_current_fare_summary(self, obj: Route) -> dict[str, Any]:
        return route_fare_summary(route=obj)


class RouteStatusSerializer(serializers.Serializer):
    """POST /routes/{id}/status/ body — mirrors
    apps.scheduling.serializers.TripStatusSerializer's `{status, reason}`
    shape so operators and code meet the same pattern twice rather than
    two different ones. Unlike that serializer, transition legality is
    **not** checked here: docs/specs/19-route-lifecycle.md makes
    apps.network.services.set_route_status the sole owner of that,
    because its guards need database queries a serializer shouldn't run.
    `reason` is accepted for audit-trail symmetry with the Trip endpoint
    (useful on an archive, say) but no Route transition currently
    requires one."""

    status = serializers.ChoiceField(choices=Route.Status.choices)
    # No `default=""` alongside `required=False` — that combination is
    # exactly what makes drf-spectacular emit the field as **required**
    # in schema.ts (CLAUDE.md's own recorded trap). The view reads a
    # missing key with `.get("reason", "")` instead.
    reason = serializers.CharField(required=False, allow_blank=True)


class RouteCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    name = serializers.CharField(max_length=255)
    code = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    description = serializers.CharField(required=False, allow_blank=True, default="")
    available_trip_classes = serializers.ListField(
        child=serializers.CharField(), required=False, default=list
    )

    def validate_available_trip_classes(self, value: list[str]) -> list[str]:
        return _validate_trip_classes(value)

    def validate_business(self, value: Any) -> Business:
        try:
            business = Business.objects.get(pk=value)
        except Business.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown business.", code="unknown_business"
            ) from None
        if business.kyb_status != Business.KybStatus.APPROVED:
            raise serializers.ValidationError(
                "This Business must be KYB-approved before creating Routes.",
                code="business_not_approved",
            )
        return business

    def create(self, validated_data: dict[str, Any]) -> Route:
        request = self.context["request"]
        return create_route(created_by=request.user, **validated_data)


class NetworkListQuerySerializer(serializers.Serializer):
    """Validates `?business=<uuid>&search=&is_active=&status=` on
    GET /routes/ and GET /stops/ — both views share this shape, so it
    lives here once. `is_active` is Stop's own field and `status` is
    Route's (docs/specs/19-route-lifecycle.md); each view reads only the
    one that applies to its model, so the other sits unused rather than
    being split into two near-identical serializers.
    `validate_business` follows the exact same
    tenant-scoped-manager-lookup-or-400 convention as
    RouteCreateSerializer/StopCreateSerializer's own `validate_business`,
    deliberately: an unknown OR another Client's Business id must fail the
    same way here as it already does on write, not silently return an
    empty/unfiltered list — see the views' own get_queryset() docstring
    for the full reasoning.

    `search` is validated here but applied by each view, which owns its
    own field list (a Route is searched by name/code, a Stop by
    name/address). It never widens the queryset it is applied to, so
    tenancy — enforced by `Model.objects` and by RLS underneath it — is
    unaffected by any term a caller can type
    (docs/specs/14-design-system-and-ui-rebuild.md, slice 3a).
    """

    business = serializers.UUIDField(required=False)
    # `allow_blank`: the frontend filter bar emits '' when its search box
    # is cleared, and rejecting that would 400 on the way *back* to the
    # unfiltered list.
    search = serializers.CharField(required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)
    status = serializers.ChoiceField(choices=Route.Status.choices, required=False)

    def validate_business(self, value: Any) -> Business:
        try:
            return Business.objects.get(pk=value)
        except Business.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown business.", code="unknown_business"
            ) from None


class RouteStopsUpdateSerializer(serializers.Serializer):
    """Body: {"stops": [<stop_id>, ...]} — array order is the new
    sequence. `route` (the parent Route, already resolved by the view)
    is passed in via context, not a field, since it's already known from
    the URL."""

    stops = serializers.ListField(child=serializers.UUIDField(), allow_empty=True)

    def validate_stops(self, value: list[Any]) -> list[Stop]:
        route: Route = self.context["route"]
        str_ids = [str(v) for v in value]
        if len(set(str_ids)) != len(str_ids):
            raise serializers.ValidationError(
                "Duplicate stops are not allowed.", code="duplicate_stops"
            )
        stops_by_id = {
            str(stop.id): stop
            for stop in Stop.objects.filter(id__in=str_ids, business=route.business)
        }
        missing = [stop_id for stop_id in str_ids if stop_id not in stops_by_id]
        if missing:
            raise serializers.ValidationError(
                "One or more stops are unknown, inactive, or belong to a "
                "different Business.",
                code="unknown_stop",
            )
        return [stops_by_id[stop_id] for stop_id in str_ids]
