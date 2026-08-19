"""Views for apps.booking — see docs/specs/4-fares-seating-booking.md §3."""

from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.permissions import HasPermission
from apps.fares.services import FareNotConfigured
from apps.identity.models import User
from apps.seating.models import SeatReservation
from apps.seating.services import SeatUnavailable

from .models import Booking
from .serializers import (
    BookingCancelSerializer,
    BookingCreateSerializer,
    BookingListQuerySerializer,
    BookingSerializer,
)
from .services import cancel_booking, create_booking

_TRIP_QUERY_PARAM = OpenApiParameter(
    "trip", str, OpenApiParameter.QUERY, required=False, description="Filter to a single Trip."
)
_STATUS_QUERY_PARAM = OpenApiParameter(
    "status",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single status.",
)
_IDEMPOTENCY_KEY_PARAM = OpenApiParameter(
    "Idempotency-Key",
    str,
    OpenApiParameter.HEADER,
    required=True,
    description="Client-generated key. A retried request with the same key and body "
    "returns the original Booking rather than creating a second one.",
)


def _reservations_by_booking(bookings: Sequence[Booking]) -> dict[Any, list[SeatReservation]]:
    """One batched query for every SeatReservation belonging to `bookings`,
    grouped by booking_id — avoids the N-queries-per-row shape a naive
    `BookingSerializer.get_seats` would otherwise run per Booking, the
    same N+1 class `apps.network.views.RouteListCreateView`'s own
    get_queryset() docstring already flags as a real problem in this
    codebase. `SeatReservation.booking` has `related_name="+"`, so this
    can't be a `Prefetch()` — there is no reverse manager to attach one
    to."""
    reservations = SeatReservation.objects.filter(
        booking_id__in=[booking.id for booking in bookings]
    ).select_related("seat", "from_stop", "to_stop")
    grouped: dict[Any, list[SeatReservation]] = defaultdict(list)
    for reservation in reservations:
        grouped[reservation.booking_id].append(reservation)
    return grouped


@extend_schema_view(
    get=extend_schema(parameters=[_TRIP_QUERY_PARAM, _STATUS_QUERY_PARAM]),
    post=extend_schema(
        request=BookingCreateSerializer,
        responses=BookingSerializer,
        parameters=[_IDEMPOTENCY_KEY_PARAM],
    ),
)
class BookingListCreateView(generics.ListCreateAPIView[Booking]):
    """GET is staff-only ops visibility (`booking.view`); POST is the
    passenger-facing booking-creation endpoint — `IsAuthenticated` only,
    no Role/Permission gate, since passengers have no Role
    (docs/adr/0003, and see `apps.fares.views.TripFareView`'s own note
    on this same distinction)."""

    def get_permissions(self) -> list[BasePermission]:
        if self.request.method == "POST":
            return [IsAuthenticated()]
        return [HasPermission("booking.view")()]

    def get_queryset(self) -> QuerySet[Booking]:
        # Never a bare `queryset = Booking.objects.all()` class
        # attribute — see apps.network.views.RouteListCreateView's own
        # get_queryset() docstring for why that freezes empty forever.
        # "trip__route", not just "trip": BookingSerializer.get_trip
        # embeds the route name, which is one query per row without the
        # deeper join.
        queryset = Booking.objects.select_related("trip__route", "passenger").all()
        query = BookingListQuerySerializer(data=self.request.query_params)
        query.is_valid(raise_exception=True)
        trip = query.validated_data.get("trip")
        status_filter = query.validated_data.get("status")
        if trip is not None:
            queryset = queryset.filter(trip=trip)
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)
        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Booking]]:
        return BookingCreateSerializer if self.request.method == "POST" else BookingSerializer

    def list(self, request: Request, *args: object, **kwargs: object) -> Response:
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        bookings = page if page is not None else list(queryset)
        context = {
            **self.get_serializer_context(),
            "reservations_by_booking": _reservations_by_booking(bookings),
        }
        serializer = BookingSerializer(bookings, many=True, context=context)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return Response(
                {"detail": "Idempotency-Key header is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = BookingCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        try:
            booking = create_booking(
                trip=serializer.validated_data["trip"],
                passenger=user,
                seats=serializer.validated_data["seats"],
                idempotency_key=idempotency_key,
            )
        except FareNotConfigured as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except SeatUnavailable as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except IdempotencyKeyConflict as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(BookingSerializer(booking).data, status=status.HTTP_201_CREATED)


class BookingMineView(generics.ListAPIView[Booking]):
    """GET /bookings/mine/ — the passenger's own booking history."""

    permission_classes = [IsAuthenticated]
    serializer_class = BookingSerializer

    def get_queryset(self) -> QuerySet[Booking]:
        user = self.request.user
        assert isinstance(user, User)
        # "trip__route" — see BookingListCreateView.get_queryset().
        return Booking.objects.select_related("trip__route", "passenger").filter(passenger=user)

    def list(self, request: Request, *args: object, **kwargs: object) -> Response:
        queryset = self.filter_queryset(self.get_queryset())
        page = self.paginate_queryset(queryset)
        bookings = page if page is not None else list(queryset)
        context = {
            **self.get_serializer_context(),
            "reservations_by_booking": _reservations_by_booking(bookings),
        }
        serializer = BookingSerializer(bookings, many=True, context=context)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)


@extend_schema(request=BookingCancelSerializer, responses=BookingSerializer)
class BookingCancelView(generics.GenericAPIView[Booking]):
    """POST /bookings/{id}/cancel/ — passenger, own booking only. No
    `booking.manage` codename exists for staff (§2 of the spec): staff
    can see Bookings (`booking.view`), not cancel them on a passenger's
    behalf, this phase."""

    permission_classes = [IsAuthenticated]
    serializer_class = BookingCancelSerializer

    def get_queryset(self) -> QuerySet[Booking]:
        return Booking.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        booking = get_object_or_404(self.get_queryset(), pk=pk)
        user = request.user
        assert isinstance(user, User)
        if booking.passenger_id != user.id:
            return Response(
                {"detail": "You cannot cancel another passenger's booking."},
                status=status.HTTP_403_FORBIDDEN,
            )
        serializer = BookingCancelSerializer(data=request.data, context={"booking": booking})
        serializer.is_valid(raise_exception=True)
        updated = cancel_booking(
            booking=booking,
            cancelled_by=user,
            reason=serializer.validated_data.get("reason", ""),
        )
        return Response(BookingSerializer(updated).data)
