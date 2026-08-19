"""Serializers for apps.seating — see
docs/specs/4-fares-seating-booking.md §3."""

from typing import Any

from rest_framework import serializers

from apps.network.models import Stop

from .models import Seat


def _resolve_stop(value: Any) -> Stop:
    try:
        return Stop.objects.get(pk=value)
    except Stop.DoesNotExist:
        raise serializers.ValidationError("Unknown stop.", code="unknown_stop") from None


class SeatSerializer(serializers.ModelSerializer[Seat]):
    class Meta:
        model = Seat
        fields = [
            "id",
            "vehicle_type",
            "seat_number",
            "row",
            "column",
            "is_active",
            "created_at",
        ]
        read_only_fields = fields


class VehicleTypeSeatsUpdateSerializer(serializers.Serializer):
    """Body: {"seat_numbers": ["1A", "1B", ...]} — mirrors
    apps.network.serializers.RouteStopsUpdateSerializer's
    replace-the-set shape. `vehicle_type` (already resolved by the
    view from the URL) is passed in via context, not a field."""

    seat_numbers = serializers.ListField(
        child=serializers.CharField(max_length=10), allow_empty=True
    )

    def validate_seat_numbers(self, value: list[str]) -> list[str]:
        vehicle_type = self.context["vehicle_type"]
        if len(set(value)) != len(value):
            raise serializers.ValidationError(
                "Duplicate seat numbers are not allowed.", code="duplicate_seat_numbers"
            )
        if len(value) > vehicle_type.capacity:
            raise serializers.ValidationError(
                f"Cannot configure more than {vehicle_type.capacity} seats "
                "(the vehicle type's capacity).",
                code="exceeds_capacity",
            )
        return value


class TripAvailabilityQuerySerializer(serializers.Serializer):
    from_stop = serializers.UUIDField()
    to_stop = serializers.UUIDField()

    def validate_from_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

    def validate_to_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)


class SeatAvailabilitySerializer(serializers.Serializer):
    seat = SeatSerializer()
    is_available = serializers.BooleanField()
