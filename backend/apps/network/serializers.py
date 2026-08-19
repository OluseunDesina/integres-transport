from collections import defaultdict
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business

from .models import Route, RouteStop, Stop
from .services import create_route, create_stop, update_route, update_stop


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

    class Meta:
        model = Route
        fields = [
            "id",
            "business",
            "name",
            "code",
            "description",
            "is_active",
            "stops",
            "created_at",
        ]
        read_only_fields = ["id", "business", "created_at"]

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


class RouteCreateSerializer(serializers.Serializer):
    business = serializers.UUIDField()
    name = serializers.CharField(max_length=255)
    code = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    description = serializers.CharField(required=False, allow_blank=True, default="")

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
    """Validates `?business=<uuid>` on GET /routes/ and GET /stops/ —
    both views share this shape, so it lives here once. `validate_business`
    follows the exact same tenant-scoped-manager-lookup-or-400 convention
    as RouteCreateSerializer/StopCreateSerializer's own `validate_business`,
    deliberately: an unknown OR another Client's Business id must fail the
    same way here as it already does on write, not silently return an
    empty/unfiltered list — see the views' own get_queryset() docstring
    for the full reasoning."""

    business = serializers.UUIDField(required=False)

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
