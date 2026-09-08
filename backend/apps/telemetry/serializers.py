from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business
from apps.fleet.models import Vehicle

from .models import TelemetryDevice, VehiclePosition
from .services import update_device


def _get_business(value: Any) -> Business:
    try:
        return Business.objects.get(pk=value)
    except Business.DoesNotExist:
        raise serializers.ValidationError("Unknown business.", code="unknown_business") from None


def _get_vehicle(value: Any) -> Vehicle:
    try:
        return Vehicle.objects.get(pk=value)
    except Vehicle.DoesNotExist:
        raise serializers.ValidationError("Unknown vehicle.", code="unknown_vehicle") from None


class TelemetryDeviceListQuerySerializer(serializers.Serializer):
    business = serializers.UUIDField(required=False)
    is_active = serializers.BooleanField(required=False)

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)


class TelemetryDeviceSerializer(serializers.ModelSerializer[TelemetryDevice]):
    class Meta:
        model = TelemetryDevice
        fields = ["id", "business", "label", "vehicle", "is_active", "last_seen_at", "created_at"]
        read_only_fields = fields


class TelemetryDeviceCreateSerializer(serializers.Serializer):
    """POST /telemetry/devices/ body — request validation only. The view
    calls `issue_device()` itself and builds the response from
    `TelemetryDeviceIssuedSerializer`, the same split
    `apps.tapngo.views.TapCredentialIssueView` uses, because the
    response needs `token` from context, not from an instance this
    serializer's own `create()` would produce."""

    business = serializers.UUIDField()
    # DRF stubs type `Field.label` as `str | _StrPromise | None`; a field
    # genuinely named "label" collides with that unrelated attribute
    # under static typing only — harmless at runtime (see the identical
    # note on apps.tapngo.serializers.TapCredentialIssueSerializer.label).
    label = serializers.CharField(max_length=100)  # type: ignore[assignment]
    # required=False with no default=, deliberately (docs/backend-patterns.md
    # §6) — a device is often issued before it has a vehicle to sit in.
    vehicle = serializers.UUIDField(required=False, allow_null=True)

    def validate_business(self, value: Any) -> Business:
        return _get_business(value)

    def validate_vehicle(self, value: Any) -> Vehicle:
        return _get_vehicle(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        vehicle = attrs.get("vehicle")
        business = attrs.get("business")
        if vehicle is not None and business is not None and vehicle.business_id != business.id:
            raise serializers.ValidationError(
                {"vehicle": "Vehicle does not belong to this business."},
                code="vehicle_business_mismatch",
            )
        return attrs


class TelemetryDeviceIssuedSerializer(serializers.ModelSerializer[TelemetryDevice]):
    """Response shape for POST /telemetry/devices/ only — the one place
    `token` is ever exposed. Not a model field (only `token_hash` is),
    so it's sourced from serializer context rather than the instance."""

    token = serializers.SerializerMethodField()

    class Meta:
        model = TelemetryDevice
        fields = ["id", "token", "business", "label", "vehicle", "is_active", "created_at"]
        read_only_fields = fields

    @extend_schema_field(serializers.CharField)
    def get_token(self, obj: TelemetryDevice) -> str:
        return self.context["token"]


class TelemetryDeviceUpdateSerializer(serializers.Serializer):
    """PATCH /telemetry/devices/{id}/ — revoke (`is_active=False`) and/or
    reassign (`vehicle=`, nullable to unassign). Both optional so a
    caller can send just the one field they mean to change."""

    is_active = serializers.BooleanField(required=False)
    vehicle = serializers.UUIDField(required=False, allow_null=True)

    def validate_vehicle(self, value: Any) -> Vehicle | None:
        if value is None:
            return None
        return _get_vehicle(value)

    def update(self, instance: TelemetryDevice, validated_data: dict[str, Any]) -> TelemetryDevice:
        request = self.context["request"]
        return update_device(device=instance, updated_by=request.user, **validated_data)


class PositionReadingSerializer(serializers.Serializer):
    """One ingested reading, instantiated per item rather than with
    `many=True` — see `apps.telemetry.views.PositionIngestView.post`'s
    docstring for why the batch is never rejected wholesale for one bad
    row. `PositionIngestView` is excluded from the generated schema (no
    Angular client ever calls it), so this has no schema-documentation
    role — it's the validator, full stop."""

    latitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, min_value=-90, max_value=90
    )
    longitude = serializers.DecimalField(
        max_digits=9, decimal_places=6, min_value=-180, max_value=180
    )
    speed_kph = serializers.DecimalField(
        max_digits=6, decimal_places=2, min_value=0, required=False, allow_null=True
    )
    heading_degrees = serializers.IntegerField(
        min_value=0, max_value=359, required=False, allow_null=True
    )
    recorded_at = serializers.DateTimeField()


class PositionIngestResultSerializer(serializers.Serializer):
    accepted = serializers.IntegerField()
    ignored = serializers.IntegerField()
    skipped = serializers.IntegerField()
    flagged_skew = serializers.IntegerField()


class TripsLiveQuerySerializer(serializers.Serializer):
    """`?since=` on `GET /trips/live/` — see
    `apps.telemetry.live.include_in_delta`."""

    since = serializers.DateTimeField(required=False)


class LiveTripSerializer(serializers.Serializer):
    """Mirrors `apps.booking.serializers.ManifestTripSerializer`'s shape
    exactly (both are built from `apps.booking.manifest.trip_summary`) —
    kept as its own copy per this codebase's small-per-app-serializer
    convention (see `apps.fleet.serializers.FleetListQuerySerializer`'s
    own docstring) rather than a cross-app import."""

    id = serializers.UUIDField()
    route = serializers.CharField()
    trip_class = serializers.CharField()
    service_date = serializers.DateField()
    scheduled_departure_at = serializers.DateTimeField()
    status = serializers.CharField()
    booking_mode = serializers.CharField()
    fare_collection_mode = serializers.CharField()
    vehicle = serializers.CharField(allow_null=True)
    driver = serializers.CharField(allow_null=True)


class LivePositionSerializer(serializers.Serializer):
    latitude = serializers.DecimalField(max_digits=9, decimal_places=6)
    longitude = serializers.DecimalField(max_digits=9, decimal_places=6)
    recorded_at = serializers.DateTimeField()
    # DRF's own `Field.source` (a constructor kwarg mapping a field to a
    # different model attribute) collides with a field genuinely named
    # "source" under static typing only — the same harmless collision
    # apps.incidents.serializers records for the same field name.
    #
    # Left unnamed in ENUM_NAME_OVERRIDES, deliberately: a
    # `serializers.ChoiceField` hashes separately from a model
    # CharField's own `choices=` even with identical values, and
    # registering two override entries for the same underlying choice
    # set is a hard error ("duplication issues"), not just a warning —
    # unlike `RouteStatusEnum` and friends, which each own a genuinely
    # distinct choice set. Same accepted-hash-name treatment as the
    # eleven other unfixed `status` collisions this file's own comment
    # already names.
    source = serializers.ChoiceField(  # type: ignore[assignment]
        choices=VehiclePosition.Source.choices
    )
    staleness_seconds = serializers.IntegerField()


class LiveProgressSerializer(serializers.Serializer):
    last_stop = serializers.CharField()
    next_stop = serializers.CharField(allow_null=True)
    stops_completed = serializers.IntegerField()
    stops_total = serializers.IntegerField()
    method = serializers.CharField()


class LiveEtaSerializer(serializers.Serializer):
    next_stop_at = serializers.DateTimeField(allow_null=True)
    final_stop_at = serializers.DateTimeField()
    method = serializers.CharField()
    confidence = serializers.CharField()


class LivePunctualitySerializer(serializers.Serializer):
    #: `None` when `actual_departure_at` was never stamped — unknown,
    #: not zero.
    delay_minutes = serializers.IntegerField(allow_null=True)


class LiveOccupancySerializer(serializers.Serializer):
    boarded = serializers.IntegerField()
    #: `None` when no vehicle is assigned — unknowable, not zero, same
    #: rule `apps.booking.serializers.ManifestTotalsSerializer` states.
    capacity = serializers.IntegerField(allow_null=True)


class TripLiveEnvelopeSerializer(serializers.Serializer):
    """One `GET /trips/live/` row, and the whole body of
    `GET /trips/{id}/live/`. `position`/`progress`/`eta` are `None`
    together whenever the trip has no telemetry at all — see
    `apps.telemetry.live.trip_live_envelope`."""

    trip = LiveTripSerializer()
    position = LivePositionSerializer(allow_null=True)
    progress = LiveProgressSerializer(allow_null=True)
    eta = LiveEtaSerializer(allow_null=True)
    punctuality = LivePunctualitySerializer()
    occupancy = LiveOccupancySerializer()
    incidents_open = serializers.IntegerField()


class TripsLiveResponseSerializer(serializers.Serializer):
    results = TripLiveEnvelopeSerializer(many=True)
    poll_interval_seconds = serializers.IntegerField()
    #: The server's own clock at request time — **not** an echo of the
    #: `?since=` sent in. A polling client stores this and sends it back
    #: as the *next* request's `?since=`, so the cursor advances from a
    #: clock immune to client/server skew rather than the browser's own
    #: `Date.now()`. Absent on a `304` (no body at all), which is fine:
    #: nothing changed since the cursor already held, so leaving it
    #: un-advanced cannot skip a real update.
    server_time = serializers.DateTimeField()

