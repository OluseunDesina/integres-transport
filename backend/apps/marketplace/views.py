"""Views for apps.marketplace — docs/adr/0009, docs/specs/22-marketplace.md.

Every view here is thin, per this codebase's own convention: input
shape validation plus a single call into either this app's own
cross-Client resolution helpers or an existing, unmodified domain
service (`get_bookability`, `create_booking`, `initiate_payment`).

Split posture, added in spec 22 slice 2 ("browse before you log in"):
the four read-only views (`MarketplaceStopSuggestView`,
`MarketplaceTripSearchView`, `MarketplaceTripAvailabilityView`,
`MarketplaceTripFareView`) are `AllowAny` — a guest can search and
resolve seat availability/fare with no session at all, matching the
Wakanow/TravelBeta/Trip.com reference the marketplace app is modelled
on. `apps.core.middleware.TenancyMiddleware` already tolerates an
absent/invalid Bearer token (it resolves to `client_id=None,
is_platform_staff=False` rather than rejecting the request), and every
one of these four views already runs its cross-Client reads through
`platform_staff_bypass()` rather than relying on the requester's own
RLS context — so nothing about *how* they read changes, only who is
allowed to ask. `MarketplaceBookingCreateView`/
`MarketplacePaymentIntentCreateView` stay `IsAuthenticated`: both need
`request.user` as the booking's passenger, so logging in (or
registering) is the one point a guest is actually required to.
Passengers hold no Role/Permission either way (docs/adr/0003).
"""

from typing import Any

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import Serializer, UUIDField, ValidationError
from rest_framework.views import APIView

from apps.booking.serializers import BookingCreateSerializer, BookingSerializer
from apps.booking.services import create_booking
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.rls import platform_staff_bypass
from apps.fares.serializers import TripFareQuerySerializer, TripFareQuoteSerializer
from apps.fares.services import FareNotConfigured, get_fare
from apps.identity.models import User
from apps.network.serializers import StopSuggestQuerySerializer, StopSuggestSerializer
from apps.payments.psp.paystack import PaystackAPIError
from apps.payments.serializers import PaymentInitiateResponseSerializer
from apps.payments.services import (
    BookingNotPayable,
    PaymentAlreadyPending,
    PspNotConfigured,
    initiate_payment,
)
from apps.scheduling.serializers import TripSearchQuerySerializer, TripSearchResultSerializer
from apps.scheduling.services import TripNotBookable, resolve_bookable_trip_across_clients
from apps.seating.serializers import TripAvailabilityQuerySerializer, TripBookabilitySerializer
from apps.seating.services import SeatUnavailable, get_bookability
from apps.ticketing.capacity import TripNotConfigured, TripSoldOut

from .services import (
    as_client,
    resolve_own_booking_across_clients,
    search_trips_across_clients,
    suggest_stops_across_clients,
)

_IDEMPOTENCY_KEY_PARAM = OpenApiParameter(
    "Idempotency-Key",
    str,
    OpenApiParameter.HEADER,
    required=True,
    description="Client-generated key. A retried request with the same key and body "
    "returns the original result rather than creating a second one — same contract "
    "as apps.booking.views/apps.payments.views's own Idempotency-Key parameter.",
)


class _TripIdSerializer(Serializer):
    """Just enough to know a well-formed Trip id was given, before any
    cross-Client resolution runs — `BookingCreateSerializer.validate_trip`
    cannot be trusted for this first check, since it resolves via
    `.objects` and would 400 "unknown trip" for a perfectly good,
    genuinely cross-Client one."""

    trip = UUIDField()


class BookingIdSerializer(Serializer):
    booking_id = UUIDField()


class MarketplaceBookingCreateSerializer(BookingCreateSerializer):
    """POST /marketplace/bookings/ body — docs/specs/22-marketplace.md
    slice 2. Same rules as the base `BookingCreateSerializer` (both
    exist unchanged, per this module's own docstring), plus one more:
    a marketplace booking is the one place this platform actually
    captures who is travelling, so `traveler` is required here where
    the base serializer leaves it optional for `apps.booking`'s own
    endpoint. A seats-mode booking needs one per seat; a places-mode
    (open-seating/quick-book) booking needs the single top-level one —
    see `TravelerInputSerializer`'s own docstring for that split."""

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        attrs = super().validate(attrs)
        if attrs.get("seats"):
            if any("traveler" not in seat_request for seat_request in attrs["seats"]):
                raise ValidationError(
                    {"seats": "Traveler details are required for every seat."},
                    code="traveler_required",
                )
        elif "traveler" not in attrs:
            raise ValidationError(
                {"traveler": "Traveler details are required."}, code="traveler_required"
            )
        return attrs


@extend_schema(
    parameters=[
        OpenApiParameter("q", str, OpenApiParameter.QUERY, required=False),
        OpenApiParameter("limit", int, OpenApiParameter.QUERY, required=False),
    ],
    responses=StopSuggestSerializer(many=True),
)
class MarketplaceStopSuggestView(APIView):
    """GET /marketplace/stops/suggest/?q=&limit= — the cross-Client
    variant of `apps.network.views.StopSuggestView`. A bare list, not a
    paginated envelope, same reasoning as that view. `AllowAny` — see
    this module's own docstring."""

    permission_classes = [AllowAny]

    def get(self, request: Request) -> Response:
        query = StopSuggestQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        stops = suggest_stops_across_clients(
            q=query.validated_data["q"].strip(), limit=query.validated_data["limit"]
        )
        return Response(StopSuggestSerializer(stops, many=True).data)


@extend_schema(responses=TripSearchResultSerializer(many=True))
class MarketplaceTripSearchView(generics.GenericAPIView[Any]):
    """GET /marketplace/trips/search/ — the cross-Client variant of
    `apps.scheduling.views.TripSearchView`. Same query shape
    (`TripSearchQuerySerializer` is plain field validation with no
    tenant-scoped lookups, so it is reused unchanged), same paginated
    response shape. `AllowAny` — see this module's own docstring."""

    permission_classes = [AllowAny]
    serializer_class = TripSearchResultSerializer

    def get(self, request: Request) -> Response:
        query = TripSearchQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        results = search_trips_across_clients(
            origin=query.validated_data["origin"],
            destination=query.validated_data["destination"],
            service_date=query.validated_data["service_date"],
            trip_class=query.validated_data.get("trip_class"),
        )
        page = self.paginate_queryset(results)
        serializer = self.get_serializer(page, many=True)
        return self.get_paginated_response(serializer.data)


@extend_schema(
    parameters=[
        OpenApiParameter("from_stop", str, OpenApiParameter.QUERY, required=True),
        OpenApiParameter("to_stop", str, OpenApiParameter.QUERY, required=True),
    ],
    responses=TripBookabilitySerializer,
)
class MarketplaceTripAvailabilityView(APIView):
    """GET /marketplace/trips/{id}/availability/ — the cross-Client
    variant of `apps.seating.views.TripAvailabilityView`. The Trip is
    resolved via `resolve_bookable_trip_across_clients` first (mapped to
    404 on `TripNotBookable`); `TripAvailabilityQuerySerializer`'s own
    `from_stop`/`to_stop` resolution is `.objects`-based, so it only runs
    once the ORM contextvar is pointed at the Trip's own Client.
    `AllowAny` — see this module's own docstring."""

    permission_classes = [AllowAny]

    def get(self, request: Request, pk: str) -> Response:
        try:
            trip = resolve_bookable_trip_across_clients(trip_id=pk)
        except TripNotBookable:
            return Response(status=status.HTTP_404_NOT_FOUND)

        with platform_staff_bypass(), as_client(trip.client_id):
            query = TripAvailabilityQuerySerializer(data=request.query_params)
            query.is_valid(raise_exception=True)
            bookability = get_bookability(
                trip=trip,
                from_stop=query.validated_data["from_stop"],
                to_stop=query.validated_data["to_stop"],
            )
        return Response(
            TripBookabilitySerializer(
                {
                    "booking_mode": bookability.booking_mode,
                    "trip_class": trip.trip_class,
                    "status": bookability.status,
                    "seats": bookability.seats,
                    "capacity_remaining": bookability.capacity_remaining,
                    "seat_selection_enabled": bookability.seat_selection_enabled,
                }
            ).data
        )


@extend_schema(
    parameters=[
        OpenApiParameter("from_stop", str, OpenApiParameter.QUERY, required=True),
        OpenApiParameter("to_stop", str, OpenApiParameter.QUERY, required=True),
    ],
    responses=TripFareQuoteSerializer,
)
class MarketplaceTripFareView(APIView):
    """GET /marketplace/trips/{id}/fare/ — the cross-Client variant of
    `apps.fares.views.TripFareView`. `seat-picker` calls this
    independently of the search result's own embedded fare (prices can
    move between search and seat selection); same resolve-then-assume-
    Client pattern as `MarketplaceTripAvailabilityView`. `AllowAny` —
    see this module's own docstring."""

    permission_classes = [AllowAny]

    def get(self, request: Request, pk: str) -> Response:
        try:
            trip = resolve_bookable_trip_across_clients(trip_id=pk)
        except TripNotBookable:
            return Response(status=status.HTTP_404_NOT_FOUND)

        with platform_staff_bypass(), as_client(trip.client_id):
            query = TripFareQuerySerializer(data=request.query_params)
            query.is_valid(raise_exception=True)
            try:
                quote = get_fare(
                    trip=trip,
                    from_stop=query.validated_data["from_stop"],
                    to_stop=query.validated_data["to_stop"],
                )
            except FareNotConfigured as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            TripFareQuoteSerializer({"amount": quote.amount, "currency": quote.currency}).data
        )


@extend_schema(
    request=MarketplaceBookingCreateSerializer,
    responses=BookingSerializer,
    parameters=[_IDEMPOTENCY_KEY_PARAM],
)
class MarketplaceBookingCreateView(APIView):
    """POST /marketplace/bookings/ — the cross-Client variant of
    `apps.booking.views.BookingListCreateView`'s `create()`. Same body
    shape, same error mapping; `BookingCreateSerializer`/`create_booking`
    both run unmodified, once the resolved Trip's own Client is assumed
    (docs/adr/0009's third mechanism) — everything they read or write
    (`FareRule`, `Seat`, `Booking` itself) belongs to that Client, not
    the passenger's own (Marketplace) one."""

    permission_classes = [IsAuthenticated]

    def post(self, request: Request) -> Response:
        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return Response(
                {"detail": "Idempotency-Key header is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        trip_id_check = _TripIdSerializer(data=request.data)
        trip_id_check.is_valid(raise_exception=True)
        try:
            trip = resolve_bookable_trip_across_clients(
                trip_id=str(trip_id_check.validated_data["trip"])
            )
        except TripNotBookable:
            return Response(status=status.HTTP_404_NOT_FOUND)

        user = request.user
        assert isinstance(user, User)
        with platform_staff_bypass(), as_client(trip.client_id):
            serializer = MarketplaceBookingCreateSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            try:
                data = serializer.validated_data
                booking = create_booking(
                    trip=data["trip"],
                    passenger=user,
                    seats=data.get("seats"),
                    passenger_count=data.get("passenger_count"),
                    from_stop=data.get("from_stop"),
                    to_stop=data.get("to_stop"),
                    traveler=data.get("traveler"),
                    idempotency_key=idempotency_key,
                )
            except FareNotConfigured as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
            except TripNotConfigured as exc:
                return Response(
                    {"detail": str(exc), "code": "not_configured"},
                    status=status.HTTP_409_CONFLICT,
                )
            except TripSoldOut as exc:
                return Response(
                    {"detail": str(exc), "code": "sold_out"}, status=status.HTTP_409_CONFLICT
                )
            except SeatUnavailable as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
            except IdempotencyKeyConflict as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
            response_body = BookingSerializer(booking).data
        return Response(response_body, status=status.HTTP_201_CREATED)


@extend_schema(
    request=BookingIdSerializer,
    responses=PaymentInitiateResponseSerializer,
    parameters=[_IDEMPOTENCY_KEY_PARAM],
)
class MarketplacePaymentIntentCreateView(APIView):
    """POST /marketplace/payments/ — the cross-Client variant of
    `apps.payments.views.PaymentListCreateView`'s `create()`, booking-only
    (no wallet top-up or wallet-balance blend — out of scope for this
    slice, docs/specs/22-marketplace.md). The Booking is resolved via
    `resolve_own_booking_across_clients` (the "my own record" shape,
    docs/adr/0009) rather than `_resolve_booking`, since the latter is
    `.objects`-scoped to the wrong Client at this point."""

    permission_classes = [IsAuthenticated]

    def post(self, request: Request) -> Response:
        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return Response(
                {"detail": "Idempotency-Key header is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        booking_id_check = BookingIdSerializer(data=request.data)
        booking_id_check.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        booking = resolve_own_booking_across_clients(
            booking_id=str(booking_id_check.validated_data["booking_id"]), passenger=user
        )
        if booking is None:
            return Response(status=status.HTTP_404_NOT_FOUND)

        with platform_staff_bypass(), as_client(booking.client_id):
            try:
                intent = initiate_payment(
                    booking=booking, passenger=user, idempotency_key=idempotency_key
                )
            except PspNotConfigured as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
            except (PaymentAlreadyPending, BookingNotPayable, IdempotencyKeyConflict) as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
            except PaystackAPIError as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
            response_body = PaymentInitiateResponseSerializer(intent).data
        return Response(response_body, status=status.HTTP_201_CREATED)
