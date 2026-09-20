"""Serializers for apps.booking — see
docs/specs/4-fares-seating-booking.md §3."""

from collections.abc import Sequence
from datetime import datetime
from typing import Any

from django.utils import timezone
from drf_spectacular.utils import PolymorphicProxySerializer, extend_schema_field
from rest_framework import serializers

from apps.businesses.models import Business
from apps.identity.models import User
from apps.network.models import RouteStop, Stop
from apps.scheduling.models import Trip
from apps.seating.models import Seat, SeatReservation

from .manifest import MANIFEST_KIND_CHOICES
from .models import Booking, Traveler
from .services import is_quick_book
from .staff import STAFF_BOOKING_PAYMENT_STATUS_CHOICES


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


class TravelerInputSerializer(serializers.Serializer):
    """Who is actually travelling — docs/specs/22-marketplace.md slice 2.
    Nested per seat on `BookingSeatRequestSerializer` for a true
    seats-mode booking, or once at the top level on
    `BookingCreateSerializer` for a places-mode (open-seating/
    quick-book) booking's single lead traveler — see
    `apps.booking.services.create_booking`'s own docstring for which is
    which. Entirely optional on both: `apps.booking`'s own endpoint
    accepts a body with no traveler at all; only
    `apps.marketplace.views.MarketplaceBookingCreateSerializer` requires
    one."""

    title = serializers.ChoiceField(choices=Traveler.Title.choices, required=False)
    first_name = serializers.CharField(max_length=150)
    last_name = serializers.CharField(max_length=150)
    phone = serializers.CharField(max_length=32)
    email = serializers.EmailField()
    date_of_birth = serializers.DateField(required=False, allow_null=True)
    gender = serializers.ChoiceField(choices=Traveler.Gender.choices, required=False)
    nationality = serializers.CharField(max_length=100, required=False, allow_blank=True)


class BookingSeatRequestSerializer(serializers.Serializer):
    seat = serializers.UUIDField()
    from_stop = serializers.UUIDField()
    to_stop = serializers.UUIDField()
    traveler = TravelerInputSerializer(required=False)

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
    # Both optional at the field level, because which one is *required*
    # depends on the trip's booking mode — a fact not known until
    # validate() has resolved the trip. Enforced there instead
    # (docs/specs/10-booking-modes.md).
    seats = BookingSeatRequestSerializer(many=True, required=False)
    passenger_count = serializers.IntegerField(required=False, min_value=1)
    # Open seating has no per-seat rows, so the journey is stated once
    # for the whole booking rather than per seat.
    from_stop = serializers.UUIDField(required=False)
    to_stop = serializers.UUIDField(required=False)
    # docs/specs/22-marketplace.md slice 2. The places-mode (open-seating
    # or quick-book) single lead traveler — see
    # `TravelerInputSerializer`'s own docstring for the seats-mode/
    # places-mode split. Not cross-validated against `seats` here the
    # way `passenger_count` is: an extraneous `traveler` alongside
    # `seats` is simply ignored by `create_booking` (each seat's own
    # nested `traveler` is what's read instead), not worth a 400 for.
    traveler = TravelerInputSerializer(required=False)
    # docs/specs/22-marketplace.md slice 3. A third, alternative shape:
    # `passenger_count` named travelers with **no** seat choice at all,
    # even on a trip whose Business does let a passenger pick one
    # (`seat_selection_enabled=True`) — `apps.booking.services.
    # create_booking` auto-allocates a seat per entry the same way it
    # already does for quick-book, and the marketplace app's own "Change
    # seat" link is what lets a passenger move off an auto-assigned seat
    # afterward instead of picking up front. Optional on the base
    # serializer (nobody but marketplace sends it today — see
    # `apps.marketplace.views.MarketplaceBookingCreateSerializer`, which
    # requires it), so `apps.booking`'s own endpoint and
    # `StaffBookingCreateSerializer` are unaffected either way.
    travelers = TravelerInputSerializer(many=True, required=False)

    def validate_trip(self, value: Any) -> Trip:
        return _resolve_trip(value)

    def validate_from_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

    def validate_to_stop(self, value: Any) -> Stop:
        return _resolve_stop(value)

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

    def _validate_seatless(
        self, attrs: dict[str, Any], trip: Trip, *, seats_message: str
    ) -> dict[str, Any]:
        """The body shape shared by the two ways of buying a place
        without naming a seat: open seating, and reservation mode with
        seat choice turned off ("quick book",
        docs/specs/10-booking-modes.md). Both send `passenger_count`
        plus one journey for the whole booking rather than per seat.

        Rejects the reservation-shaped body outright rather than
        ignoring the parts that do not apply. A passenger who sent
        `seats` believed they were choosing one; silently dropping it
        would give them a booking they did not ask for.
        """
        if attrs.get("seats"):
            raise serializers.ValidationError({"seats": seats_message}, code="seats_not_supported")
        missing = [
            field for field in ("passenger_count", "from_stop", "to_stop") if field not in attrs
        ]
        if missing:
            raise serializers.ValidationError(
                dict.fromkeys(missing, "This field is required for this trip."),
                code="open_seating_fields_required",
            )

        from_stop: Stop = attrs["from_stop"]
        to_stop: Stop = attrs["to_stop"]
        sequences = {
            route_stop.stop_id: route_stop.sequence
            for route_stop in RouteStop.objects.filter(
                route=trip.route, stop_id__in=[from_stop.id, to_stop.id]
            )
        }
        if from_stop.id not in sequences or to_stop.id not in sequences:
            raise serializers.ValidationError(
                {"from_stop": "Both stops must be on the trip's route."},
                code="stop_not_on_route",
            )
        if sequences[from_stop.id] >= sequences[to_stop.id]:
            raise serializers.ValidationError(
                {"from_stop": "from_stop must come before to_stop on the route."},
                code="invalid_segment_order",
            )
        return attrs

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        trip: Trip = attrs["trip"]
        # Two distinct refusals, deliberately not merged. A pay-as-you-go
        # trip cannot be booked at all — there is nothing to buy in
        # advance. An open-seating trip *can* be booked, just not with
        # named seats (docs/specs/10-booking-modes.md).
        if trip.fare_collection_mode != Business.FareCollectionMode.PREPAID:
            raise serializers.ValidationError(
                {"trip": "This trip charges fares on board, so it cannot be booked in advance."},
                code="not_prepaid",
            )
        if trip.status != Trip.Status.SCHEDULED:
            raise serializers.ValidationError(
                {"trip": "This trip is not open for booking."}, code="trip_not_scheduled"
            )

        if trip.booking_mode == Business.BookingMode.OPEN_SEATING:
            return self._validate_seatless(
                attrs,
                trip,
                seats_message=(
                    "This trip does not use assigned seats. Send passenger_count instead."
                ),
            )
        if is_quick_book(trip):
            return self._validate_seatless(
                attrs,
                trip,
                seats_message=("This operator assigns seats. Send passenger_count instead."),
            )

        # A trip that *does* let a passenger choose (`seat_selection_
        # enabled=True`, so `is_quick_book` above was False) can still be
        # booked the seatless way, on purpose — docs/specs/22-marketplace.md
        # slice 3. `travelers` is the signal: nobody sends it without
        # also wanting `create_booking` to auto-allocate, so its mere
        # presence (with no explicit `seats`) opts into the same
        # `_validate_seatless` shape quick-book already uses, rather than
        # requiring a passenger to name seats just because the operator
        # would have allowed it.
        if attrs.get("travelers") and not attrs.get("seats"):
            return self._validate_seatless(
                attrs,
                trip,
                seats_message="Send passenger_count and travelers instead of seats.",
            )

        if not attrs.get("seats"):
            raise serializers.ValidationError(
                {"seats": "This field is required for this trip."}, code="empty_seats"
            )
        if "passenger_count" in attrs:
            # Not silently ignored: on a reservation trip the number of
            # passengers *is* the number of seats, so accepting both
            # invites a body where they disagree.
            raise serializers.ValidationError(
                {"passenger_count": "This trip uses assigned seats. Send seats instead."},
                code="passenger_count_not_supported",
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


class StaffBookingCreateSerializer(BookingCreateSerializer):
    """POST /bookings/staff/ body — docs/specs/18-manifest-and-staff-booking.md
    slice 2.

    Everything about *what may be booked* is inherited unchanged, which
    is the point: a pay-as-you-go trip is refused, an open-seating trip
    wants `passenger_count` rather than `seats`, stops must be on the
    route and in order. A counter agent gets exactly the rules a
    passenger gets, because they are booking the same thing.

    Two fields are added — **for whom**, and **who pays now**.
    """

    passenger = serializers.UUIDField(
        help_text="The passenger's id, from `GET /passengers/lookup/`."
    )
    pay_from_wallet = serializers.BooleanField(
        required=False,
        default=False,
        help_text="Settle immediately from the passenger's wallet. A shortfall "
        "leaves the booking `pending_payment` with the seats still held, and is "
        "reported in the response's `payment` rather than raised.",
    )

    def validate_passenger(self, value: Any) -> User:
        """`client=` is mandatory and explicit.

        `identity.User` is the one model here that is not tenant-scoped
        (ADR-0003), so an unfiltered `User.objects.get(pk=...)` would
        happily resolve another Client's passenger and book them onto
        this Client's trip. `is_client_staff=False` keeps a colleague's
        id from being booked as a passenger by mistake.

        The message is the same for "no such user", "another Client's
        user" and "a staff member" — the distinction is precisely what
        an id-guessing caller would be probing for.
        """
        request = self.context["request"]
        passenger = User.objects.filter(
            pk=value, client=request.user.client, is_client_staff=False, is_active=True
        ).first()
        if passenger is None:
            raise serializers.ValidationError("Unknown passenger.", code="unknown_passenger")
        return passenger


class TravelerOutputSerializer(serializers.Serializer):
    """Read-only shape for a `Traveler` row — the read-back
    `docs/specs/22-marketplace.md` slice 2 named as deliberately not
    built yet ("traveler display-back on my-bookings/tickets") and
    slice 3 actually needs: the "Passengers" step shows the name behind
    each auto-assigned seat, and the "Change seat" confirmation needs to
    say whose seat is moving."""

    id = serializers.UUIDField()
    title = serializers.CharField(allow_blank=True)
    first_name = serializers.CharField()
    last_name = serializers.CharField()
    phone = serializers.CharField()
    email = serializers.CharField()
    date_of_birth = serializers.DateField(allow_null=True)
    gender = serializers.CharField(allow_blank=True)
    nationality = serializers.CharField(allow_blank=True)


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
    # docs/specs/22-marketplace.md slice 3. `traveler` is a plain
    # in-memory attribute `BookingSerializer.get_seats` stashes onto each
    # `SeatReservation` before handing the list here, not a real model
    # field or `source=` lookup — see that method's own docstring for
    # why (batched to avoid an N+1, the same shape `_reservations`
    # itself already uses).
    traveler = serializers.SerializerMethodField()

    @extend_schema_field(TravelerOutputSerializer(allow_null=True))
    def get_traveler(self, obj: SeatReservation) -> dict[str, Any] | None:
        traveler = getattr(obj, "_traveler", None)
        return TravelerOutputSerializer(traveler).data if traveler is not None else None


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
    # docs/specs/15-trip-classes.md slice 3. The Trip's own snapshot,
    # not the Schedule's current value — a Booking is a record of what
    # was sold, and the class it was sold as cannot change underneath
    # it (Trip.trip_class's own docstring).
    trip_class = serializers.CharField()


class BookingSerializer(serializers.ModelSerializer[Booking]):
    trip = serializers.SerializerMethodField()
    seats = serializers.SerializerMethodField()
    hold_expires_at = serializers.SerializerMethodField()
    hold_expires_in_seconds = serializers.SerializerMethodField()
    # docs/specs/22-marketplace.md slice 3. Travelers with no seat of
    # their own — a places-mode (open-seating, or quick-book without
    # `apps.marketplace`'s own per-seat auto-allocation) booking's lead
    # traveler(s). A seats-mode traveler is never in this list; it's
    # nested on its own row in `seats` instead — see `get_seats`.
    travelers = serializers.SerializerMethodField()
    # docs/adr/0009 / docs/specs/22-marketplace.md. `business` above is a
    # bare id — every other consumer of this serializer belongs to one
    # Client and needed nothing more, but a marketplace passenger's own
    # "my bookings" list can legitimately span several different
    # operators at once, and a bare id names none of them.
    business_name = serializers.SerializerMethodField()

    class Meta:
        model = Booking
        fields = [
            "id",
            # docs/specs/18-manifest-and-staff-booking.md slice 1. Added
            # to the shared serializer rather than only to the manifest,
            # because the point of a reference is that the passenger and
            # the operator can say the same string to each other — one
            # that only the manifest knew would be no use on a phone
            # call.
            "reference",
            "business",
            "business_name",
            "trip",
            "passenger",
            "status",
            "total_amount",
            "currency",
            "cancellation_reason",
            "seats",
            "travelers",
            # docs/specs/21-passenger-experience.md slice 2. Both derived
            # from the same live `SeatReservation` rows `seats` already
            # reads — see `_reservations`/`_earliest_held_until` below.
            "hold_expires_at",
            "hold_expires_in_seconds",
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
            "trip_class": obj.trip.trip_class,
        }

    def get_business_name(self, obj: Booking) -> str:
        # Reads through Booking's own `business` FK, not `trip.route`'s
        # — same one, but this is the direct path. Every view returning
        # this serializer must select_related("business") for the same
        # N+1 reason `get_trip` already documents for `trip__route`.
        return obj.business.name

    def _reservations(self, obj: Booking) -> Sequence[SeatReservation]:
        # `reservations_by_booking` (context): the list view batch-fetches
        # every row's SeatReservations in one query and passes the
        # grouping in via context — see apps.booking.views's own
        # docstring on why (the N+1 apps.network.views.RouteListCreateView's
        # own precedent already warns about, here on a relation with no
        # reverse accessor to Prefetch()). Falls back to a live per-object
        # query for the single-object responses (create/cancel), where
        # one extra query is not an N+1. Shared by `seats` and both hold
        # fields below — all three read the same rows.
        prefetched: dict[Any, list[SeatReservation]] | None = self.context.get(
            "reservations_by_booking"
        )
        if prefetched is not None:
            return prefetched.get(obj.id, [])
        # `all_objects`, not `.objects` — docs/adr/0009, same reasoning
        # as `apps.booking.views._reservations_by_booking`'s own
        # `all_objects` choice. This fallback runs for single-object
        # responses like `BookingCancelView`'s, which sit inside
        # `platform_staff_bypass()` with no matching `as_client()` (a
        # marketplace passenger's own booking spans a Client that is not
        # their own ambient one) — `.objects` here silently returned zero
        # rows for exactly that case until this fix, caught while wiring
        # up `get_traveler`/`get_travelers` alongside it, which would
        # otherwise have inherited the identical bug from new code
        # instead of old.
        return list(
            SeatReservation.all_objects.filter(booking=obj, deleted_at__isnull=True).select_related(
                "seat", "from_stop", "to_stop"
            )
        )

    def _travelers_by_reservation(self, obj: Booking) -> dict[Any, Traveler]:
        """One row per `SeatReservation`, keyed by its id — the seats-mode
        half of this booking's travelers. Batched via context the same
        way `_reservations`' own docstring explains
        (`travelers_by_reservation`, populated by the list views below);
        falls back to a live query for the single-object responses
        (create/cancel/change-seat)."""
        prefetched: dict[Any, Traveler] | None = self.context.get("travelers_by_reservation")
        if prefetched is not None:
            return prefetched
        # `all_objects` — same cross-Client reasoning as `_reservations`'
        # own fallback just above.
        return {
            traveler.seat_reservation_id: traveler
            for traveler in Traveler.all_objects.filter(
                booking=obj, seat_reservation__isnull=False, deleted_at__isnull=True
            )
        }

    @extend_schema_field(BookingSeatReservationSerializer(many=True))
    def get_seats(self, obj: Booking) -> Any:
        reservations = self._reservations(obj)
        travelers = self._travelers_by_reservation(obj)
        for reservation in reservations:
            # Transient — never saved, never a real relation (both FKs
            # are `related_name="+"`, so there is no `.traveler` Django
            # would recognise). Just how the value gets from this method,
            # which has both lists, to `BookingSeatReservationSerializer.
            # get_traveler`, which only ever sees one `SeatReservation` at
            # a time.
            reservation._traveler = travelers.get(reservation.id)  # type: ignore[attr-defined]
        return BookingSeatReservationSerializer(reservations, many=True).data

    @extend_schema_field(TravelerOutputSerializer(many=True))
    def get_travelers(self, obj: Booking) -> Any:
        prefetched: dict[Any, list[Traveler]] | None = self.context.get("lead_travelers_by_booking")
        if prefetched is not None:
            rows = prefetched.get(obj.id, [])
        else:
            # `all_objects` — same cross-Client reasoning as
            # `_reservations`'s own fallback above.
            rows = list(
                Traveler.all_objects.filter(
                    booking=obj, seat_reservation__isnull=True, deleted_at__isnull=True
                )
            )
        return TravelerOutputSerializer(rows, many=True).data

    def _earliest_held_until(self, obj: Booking) -> datetime | None:
        """The earliest `held_until` among this booking's currently-`HELD`
        `SeatReservation` rows, or `None` if none are held.

        Deliberately **not** "any non-released row" — a `CONFIRMED`
        reservation's `held_until` is a stale value from before payment
        (`apps.booking.services.create_booking` never clears it, only the
        status), and reading it would resurrect a countdown on an already-
        paid booking. Filtering on `HELD` specifically means "booking
        already paid → no countdown" (the spec's own edge case) falls out
        of this for free: payment moves every reservation to `CONFIRMED`,
        so none is `HELD` any more.

        An open-seating booking has no `SeatReservation` rows at all
        (`create_booking`'s `open_seating` branch never calls
        `create_reservation`), so this is `None` for those too — matching
        the spec.

        `ASSUMPTION`, corrected against the model rather than the spec's
        own wording: the spec also names "quick-book" bookings as holding
        nothing, alongside open seating. That is not what the code does —
        `apps/booking/tests/test_quick_book.py`'s own module docstring
        states it plainly: quick book is "not open seating: real
        `SeatReservation` rows are written against real `Seat`s". A
        quick-book booking holds a real seat with a real `held_until`,
        the same as one where the passenger picked their own seat, so it
        gets a real countdown here — the spec's claim was an
        overgeneralisation from open seating, not a data-model fact.
        """
        held_until_values = [
            reservation.held_until
            for reservation in self._reservations(obj)
            if reservation.status == SeatReservation.Status.HELD
            and reservation.held_until is not None
        ]
        return min(held_until_values) if held_until_values else None

    @extend_schema_field(serializers.DateTimeField(allow_null=True))
    def get_hold_expires_at(self, obj: Booking) -> datetime | None:
        return self._earliest_held_until(obj)

    @extend_schema_field(serializers.IntegerField(allow_null=True))
    def get_hold_expires_in_seconds(self, obj: Booking) -> int | None:
        # Floored at zero, never negative: the sweep task
        # (apps.seating.tasks.expire_seat_holds) runs once a minute, so a
        # hold can be past its `held_until` for up to that long before it
        # is actually marked `expired`. The *duration*, not the timestamp,
        # is what the client counts down from — a device with a wrong
        # clock still gets a correct countdown this way (see the spec's
        # own reasoning for returning both fields).
        held_until = self._earliest_held_until(obj)
        if held_until is None:
            return None
        return max(0, int((held_until - timezone.now()).total_seconds()))


class BookingChangeSeatSerializer(serializers.Serializer):
    """POST /bookings/{id}/reservations/{reservation_id}/change-seat/
    body — docs/specs/22-marketplace.md slice 3. Just the new seat; which
    reservation is moving comes from the URL, and everything else about
    it (trip, stops, fare, traveler) is carried over unchanged by
    `apps.seating.services.change_seat`."""

    seat = serializers.UUIDField()

    def validate_seat(self, value: Any) -> Seat:
        return _resolve_seat(value)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        reservation: SeatReservation = self.context["reservation"]
        # The operator's own policy, not a passenger preference —
        # `seat_selection_enabled=False` (true quick-book) means the
        # Business has already said passengers do not choose, and this
        # endpoint must not become a backdoor around that for the one
        # channel (marketplace) that auto-allocates instead of asking.
        if not reservation.trip.business.seat_selection_enabled:
            raise serializers.ValidationError(
                {"seat": "This operator assigns seats — they can't be changed."},
                code="seat_selection_disabled",
            )
        seat: Seat = attrs["seat"]
        if seat.id == reservation.seat_id:
            raise serializers.ValidationError(
                {"seat": "This is already the seat on this reservation."},
                code="same_seat",
            )
        vehicle = reservation.trip.vehicle
        if vehicle is None or seat.vehicle_type_id != vehicle.vehicle_type_id:
            raise serializers.ValidationError(
                {"seat": "This seat does not belong to this trip's vehicle."},
                code="seat_vehicle_mismatch",
            )
        return attrs


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
    """Query shape for the staff-facing GET /bookings/.

    `business` was missing until spec 14 slice 3b, which meant
    client-admin's booking list spanned every Business under the Client
    while its header switcher claimed one was active — the identical gap
    `TripListQuerySerializer` already records having had. Tenancy was
    never breached (`.objects` and RLS both hold at the Client
    boundary); the screen simply lied about its scope.

    `search` matches the route's name or the passenger's email, which is
    what a support call actually gives you. Applied in the view, and it
    only ever narrows.
    """

    business = serializers.UUIDField(required=False)
    trip = serializers.UUIDField(required=False)
    status = serializers.ChoiceField(choices=Booking.Status.choices, required=False)
    # `allow_blank`: the filter bar emits '' when its search box is
    # cleared, and rejecting that would 400 on the way back to the
    # unfiltered list.
    search = serializers.CharField(required=False, allow_blank=True)

    def validate_business(self, value: Any) -> Business:
        # Same tenant-scoped-lookup-or-400 convention as every sibling
        # list: an unknown OR another Client's Business id must fail
        # here, not silently return an unfiltered list.
        try:
            return Business.objects.get(pk=value)
        except Business.DoesNotExist:
            raise serializers.ValidationError(
                "Unknown business.", code="unknown_business"
            ) from None

    def validate_trip(self, value: Any) -> Trip:
        return _resolve_trip(value)


# --- manifest --------------------------------------------------------------
# docs/specs/18-manifest-and-staff-booking.md slice 1. Schema-only
# shapes: the view builds plain dicts through `apps.booking.manifest`
# and these exist so drf-spectacular emits real types rather than
# inferring `Any` — the same reason
# `apps.scheduling.serializers.TripRouteSerializer` exists.


class ManifestTripSerializer(serializers.Serializer):
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


class ManifestTotalsSerializer(serializers.Serializer):
    passengers = serializers.IntegerField()
    boarded = serializers.IntegerField()
    #: Null when no vehicle is assigned — unknowable, not zero.
    capacity = serializers.IntegerField(allow_null=True)


class ManifestPrepaidRowSerializer(serializers.Serializer):
    #: Both null on a booking that holds a seat but has **no ticket
    #: yet** — a ticket is issued at payment, and with no cash account in
    #: the ledger (ADR-0006) an unpaid counter booking is the ordinary
    #: outcome of selling at a desk, not an edge case. The screen renders
    #: the null as "Not issued"; `booking_status` beside it says why.
    ticket_id = serializers.UUIDField(allow_null=True)
    booking_id = serializers.UUIDField()
    booking_reference = serializers.CharField()
    passenger_name = serializers.CharField()
    #: Null throughout on an open-seating trip, which sells places
    #: rather than seats.
    seat_number = serializers.CharField(allow_null=True)
    ticket_status = serializers.CharField(allow_null=True)
    booking_status = serializers.CharField()
    fare = serializers.DecimalField(max_digits=10, decimal_places=2, allow_null=True)
    currency = serializers.CharField()
    boarded_at = serializers.DateTimeField(allow_null=True)
    is_cancelled = serializers.BooleanField()


class ManifestJourneyRowSerializer(serializers.Serializer):
    journey_id = serializers.UUIDField()
    passenger_name = serializers.CharField()
    board_stop = serializers.CharField()
    #: Both null while the journey is open — the passenger is aboard.
    alight_stop = serializers.CharField(allow_null=True)
    journey_status = serializers.CharField()
    fare = serializers.DecimalField(max_digits=10, decimal_places=2, allow_null=True)
    currency = serializers.CharField()
    boarded_at = serializers.DateTimeField()
    alighted_at = serializers.DateTimeField(allow_null=True)


class TripManifestSerializer(serializers.Serializer):
    """The envelope.

    `kind` is what makes this readable: a pay-as-you-go trip sells no
    bookings and issues no tickets, so an empty `results` on one would
    say "nobody is aboard" when the bus is full. `results` is typed as
    the prepaid row here because a schema needs one shape; the PAYG
    branch is documented on the endpoint and carries
    `ManifestJourneyRowSerializer` rows.
    """

    trip = ManifestTripSerializer()
    kind = serializers.ChoiceField(choices=MANIFEST_KIND_CHOICES)
    totals = ManifestTotalsSerializer()
    count = serializers.IntegerField()
    next = serializers.CharField(allow_null=True)
    previous = serializers.CharField(allow_null=True)
    # A **union of the two row shapes**, not `DictField`. A plain
    # `ListField(child=DictField())` generates `{[key: string]:
    # unknown}[]` in `schema.ts`, which hands the frontend an untyped
    # bag and defeats the point of a generated client. `kind` is the
    # discriminator the consumer branches on.
    results = serializers.SerializerMethodField()

    @extend_schema_field(
        PolymorphicProxySerializer(
            component_name="ManifestRow",
            serializers=[ManifestPrepaidRowSerializer, ManifestJourneyRowSerializer],
            resource_type_field_name=None,
            many=True,
        )
    )
    def get_results(self, obj: Any) -> Any:
        # Never called: this serializer is schema-only, and the view
        # renders each row through its own serializer so the wire format
        # and the schema come from the same declaration.
        raise NotImplementedError


class StaffBookingPaymentSerializer(serializers.Serializer):
    """What happened to the money — always present, never left for the
    caller to infer from the booking's status."""

    status = serializers.ChoiceField(choices=STAFF_BOOKING_PAYMENT_STATUS_CHOICES)
    reason = serializers.CharField(
        allow_blank=True, help_text="Empty unless something needs explaining."
    )
    payment_intent = serializers.UUIDField(allow_null=True)


class StaffBookingSerializer(serializers.Serializer):
    """`POST /bookings/staff/`'s response: the booking, and separately
    what happened to the money.

    Two top-level keys rather than a `payment_status` field on the
    booking. The booking is a `Booking` and belongs to every other
    endpoint that returns one; the payment outcome is about *this
    request*. Flattening them would put a field on the shared shape that
    only one endpoint ever fills in.
    """

    booking = BookingSerializer()
    payment = StaffBookingPaymentSerializer()
