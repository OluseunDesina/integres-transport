"""Serializers for apps.booking — see
docs/specs/4-fares-seating-booking.md §3."""

from typing import Any

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business
from apps.network.models import RouteStop, Stop
from apps.scheduling.models import Trip
from apps.seating.models import Seat, SeatReservation

from .models import Booking


def _resolve_stop(value: Any) -> Stop:
    try:
        return Stop.objects.get(pk=value)
    except Stop.DoesNotExist:
        raise serializers.ValidationError("Unknown stop.", code="unknown_stop") from None


def _resolve_seat(value: Any) -> Seat:
    try:
        return Seat.objects.select_related("vehicle_type").get(pk=value)
    except Seat.DoesNotExist:
        raise serializers.ValidationError("Unknown seat.", code="unknown_seat") from None


def _resolve_trip(value: Any) -> Trip:
    try:
        return Trip.objects.select_related("route", "business", "vehicle__vehicle_type").get(
            pk=value
        )
    except Trip.DoesNotExist:
        raise serializers.ValidationError("Unknown trip.", code="unknown_trip") from None


class BookingSeatRequestSerializer(serializers.Serializer):
    seat = serializers.UUIDField()
    from_stop = serializers.UUIDField()
    to_stop = serializers.UUIDField()

    def validate_seat(self, value: Any) -> Seat:
        return _resolve_seat(value)

    def validate_from_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

    def validate_to_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)


class BookingCreateSerializer(serializers.Serializer):
    """POST /bookings/ body — see the spec's §3 request-handling order.

    No `create()`: unlike e.g. `apps.fares.serializers.FareRuleCreateSerializer`,
    the view calls `apps.booking.services.create_booking` directly rather
    than `serializer.save()` — that service needs `request.user` and the
    `Idempotency-Key` header, neither of which is part of this body, the
    same reason `apps.scheduling.serializers.TripStatusSerializer` has no
    `create()`/`update()` either.
    """

    trip = serializers.UUIDField()
    seats = BookingSeatRequestSerializer(many=True)

    def validate_trip(self, value: Any) -> Trip:
        return _resolve_trip(value)

    def validate_seats(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not value:
            raise serializers.ValidationError("At least one seat is required.", code="empty_seats")
        seat_ids = [seat_request["seat"].id for seat_request in value]
        if len(set(seat_ids)) != len(seat_ids):
            raise serializers.ValidationError(
                "The same seat cannot be requested twice in one booking.",
                code="duplicate_seats",
            )
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        trip: Trip = attrs["trip"]
        if trip.booking_mode != Business.BookingMode.RESERVATION:
            raise serializers.ValidationError(
                {"trip": "This trip does not use seat reservations."},
                code="not_reservation_mode",
            )
        if trip.status != Trip.Status.SCHEDULED:
            raise serializers.ValidationError(
                {"trip": "This trip is not open for booking."}, code="trip_not_scheduled"
            )
        if trip.vehicle is None:
            raise serializers.ValidationError(
                {"trip": "Seating is not yet configured for this trip."},
                code="no_vehicle_assigned",
            )

        stop_ids = {
            stop.id
            for seat_request in attrs["seats"]
            for stop in (seat_request["from_stop"], seat_request["to_stop"])
        }
        route_stop_sequence = {
            route_stop.stop_id: route_stop.sequence
            for route_stop in RouteStop.objects.filter(route=trip.route, stop_id__in=stop_ids)
        }

        for seat_request in attrs["seats"]:
            seat: Seat = seat_request["seat"]
            from_stop: Stop = seat_request["from_stop"]
            to_stop: Stop = seat_request["to_stop"]
            if seat.vehicle_type_id != trip.vehicle.vehicle_type_id:
                raise serializers.ValidationError(
                    {"seats": f"Seat {seat.seat_number} does not belong to this trip's vehicle."},
                    code="seat_vehicle_mismatch",
                )
            if from_stop.id not in route_stop_sequence or to_stop.id not in route_stop_sequence:
                raise serializers.ValidationError(
                    {"seats": "Both stops must be on the trip's route."},
                    code="stop_not_on_route",
                )
            if route_stop_sequence[from_stop.id] >= route_stop_sequence[to_stop.id]:
                raise serializers.ValidationError(
                    {"seats": "from_stop must come before to_stop on the route."},
                    code="invalid_segment_order",
                )
        return attrs


class BookingSeatReservationSerializer(serializers.Serializer):
    """Nested read-only shape for `BookingSerializer.seats` — queried
    separately (`SeatReservation.objects.filter(booking=...)`), never a
    reverse accessor: every FK in `apps.seating` uses `related_name="+"`
    (see that app's `models.py` docstring), so there is no
    `booking.seatreservation_set` to traverse."""

    id = serializers.UUIDField()
    seat = serializers.CharField(source="seat.seat_number")
    from_stop = serializers.CharField(source="from_stop.name")
    to_stop = serializers.CharField(source="to_stop.name")
    status = serializers.CharField()
    held_until = serializers.DateTimeField()
    amount = serializers.DecimalField(max_digits=10, decimal_places=2)


class BookingTripRouteSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class BookingTripSerializer(serializers.Serializer):
    """Schema-only shape for `BookingSerializer.get_trip` — see
    docs/specs/4-fares-seating-booking-frontend.md §3.4. Mirrors
    apps.scheduling.serializers.TripSerializer.get_route's own nested
    {id, name} convention."""

    id = serializers.UUIDField()
    route = BookingTripRouteSerializer()
    scheduled_departure_at = serializers.DateTimeField()
    service_date = serializers.DateField()


class BookingSerializer(serializers.ModelSerializer[Booking]):
    trip = serializers.SerializerMethodField()
    seats = serializers.SerializerMethodField()

    class Meta:
        model = Booking
        fields = [
            "id",
            "business",
            "trip",
            "passenger",
            "status",
            "total_amount",
            "currency",
            "cancellation_reason",
            "seats",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(BookingTripSerializer)
    def get_trip(self, obj: Booking) -> dict[str, Any]:
        # Reads through to trip.route, so every view returning this
        # serializer must select_related("trip__route") — a plain
        # select_related("trip") leaves this one query per row. Both
        # list views do; see their get_queryset().
        return {
            "id": obj.trip_id,
            "route": {"id": obj.trip.route_id, "name": obj.trip.route.name},
            "scheduled_departure_at": obj.trip.scheduled_departure_at,
            "service_date": obj.trip.service_date,
        }

    @extend_schema_field(BookingSeatReservationSerializer(many=True))
    def get_seats(self, obj: Booking) -> Any:
        # `reservations_by_booking` (context): the list view batch-fetches
        # every row's SeatReservations in one query and passes the
        # grouping in via context — see apps.booking.views's own
        # docstring on why (the N+1 apps.network.views.RouteListCreateView's
        # own precedent already warns about, here on a relation with no
        # reverse accessor to Prefetch()). Falls back to a live per-object
        # query for the single-object responses (create/cancel), where
        # one extra query is not an N+1.
        prefetched: dict[Any, list[SeatReservation]] | None = self.context.get(
            "reservations_by_booking"
        )
        reservations = (
            prefetched.get(obj.id, [])
            if prefetched is not None
            else SeatReservation.objects.filter(booking=obj).select_related(
                "seat", "from_stop", "to_stop"
            )
        )
        return BookingSeatReservationSerializer(reservations, many=True).data


class BookingCancelSerializer(serializers.Serializer):
    """POST /bookings/{id}/cancel/ body. Mirrors
    `apps.scheduling.serializers.TripStatusSerializer`'s
    illegal-transition-in-`validate()` shape, narrowed to `Booking`'s
    only legal cancel transition (`pending_payment` -> `cancelled`)."""

    reason = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        booking: Booking = self.context["booking"]
        if booking.status != Booking.Status.PENDING_PAYMENT:
            raise serializers.ValidationError(
                {"status": f"Cannot cancel a booking in {booking.status} status."},
                code="illegal_transition",
            )
        return attrs


class BookingListQuerySerializer(serializers.Serializer):
    trip = serializers.UUIDField(required=False)
    status = serializers.ChoiceField(choices=Booking.Status.choices, required=False)

    def validate_trip(self, value: Any) -> Trip:
        return _resolve_trip(value)
