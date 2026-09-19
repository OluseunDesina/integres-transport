from datetime import timedelta
from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business
from apps.fares.serializers import TripFareQuoteSerializer
from apps.fleet.models import Driver, Vehicle
from apps.fleet.services import compliance_warnings_for
from apps.network.models import Route

from .models import Schedule, Trip
from .services import (
    TRIP_TRANSITIONS,
    TripClassNotAvailableOnRoute,
    VehicleClassMismatch,
    create_manual_trip,
    create_schedule,
    update_schedule,
)


def _get_business(value: Any) -> Business:
    try:
        return Business.objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


def _get_route(value: Any) -> Route:
    try:
        return Route.objects.get(pk=value)
    except Route.DoesNotExist:
        raise serializers.ValidationError("Unknown route.", code="unknown_route") from None


def _get_active_route(value: Any) -> Route:
    """Passenger-facing route resolution — unlike `_get_route` (shared
    by every staff serializer in this module), this only matches
    `status=active`. docs/specs/19-route-lifecycle.md's edge case table:
    a passenger sees `active` routes only, invisible rather than merely
    unbookable, so a draft/inactive/archived route gets the same message
    as an unknown id rather than one that would confirm it exists."""
    try:
        return Route.objects.get(pk=value, status=Route.Status.ACTIVE)
    except Route.DoesNotExist:
        raise serializers.ValidationError("Unknown route.", code="unknown_route") from None


def _get_vehicle(value: Any) -> Vehicle | None:
    if value is None:
        return None
    try:
        return Vehicle.objects.get(pk=value)
    except Vehicle.DoesNotExist:
        raise serializers.ValidationError("Unknown vehicle.", code="unknown_vehicle") from None


def _get_driver(value: Any) -> Driver | None:
    if value is None:
        return None
    try:
        return Driver.objects.get(pk=value)
    except Driver.DoesNotExist:
        raise serializers.ValidationError("Unknown driver.", code="unknown_driver") from None


def _validate_days_of_week(value: list[int]) -> list[int]:
    if not value:
        raise serializers.ValidationError(
            "At least one day of week is required.", code="empty_days_of_week"
        )
    if len(set(value)) != len(value):
        raise serializers.ValidationError(
            "Duplicate days of week are not allowed.", code="duplicate_days_of_week"
        )
    if any(day < 1 or day > 7 for day in value):
        raise serializers.ValidationError(
            "Days of week must be between 1 (Monday) and 7 (Sunday).",
            code="invalid_day_of_week",
        )
    return sorted(value)


class ScheduleSerializer(serializers.ModelSerializer[Schedule]):
    # A Schedule has no name of its own, so every consumer needs its
    # route's. `client-admin-app`'s list screen used to resolve that
    # through the shared root RouteStore, which meant a schedule whose
    # route sat outside that store's loaded page rendered as a raw UUID —
    # and any other screen paginating or filtering that same store could
    # make it happen mid-session. `select_related("route")` is already on
    # the queryset, so this costs no extra query.
    route_name = serializers.CharField(source="route.name", read_only=True)

    class Meta:
        model = Schedule
        fields = [
            "id",
            "route",
            "route_name",
            "business",
            "days_of_week",
            "departure_time",
            "effective_from",
            "effective_until",
            "trip_class",
            "is_active",
            "created_at",
        ]
        read_only_fields = ["id", "route", "route_name", "business", "created_at"]

    def validate_days_of_week(self, value: list[int]) -> list[int]:
        return _validate_days_of_week(value)

    def update(self, instance: Schedule, validated_data: dict[str, Any]) -> Schedule:
        request = self.context["request"]
        try:
            return update_schedule(schedule=instance, updated_by=request.user, **validated_data)
        except TripClassNotAvailableOnRoute as exc:
            raise serializers.ValidationError(
                {"trip_class": str(exc)}, code="class_not_available_on_route"
            ) from exc


class ScheduleCreateSerializer(serializers.Serializer):
    route = serializers.UUIDField()
    days_of_week = serializers.ListField(child=serializers.IntegerField())
    departure_time = serializers.TimeField()
    effective_from = serializers.DateField()
    effective_until = serializers.DateField(required=False, allow_null=True, default=None)
    # No `default=` — see the note on VehicleTypeCreateSerializer.trip_class
    # for why a serializer default would make this a required field in
    # the generated frontend types.
    trip_class = serializers.ChoiceField(choices=Business.TripClass.choices, required=False)

    def validate_route(self, value: Any) -> Route:
        return _get_route(value)

    def validate_days_of_week(self, value: list[int]) -> list[int]:
        return _validate_days_of_week(value)

    def create(self, validated_data: dict[str, Any]) -> Schedule:
        request = self.context["request"]
        try:
            return create_schedule(created_by=request.user, **validated_data)
        except TripClassNotAvailableOnRoute as exc:
            raise serializers.ValidationError(
                {"trip_class": str(exc)}, code="class_not_available_on_route"
            ) from exc


class SchedulingListQuerySerializer(serializers.Serializer):
    """Validates `?business=<uuid>&search=&is_active=` on GET /schedules/
    — same unknown-or-foreign-id-→400 convention as
    apps.network.serializers.NetworkListQuerySerializer.

    A Schedule has no name of its own — it is a Route plus a departure
    time — so `search` matches on the route's name. That is the useful
    thing to type, not a gap: an operator looking for "the 06:30 Yaba
    run" is looking for its route.
    """

    business = serializers.UUIDField(required=False)
    # `allow_blank`: the frontend filter bar emits '' when its search box
    # is cleared, and rejecting that would 400 on the way back to the
    # unfiltered list.
    search = serializers.CharField(required=False, allow_blank=True)
    is_active = serializers.BooleanField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)


class TripRouteSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class TripVehicleTypeSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class TripVehicleSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    registration_number = serializers.CharField()
    # docs/specs/22-marketplace.md slice 2. A marketplace search result
    # spans operators a passenger has no other way to compare, and the
    # kind of vehicle is one of the things Wakanow/TravelBeta/Trip.com
    # style results always show — added to the shared serializer rather
    # than a marketplace-only one, same reasoning as `business_name` on
    # `TripSearchResultSerializer` below. Not nullable itself
    # (`Vehicle.vehicle_type` has no `null=True`) — only the whole
    # `vehicle` dict is, when `Trip.vehicle` has no vehicle assigned yet.
    vehicle_type = TripVehicleTypeSerializer()


class TripDriverSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class TripSerializer(serializers.ModelSerializer[Trip]):
    """Read-only shape — Trip has no plain field-level PATCH; writes go
    through TripAssignmentSerializer (vehicle/driver) or
    TripStatusSerializer (status) instead."""

    route = serializers.SerializerMethodField()
    vehicle = serializers.SerializerMethodField()
    driver = serializers.SerializerMethodField()
    compliance_warnings = serializers.SerializerMethodField()

    class Meta:
        model = Trip
        fields = [
            "id",
            "schedule",
            "route",
            "business",
            "service_date",
            "scheduled_departure_at",
            "status",
            "status_changed_at",
            # docs/specs/16-operational-analytics.md slice 1. Null until
            # the Trip actually departs/arrives, and null forever on a
            # Trip cancelled beforehand or predating that spec.
            "actual_departure_at",
            "actual_arrival_at",
            "vehicle",
            "driver",
            "booking_mode",
            "fare_collection_mode",
            "trip_class",
            "cancellation_reason",
            "compliance_warnings",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(TripRouteSerializer)
    def get_route(self, obj: Trip) -> dict[str, Any]:
        return {"id": obj.route_id, "name": obj.route.name}

    @extend_schema_field(TripVehicleSerializer(allow_null=True))
    def get_vehicle(self, obj: Trip) -> dict[str, Any] | None:
        vehicle = obj.vehicle
        if vehicle is None:
            return None
        return {
            "id": vehicle.id,
            "registration_number": vehicle.registration_number,
            "vehicle_type": {"id": vehicle.vehicle_type.id, "name": vehicle.vehicle_type.name},
        }

    @extend_schema_field(TripDriverSerializer(allow_null=True))
    def get_driver(self, obj: Trip) -> dict[str, Any] | None:
        driver = obj.driver
        if driver is None:
            return None
        return {"id": driver.id, "name": driver.name}

    @extend_schema_field(serializers.ListField(child=serializers.CharField()))
    def get_compliance_warnings(self, obj: Trip) -> list[str]:
        warnings: list[str] = []
        if obj.vehicle is not None:
            warnings += compliance_warnings_for(obj.vehicle)
        if obj.driver is not None:
            warnings += compliance_warnings_for(obj.driver)
        return warnings


class TripSearchStopSerializer(serializers.Serializer):
    """Schema-only shape for the `from_stop`/`to_stop` pair on a
    TripSearchResultSerializer row — just enough for the frontend to
    label the result and hand the ids on to seat-picker, not the full
    Stop record (`RouteStopEntrySerializer`'s own heavier shape) a
    search result has no use for."""

    id = serializers.UUIDField()
    name = serializers.CharField()


class TripSearchResultSerializer(serializers.Serializer):
    """One row of GET /trips/search/ — a bookable Trip matched against an
    origin/destination search, docs/specs/4-fares-seating-booking-
    frontend.md §3.3 (reworked for that flow). Wraps `TripSerializer`'s
    existing shape rather than replacing it: everything a passenger
    already saw about a Trip (time, class, vehicle, compliance
    warnings...) still applies unchanged, this just adds the specific
    stop pair and fare *this* result was matched against — which lives
    here, not on Trip itself, because the same Trip's Route can match a
    single search on more than one valid stop pair (see
    apps.network.services.find_route_stop_matches)."""

    trip = TripSerializer()
    from_stop = TripSearchStopSerializer()
    to_stop = TripSearchStopSerializer()
    # 0 means a direct connection — the frontend renders that as "Direct"
    # rather than "0 stops"; that's display wording, not this
    # serializer's job.
    stops_between = serializers.IntegerField()
    fare = TripFareQuoteSerializer()
    # `Trip.business` (on `trip` above) is a bare id — this app's own
    # single-Client search never needed the name, since every result
    # already belongs to the searching passenger's own Client/Business.
    # docs/specs/22-marketplace.md's marketplace search reuses this same
    # serializer across every Client, where which operator a result
    # belongs to is the one piece of context a flat, non-grouped result
    # list cannot do without — added here rather than as a
    # marketplace-only serializer so both callers share one shape.
    business_name = serializers.SerializerMethodField()
    # docs/specs/22-marketplace.md slice 2. Both derived from
    # `Route.estimated_duration_minutes` (docs/specs/19-route-lifecycle.md
    # — an existing, nullable, operator-set field; no migration needed),
    # never stored on `Trip` itself, so there is nothing to keep in sync
    # if a route's estimate is edited after Trips already exist against
    # it. Both are `None` when the operator hasn't set a duration for
    # this route yet — "the trip duration if available", not assumed to
    # always exist.
    duration_minutes = serializers.SerializerMethodField()
    scheduled_arrival_at = serializers.SerializerMethodField()

    def get_business_name(self, obj: dict[str, Any]) -> str:
        return obj["trip"].business.name

    @extend_schema_field(serializers.IntegerField(allow_null=True))
    def get_duration_minutes(self, obj: dict[str, Any]) -> int | None:
        return obj["trip"].route.estimated_duration_minutes

    @extend_schema_field(serializers.DateTimeField(allow_null=True))
    def get_scheduled_arrival_at(self, obj: dict[str, Any]) -> Any:
        duration = self.get_duration_minutes(obj)
        if duration is None:
            return None
        trip: Trip = obj["trip"]
        return trip.scheduled_departure_at + timedelta(minutes=duration)


class TripCreateSerializer(serializers.Serializer):
    """Manual (one-off) Trip creation. `schedule` is never accepted here
    — create_manual_trip() always sets schedule=None server-side."""

    route = serializers.UUIDField()
    service_date = serializers.DateField()
    departure_time = serializers.TimeField()
    vehicle = serializers.UUIDField(required=False, allow_null=True, default=None)
    driver = serializers.UUIDField(required=False, allow_null=True, default=None)
    trip_class = serializers.ChoiceField(choices=Business.TripClass.choices, required=False)

    def validate_route(self, value: Any) -> Route:
        return _get_route(value)

    def validate_vehicle(self, value: Any) -> Vehicle | None:
        return _get_vehicle(value)

    def validate_driver(self, value: Any) -> Driver | None:
        return _get_driver(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        route = attrs.get("route")
        vehicle = attrs.get("vehicle")
        driver = attrs.get("driver")
        if route is not None and vehicle is not None and vehicle.business_id != route.business_id:
            raise serializers.ValidationError(
                {"vehicle": "This vehicle belongs to a different Business."},
                code="vehicle_business_mismatch",
            )
        if route is not None and driver is not None and driver.business_id != route.business_id:
            raise serializers.ValidationError(
                {"driver": "This driver belongs to a different Business."},
                code="driver_business_mismatch",
            )
        return attrs

    def create(self, validated_data: dict[str, Any]) -> Trip:
        request = self.context["request"]
        try:
            return create_manual_trip(created_by=request.user, **validated_data)
        except TripClassNotAvailableOnRoute as exc:
            raise serializers.ValidationError(
                {"trip_class": str(exc)}, code="class_not_available_on_route"
            ) from exc
        except VehicleClassMismatch as exc:
            raise serializers.ValidationError(
                {"vehicle": str(exc)}, code="vehicle_class_mismatch"
            ) from exc


class TripAssignmentSerializer(serializers.Serializer):
    """PATCH /trips/{id}/ body — assignment only, both nullable (a null
    clears the current assignment)."""

    vehicle = serializers.UUIDField(required=False, allow_null=True, default=None)
    driver = serializers.UUIDField(required=False, allow_null=True, default=None)

    def validate_vehicle(self, value: Any) -> Vehicle | None:
        return _get_vehicle(value)

    def validate_driver(self, value: Any) -> Driver | None:
        return _get_driver(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        trip: Trip = self.context["trip"]
        vehicle = attrs.get("vehicle")
        driver = attrs.get("driver")
        if vehicle is not None and vehicle.business_id != trip.business_id:
            raise serializers.ValidationError(
                {"vehicle": "This vehicle belongs to a different Business."},
                code="vehicle_business_mismatch",
            )
        if driver is not None and driver.business_id != trip.business_id:
            raise serializers.ValidationError(
                {"driver": "This driver belongs to a different Business."},
                code="driver_business_mismatch",
            )
        if vehicle is not None and vehicle.vehicle_type.trip_class != trip.trip_class:
            # docs/specs/15-trip-classes.md. Checked here so the operator
            # gets a field error naming both classes; the service raises
            # VehicleClassMismatch independently, so a caller that
            # bypasses this serializer still cannot create the mismatch.
            raise serializers.ValidationError(
                {
                    "vehicle": (
                        f"This is a {trip.trip_class} service and "
                        f"{vehicle.registration_number} is a "
                        f"{vehicle.vehicle_type.trip_class} vehicle."
                    )
                },
                code="vehicle_class_mismatch",
            )
        return attrs


class TripClassSerializer(serializers.Serializer):
    """POST /trips/{id}/class/ body — docs/specs/15-trip-classes.md.

    Its own endpoint rather than a field on the assignment PATCH: that
    body's `vehicle` and `driver` both default to None and therefore
    *clear* on omission, so a class edit that forgot to resend the
    vehicle would silently unassign it. Mirrors TripStatusSerializer's
    shape, which is the other guarded single-field Trip mutation.
    """

    trip_class = serializers.ChoiceField(choices=Business.TripClass.choices)


class TripStatusSerializer(serializers.Serializer):
    """POST /trips/{id}/status/ body. Mirrors
    apps.businesses.serializers.KybDecisionSerializer's
    reject-needs-a-reason shape, adapted to "cancelled needs a reason".
    Transition legality (TRIP_TRANSITIONS) is checked here, against
    `self.context["trip"]`'s current status — same context-passing
    convention as apps.network.serializers.RouteStopsUpdateSerializer."""

    status = serializers.ChoiceField(choices=Trip.Status.choices)
    reason = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        trip: Trip = self.context["trip"]
        new_status = attrs["status"]
        if new_status == trip.status:
            return attrs
        if new_status not in TRIP_TRANSITIONS.get(trip.status, set()):
            raise serializers.ValidationError(
                {"status": f"Cannot transition from {trip.status} to {new_status}."},
                code="illegal_transition",
            )
        if new_status == Trip.Status.CANCELLED and not attrs.get("reason"):
            raise serializers.ValidationError(
                {"reason": "A reason is required when cancelling."}, code="reason_required"
            )
        return attrs


class TripSearchQuerySerializer(serializers.Serializer):
    """Query shape for the passenger-facing GET /trips/search/ — see
    docs/specs/4-fares-seating-booking-frontend.md §3.3, reworked for
    the origin/destination flow (customer-app no longer makes a
    passenger pick a Route first). `origin`/`destination`/`service_date`
    are all required (400 when missing or malformed), the same
    convention apps.fares.serializers.TripFareQuerySerializer and
    apps.seating.serializers.TripAvailabilityQuerySerializer already use
    for their own required params.

    **Named `origin`, not `source`**: `source` is a reserved attribute
    every `rest_framework.serializers.Field` already carries (it names
    which attribute *this* field reads from its parent instance) — a
    field declared with that literal name works at runtime (DRF's
    metaclass collects declared fields independently of that), but it
    shadows the inherited type at the class-attribute level, which is
    exactly the kind of thing worth not doing on a serializer field
    class body just because it happens to work.

    Note what is deliberately *absent*: no `status` or
    `fare_collection_mode` field. Both are forced server-side by the
    view, so a passenger cannot widen the filter to reach a cancelled
    or pay-as-you-go Trip by guessing query values.
    """

    origin = serializers.CharField(max_length=255)
    destination = serializers.CharField(max_length=255)
    service_date = serializers.DateField()
    # Optional, unlike the two above: a passenger who has not chosen a
    # class should see every class on the route, not none of them.
    trip_class = serializers.ChoiceField(choices=Business.TripClass.choices, required=False)

    def validate_route(self, value: Any) -> Route:
        return _get_active_route(value)


class TripListQuerySerializer(serializers.Serializer):
    # `business` mirrors NetworkListQuerySerializer/FleetListQuerySerializer's
    # own `?business=` param. Its absence here was the one gap that left
    # client-admin's Trip list unable to scope to the active Business the
    # way every sibling list screen already does — the list component had
    # to work around it by only scoping its *filter dropdowns*, while the
    # rows themselves still spanned every Business under the Client.
    business = serializers.UUIDField(required=False)
    route = serializers.UUIDField(required=False)
    schedule = serializers.UUIDField(required=False)
    service_date = serializers.DateField(required=False)
    status = serializers.ChoiceField(choices=Trip.Status.choices, required=False)
    trip_class = serializers.ChoiceField(choices=Business.TripClass.choices, required=False)
    # A Trip has no name of its own, so `search` matches its route's —
    # the same reasoning SchedulingListQuerySerializer already records.
    # `allow_blank`, because the filter bar emits '' when cleared.
    search = serializers.CharField(required=False, allow_blank=True)

    def validate_business(self, value: Any) -> Business:
        # Same tenant-scoped-lookup-or-400 convention the sibling apps
        # use: an unknown OR another Client's Business id must 400, not
        # silently return an unfiltered list.
        try:
            return Business.objects.get(pk=value)
        except Business.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown business.", code="unknown_business"
            ) from None

    def validate_route(self, value: Any) -> Route:
        return _get_route(value)

    def validate_schedule(self, value: Any) -> Schedule:
        try:
            return Schedule.objects.get(pk=value)
        except Schedule.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown schedule.", code="unknown_schedule"
            ) from None
