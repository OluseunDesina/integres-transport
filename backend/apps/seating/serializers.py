"""Serializers for apps.seating — see
docs/specs/4-fares-seating-booking.md §3 and
docs/specs/8-seat-map-generation.md."""

from typing import Any

from rest_framework import serializers

from apps.network.models import Stop

from .models import Seat
from .services import SeatSpec


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


class SeatSpecSerializer(serializers.Serializer):
    """One seat within VehicleTypeSeatsUpdateSerializer's `seats` list —
    `row`/`column` are optional, matching Seat's own nullable fields: a
    manual PUT doesn't have to supply grid geometry, only generate/
    always does."""

    seat_number = serializers.CharField(max_length=10)
    row = serializers.IntegerField(min_value=1, required=False, allow_null=True, default=None)
    column = serializers.IntegerField(min_value=1, required=False, allow_null=True, default=None)


class VehicleTypeSeatsUpdateSerializer(serializers.Serializer):
    """Body: {"seats": [{"seat_number": "1A", "row": 1, "column": 1}, ...]}
    — mirrors apps.network.serializers.RouteStopsUpdateSerializer's
    replace-the-set shape. `vehicle_type` (already resolved by the
    view from the URL) is passed in via context, not a field."""

    seats = SeatSpecSerializer(many=True)

    def validate_seats(self, value: list[SeatSpec]) -> list[SeatSpec]:
        vehicle_type = self.context["vehicle_type"]
        seat_numbers = [seat["seat_number"] for seat in value]
        if len(set(seat_numbers)) != len(seat_numbers):
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


class VehicleTypeSeatsGenerateSerializer(serializers.Serializer):
    """Body for POST /vehicle-types/{id}/seats/generate/ —
    docs/specs/8-seat-map-generation.md. `vehicle_type` is passed in
    via context, same as VehicleTypeSeatsUpdateSerializer above."""

    rows = serializers.IntegerField(min_value=1)
    columns = serializers.IntegerField(min_value=1)
    aisle_after_column = serializers.IntegerField(min_value=1, required=False, allow_null=True)
    numbering_scheme = serializers.ChoiceField(choices=["row_letter"], default="row_letter")

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        vehicle_type = self.context["vehicle_type"]
        rows = attrs["rows"]
        columns = attrs["columns"]
        if rows * columns > vehicle_type.capacity:
            raise serializers.ValidationError(
                f"Cannot configure more than {vehicle_type.capacity} seats "
                "(the vehicle type's capacity).",
                code="exceeds_capacity",
            )
        aisle_after_column = attrs.get("aisle_after_column")
        if aisle_after_column is not None and aisle_after_column >= columns:
            raise serializers.ValidationError(
                "aisle_after_column must be less than columns.",
                code="invalid_aisle_position",
            )
        return attrs


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


class TripBookabilitySerializer(serializers.Serializer):
    """The `GET /trips/{id}/availability/` envelope —
    docs/specs/10-booking-modes.md.

    Replaced a bare array of seat rows. The array could not distinguish
    "no vehicle assigned yet" from "every seat taken" — both were `[]` —
    so the customer app rendered a departure nobody had assigned a bus
    to as "sold out". `status` is the field that separates them.

    `seats` is always `[]` for open seating, and `capacity_remaining` is
    always `null` for reservation mode; each mode fills the half that
    means something for it rather than the API returning two shapes.
    """

    booking_mode = serializers.CharField()
    # docs/specs/15-trip-classes.md. Read straight off the Trip's own
    # snapshot rather than from `bookability`, which is about what is
    # left to sell, not about what is being sold.
    trip_class = serializers.CharField()
    status = serializers.CharField()
    seats = SeatAvailabilitySerializer(many=True)
    capacity_remaining = serializers.IntegerField(allow_null=True)
    # "May a passenger pick their own seat on this trip" — see
    # `Bookability`'s docstring for why this is not simply the Business
    # field of the same name.
    seat_selection_enabled = serializers.BooleanField()
