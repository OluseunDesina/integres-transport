from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business
from apps.fleet.models import Driver, Vehicle
from apps.fleet.services import compliance_warnings_for
from apps.network.models import Route

from .models import Schedule, Trip
from .services import (
    TRIP_TRANSITIONS,
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
    class Meta:
        model = Schedule
        fields = [
            "id",
            "route",
            "business",
            "days_of_week",
            "departure_time",
            "effective_from",
            "effective_until",
            "is_active",
            "created_at",
        ]
        read_only_fields = ["id", "route", "business", "created_at"]

    def validate_days_of_week(self, value: list[int]) -> list[int]:
        return _validate_days_of_week(value)

    def update(self, instance: Schedule, validated_data: dict[str, Any]) -> Schedule:
        request = self.context["request"]
        return update_schedule(schedule=instance, updated_by=request.user, **validated_data)


class ScheduleCreateSerializer(serializers.Serializer):
    route = serializers.UUIDField()
    days_of_week = serializers.ListField(child=serializers.IntegerField())
    departure_time = serializers.TimeField()
    effective_from = serializers.DateField()
    effective_until = serializers.DateField(required=False, allow_null=True, default=None)

    def validate_route(self, value: Any) -> Route:
        return _get_route(value)

    def validate_days_of_week(self, value: list[int]) -> list[int]:
        return _validate_days_of_week(value)

    def create(self, validated_data: dict[str, Any]) -> Schedule:
        request = self.context["request"]
        return create_schedule(created_by=request.user, **validated_data)


class SchedulingListQuerySerializer(serializers.Serializer):
    """Validates `?business=<uuid>` on GET /schedules/ — same
    unknown-or-foreign-id-→400 convention as
    apps.network.serializers.NetworkListQuerySerializer."""

    business = serializers.UUIDField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)


class TripRouteSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class TripVehicleSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    registration_number = serializers.CharField()


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
            "vehicle",
            "driver",
            "booking_mode",
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
        return {"id": vehicle.id, "registration_number": vehicle.registration_number}

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


class TripCreateSerializer(serializers.Serializer):
    """Manual (one-off) Trip creation. `schedule` is never accepted here
    — create_manual_trip() always sets schedule=None server-side."""

    route = serializers.UUIDField()
    service_date = serializers.DateField()
    departure_time = serializers.TimeField()
    vehicle = serializers.UUIDField(required=False, allow_null=True, default=None)
    driver = serializers.UUIDField(required=False, allow_null=True, default=None)

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
        return create_manual_trip(created_by=request.user, **validated_data)


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
        return attrs


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
    docs/specs/4-fares-seating-booking-frontend.md §3.3. Both params are
    required (400 when either is missing or malformed), the same
    convention apps.fares.serializers.TripFareQuerySerializer and
    apps.seating.serializers.TripAvailabilityQuerySerializer already use
    for their own required params.

    Note what is deliberately *absent*: no `status` or `booking_mode`
    field. Both are forced server-side by the view, so a passenger
    cannot widen the filter to reach a cancelled or tap_and_go Trip by
    guessing query values.
    """

    route = serializers.UUIDField()
    service_date = serializers.DateField()

    def validate_route(self, value: Any) -> Route:
        return _get_route(value)


class TripListQuerySerializer(serializers.Serializer):
    route = serializers.UUIDField(required=False)
    schedule = serializers.UUIDField(required=False)
    service_date = serializers.DateField(required=False)
    status = serializers.ChoiceField(choices=Trip.Status.choices, required=False)

    def validate_route(self, value: Any) -> Route:
        return _get_route(value)

    def validate_schedule(self, value: Any) -> Schedule:
        try:
            return Schedule.objects.get(pk=value)
        except Schedule.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown schedule.", code="unknown_schedule"
            ) from None
