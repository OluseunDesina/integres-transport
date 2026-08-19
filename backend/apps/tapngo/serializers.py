"""Serializers for apps.tapngo — see docs/specs/4b-tap-and-go.md."""

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.network.models import Stop
from apps.scheduling.models import Trip

from .models import FareJourney, TapCredential, TapEvent


def _resolve_stop(value: Any) -> Stop:
    try:
        return Stop.objects.get(pk=value)
    except Stop.DoesNotExist:
        raise serializers.ValidationError("Unknown stop.", code="unknown_stop") from None


def _resolve_trip(value: Any) -> Trip:
    try:
        return Trip.objects.select_related("route", "business").get(pk=value)
    except Trip.DoesNotExist:
        raise serializers.ValidationError("Unknown trip.", code="unknown_trip") from None


# --- Tap credentials ---------------------------------------------------


class TapCredentialIssueSerializer(serializers.Serializer):
    """POST /tap-credentials/ body."""

    channel = serializers.ChoiceField(choices=TapCredential.Channel.choices)
    # DRF stubs type `Field.label` (the field's own human-readable label
    # attribute) as `str | _StrPromise | None`; a field genuinely named
    # "label" on this serializer collides with that unrelated attribute
    # under static typing only — harmless at runtime.
    label = serializers.CharField(required=False, allow_blank=True, default="")  # type: ignore[assignment]


class TapCredentialIssuedSerializer(serializers.ModelSerializer[TapCredential]):
    """Response shape for POST /tap-credentials/ only — the one place
    `token` is ever exposed. `token` isn't a model field (only
    `token_hash` is), so it's sourced from serializer context rather
    than the instance."""

    token = serializers.SerializerMethodField()

    class Meta:
        model = TapCredential
        fields = ["id", "token", "channel", "label", "is_active", "created_at"]
        read_only_fields = fields

    @extend_schema_field(serializers.CharField)
    def get_token(self, obj: TapCredential) -> str:
        return self.context["token"]


class TapCredentialSerializer(serializers.ModelSerializer[TapCredential]):
    """GET /tap-credentials/mine/ shape — `token` never appears here."""

    class Meta:
        model = TapCredential
        fields = ["id", "channel", "label", "is_active", "created_at"]
        read_only_fields = fields


class TapCredentialUpdateSerializer(serializers.Serializer):
    """PATCH /tap-credentials/{id}/ body — revocation only, per the spec
    ('{is_active: false} only'). Reactivation is rejected: a passenger
    who wants a working credential again issues a new one."""

    is_active = serializers.BooleanField()

    def validate_is_active(self, value: bool) -> bool:
        if value:
            raise serializers.ValidationError(
                "A revoked credential cannot be reactivated; issue a new one.",
                code="cannot_reactivate",
            )
        return value


# --- Tap recording -------------------------------------------------------


class TapRecordSerializer(serializers.Serializer):
    """POST /trips/{trip_id}/taps/ body."""

    token = serializers.CharField()
    tap_type = serializers.ChoiceField(choices=TapEvent.TapType.choices)
    stop_id = serializers.UUIDField()

    def validate_stop_id(self, value: Any) -> Stop:
        return _resolve_stop(value)


class FareJourneyNestedSerializer(serializers.ModelSerializer[FareJourney]):
    """Nested read-only shape for `TapEventSerializer.journey`."""

    class Meta:
        model = FareJourney
        fields = ["id", "status", "amount", "currency"]
        read_only_fields = fields


class TapEventSerializer(serializers.ModelSerializer[TapEvent]):
    journey = FareJourneyNestedSerializer()

    class Meta:
        model = TapEvent
        fields = ["id", "trip", "tap_type", "stop", "tapped_at", "journey"]
        read_only_fields = fields


# --- Fare journeys ---------------------------------------------------------


class FareJourneyTripRouteSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class FareJourneyTripSerializer(serializers.Serializer):
    """Schema-only shape for `FareJourneySerializer.get_trip` — mirrors
    `apps.booking.serializers.BookingTripSerializer`'s own nested
    {id, route: {id, name}} convention."""

    id = serializers.UUIDField()
    route = FareJourneyTripRouteSerializer()
    scheduled_departure_at = serializers.DateTimeField()
    service_date = serializers.DateField()


class FareJourneySerializer(serializers.ModelSerializer[FareJourney]):
    trip = serializers.SerializerMethodField()
    board_stop = serializers.CharField(source="board_stop.name")
    alight_stop = serializers.SerializerMethodField()

    class Meta:
        model = FareJourney
        fields = [
            "id",
            "business",
            "trip",
            "passenger",
            "status",
            "board_stop",
            "alight_stop",
            "amount",
            "currency",
            "boarded_at",
            "alighted_at",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(FareJourneyTripSerializer)
    def get_trip(self, obj: FareJourney) -> dict[str, Any]:
        # Every view returning this serializer must select_related
        # "trip__route" — see apps.booking.serializers.BookingSerializer's
        # own get_trip docstring for why a plain select_related("trip")
        # alone leaves this one query per row.
        return {
            "id": obj.trip_id,
            "route": {"id": obj.trip.route_id, "name": obj.trip.route.name},
            "scheduled_departure_at": obj.trip.scheduled_departure_at,
            "service_date": obj.trip.service_date,
        }

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_alight_stop(self, obj: FareJourney) -> str | None:
        return obj.alight_stop.name if obj.alight_stop is not None else None


class FareJourneyListQuerySerializer(serializers.Serializer):
    trip = serializers.UUIDField(required=False)
    status = serializers.ChoiceField(choices=FareJourney.Status.choices, required=False)

    def validate_trip(self, value: Any) -> Trip:
        return _resolve_trip(value)
