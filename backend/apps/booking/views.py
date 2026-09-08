"""Views for apps.booking — see docs/specs/4-fares-seating-booking.md §3."""

from collections import defaultdict
from collections.abc import Sequence
from typing import Any

from django.db.models import Q, QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
from rest_framework.pagination import LimitOffsetPagination
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from apps.analytics.filters import apply_to_booking_records, resolve_filters
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.permissions import HasPermission
from apps.fares.services import FareNotConfigured
from apps.identity.models import User
from apps.scheduling.models import Trip
from apps.seating.models import SeatReservation
from apps.seating.services import SeatUnavailable
from apps.ticketing.capacity import TripNotConfigured, TripSoldOut

from .manifest import (
    PAY_AS_YOU_GO,
    journey_queryset,
    journey_row,
    manifest_kind,
    prepaid_rows,
    trip_summary,
)
from .manifest import totals as manifest_totals
from .models import Booking
from .serializers import (
    BookingCancelSerializer,
    BookingCreateSerializer,
    BookingListQuerySerializer,
    BookingSerializer,
    ManifestJourneyRowSerializer,
    ManifestPrepaidRowSerializer,
    StaffBookingCreateSerializer,
    StaffBookingSerializer,
    TripManifestSerializer,
)
from .services import cancel_booking, create_booking
from .staff import create_staff_booking

_BUSINESS_QUERY_PARAM = OpenApiParameter(
    "business",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single Business's bookings. An unknown or "
    "another Client's Business id returns 400.",
)
_SEARCH_QUERY_PARAM = OpenApiParameter(
    "search",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Case-insensitive substring match on the route name or the "
    "passenger's email.",
)
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
#: Spec 16 slice 4. This list narrows through `apps.analytics.filters`
#: now, so it accepts that module's period — and `GET /exports/bookings/`
#: reads the identical params, which is what makes exporting the current
#: view true rather than approximately true.
_DATE_FROM_QUERY_PARAM = OpenApiParameter(
    "date_from",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Inclusive start, as a local date. Omitting both dates lists every "
    "booking rather than defaulting to a period — a list is bounded by its "
    "pagination, not by a window nothing on screen mentions.",
)
_DATE_TO_QUERY_PARAM = OpenApiParameter(
    "date_to", str, OpenApiParameter.QUERY, required=False, description="Inclusive end."
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
    get=extend_schema(
        parameters=[
            _BUSINESS_QUERY_PARAM,
            _TRIP_QUERY_PARAM,
            _STATUS_QUERY_PARAM,
            _SEARCH_QUERY_PARAM,
            _DATE_FROM_QUERY_PARAM,
            _DATE_TO_QUERY_PARAM,
        ]
    ),
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
        """Narrowed through `apps.analytics.filters`, the same shared
        module `GET /payments/` uses — spec 16 slice 4.

        **This is what makes `GET /exports/bookings/` an export of the
        current view** rather than of a different set that happens to
        look similar. Before it, this list hand-wrote its own chain and
        the export honoured only `business`: a status-filtered screen
        would have exported every status, silently.

        `?status=` is accepted for backward compatibility and mapped onto
        the shared `booking_status` dimension. The two are named apart on
        purpose — the shared `status` is a *PaymentIntent* status, and one
        field validated against two enums is how `?status=paid` would have
        become a 400 on this very list.

        `trip` and `search` stay local, the same way `search` stays local
        on `GET /payments/`: neither is an aggregation dimension, so
        neither belongs in a filter set the summary endpoints also read.
        """
        # Never a bare `queryset = Booking.objects.all()` class
        # attribute — see apps.network.views.RouteListCreateView's own
        # get_queryset() docstring for why that freezes empty forever.
        # "trip__route", not just "trip": BookingSerializer.get_trip
        # embeds the route name, which is one query per row without the
        # deeper join.
        queryset = Booking.objects.select_related("trip__route", "passenger").all()
        query = BookingListQuerySerializer(data=self.request.query_params.dict())
        query.is_valid(raise_exception=True)

        params = self.request.query_params.dict()
        status_filter = query.validated_data.get("status")
        if status_filter is not None:
            params["booking_status"] = status_filter
        # `status` means PaymentIntent to the shared serializer, and a
        # Booking status would 400 against its choices.
        params.pop("status", None)
        queryset = apply_to_booking_records(queryset, resolve_filters(params))

        trip = query.validated_data.get("trip")
        if trip is not None:
            queryset = queryset.filter(trip=trip)

        # Both joins are already in the `select_related` above, so this
        # adds no query. Narrows only — no term a caller can type reaches
        # another Client's rows.
        search = query.validated_data.get("search", "").strip()
        if search:
            queryset = queryset.filter(
                Q(trip__route__name__icontains=search) | Q(passenger__email__icontains=search)
            )

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
            data = serializer.validated_data
            booking = create_booking(
                trip=data["trip"],
                passenger=user,
                seats=data.get("seats"),
                passenger_count=data.get("passenger_count"),
                from_stop=data.get("from_stop"),
                to_stop=data.get("to_stop"),
                idempotency_key=idempotency_key,
            )
        except FareNotConfigured as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except TripNotConfigured as exc:
            # 409, and deliberately *not* the same response as sold-out:
            # nobody has assigned a vehicle to this departure yet, so
            # "full" would be a lie and the fix belongs to an operator,
            # not the passenger (docs/adr/0008).
            return Response(
                {"detail": str(exc), "code": "not_configured"}, status=status.HTTP_409_CONFLICT
            )
        except TripSoldOut as exc:
            return Response(
                {"detail": str(exc), "code": "sold_out"}, status=status.HTTP_409_CONFLICT
            )
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


_INCLUDE_CANCELLED_PARAM = OpenApiParameter(
    "include_cancelled",
    bool,
    OpenApiParameter.QUERY,
    required=False,
    description="Include cancelled and expired bookings, each flagged with "
    "`is_cancelled`. Excluded by default. `pending_payment` bookings are "
    "always included regardless — an operator needs to know a held seat is "
    "unpaid.",
)


@extend_schema(
    responses=TripManifestSerializer,
    parameters=[_INCLUDE_CANCELLED_PARAM],
)
class TripManifestView(generics.GenericAPIView[Trip]):
    """`GET /trips/{id}/manifest/` — who is aboard.

    Gated on `booking.view`, which Owner, Manager **and** Staff already
    hold: the person who most needs this is the one standing at the
    door. `booking.manage` (slice 2) is a different authority — creating
    a financial obligation for someone else — and is not required here.

    Lives in `apps.booking` rather than `apps.scheduling` even though the
    path is under `trips/`, matching how `apps.fares` owns
    `trips/{id}/fare/` and `apps.tapngo` owns `trips/{id}/taps/`: the
    app that owns the data owns the endpoint, and the codename follows
    the data.

    Another Client's trip is a 404 rather than a 403 — the tenant-scoped
    manager simply does not contain it, and "forbidden" would confirm it
    exists.
    """

    permission_classes = [HasPermission("booking.view")]
    serializer_class = TripManifestSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        # A method, never a `queryset =` class attribute: that is
        # evaluated once at import time, before any tenancy context
        # exists, and freezes empty forever.
        return Trip.objects.select_related("route", "business", "vehicle", "driver").all()

    def get(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(self.get_queryset(), pk=pk)
        include_cancelled = str(
            request.query_params.get("include_cancelled", "")
        ).lower() in ("true", "1")
        kind = manifest_kind(trip)

        # Its own paginator rather than `self.paginate_queryset`. That
        # helper is typed against the view's single model, and this
        # endpoint deliberately lists two — `GenericAPIView[Trip]` is
        # what makes `get_queryset` mean the trip lookup. Same
        # `LimitOffsetPagination` the rest of the API uses; nothing
        # about the wire format changes.
        paginator = LimitOffsetPagination()

        # Each branch builds its own rows rather than sharing one
        # `row(...)` callable. The two list different models — which is
        # the fact `kind` exists to state — and a shared callable would
        # be a `Callable[[Any], ...]` that typecheckers cannot narrow and
        # readers cannot follow.
        if kind == PAY_AS_YOU_GO:
            journeys = journey_queryset(trip=trip)
            journey_page = paginator.paginate_queryset(journeys, request, view=self)
            journey_source = journeys if journey_page is None else journey_page
            # **Through the serializer, not straight to `Response`.** A
            # plain dict does not coerce `Decimal`, so `fare` would go
            # out as a JSON float while the generated `schema.ts` — built
            # from these same serializers — promises a string. The
            # recorded trap, caught here by this endpoint's own test.
            rows = ManifestJourneyRowSerializer(
                [journey_row(journey) for journey in journey_source], many=True
            ).data
            paginated = journey_page is not None
        else:
            # A **list**, because a prepaid manifest is a merge of two
            # queries: issued tickets, and bookings that hold a seat
            # without one yet. `LimitOffsetPagination` pages a sequence
            # as happily as a queryset, and a trip's worth of rows is
            # bounded by its vehicle.
            prepaid = prepaid_rows(trip=trip, include_cancelled=include_cancelled)
            prepaid_page = paginator.paginate_queryset(prepaid, request, view=self)
            prepaid_source = prepaid if prepaid_page is None else prepaid_page
            rows = ManifestPrepaidRowSerializer(list(prepaid_source), many=True).data
            paginated = prepaid_page is not None

        body: dict[str, Any] = {
            "trip": trip_summary(trip),
            "kind": kind,
            # Counted over the whole trip, never over the page. A
            # manifest whose totals changed as you paged would be
            # useless for the one question it answers.
            "totals": manifest_totals(
                trip=trip, kind=kind, include_cancelled=include_cancelled
            ),
            "results": rows,
        }
        if paginated:
            envelope = paginator.get_paginated_response(rows)
            body["count"] = envelope.data["count"]
            body["next"] = envelope.data["next"]
            body["previous"] = envelope.data["previous"]
        else:
            body["count"] = len(rows)
            body["next"] = None
            body["previous"] = None
        return Response(body)


@extend_schema(
    request=StaffBookingCreateSerializer,
    responses=StaffBookingSerializer,
    parameters=[_IDEMPOTENCY_KEY_PARAM],
)
class StaffBookingCreateView(generics.GenericAPIView[Booking]):
    """`POST /bookings/staff/` — book for a passenger at the counter
    (docs/specs/18-manifest-and-staff-booking.md slice 2).

    Gated on **`booking.manage`**, which Owner and Manager hold and
    Staff deliberately do not. Reading a manifest (`booking.view`) and
    creating a financial obligation for someone who is not in the room
    are different authorities, and the second is the one that needs a
    name on it.

    Every rejection a passenger would meet is met here identically,
    because the body is validated by a subclass of the passenger's own
    serializer and the write goes through the same service. The
    exception list below is `BookingListCreateView.create`'s, unchanged
    — deliberately not shortened, since a counter agent needs the *same*
    distinctions a passenger gets (a departure with no vehicle assigned
    is an operator's problem, not a full bus).

    **No cash tender.** ADR-0006's chart of accounts has no cash
    account, so a counter agent either settles from the passenger's
    wallet or leaves the booking `pending_payment` for them to pay. This
    is the single biggest limitation of the flow and it is deliberate —
    inventing a cash account is a ledger change needing an ADR
    amendment, a float model and a reconciliation story.
    """

    permission_classes = [HasPermission("booking.manage")]
    serializer_class = StaffBookingCreateSerializer

    def get_queryset(self) -> QuerySet[Booking]:
        return Booking.objects.all()

    def post(self, request: Request, *args: object, **kwargs: object) -> Response:
        idempotency_key = request.headers.get("Idempotency-Key")
        if not idempotency_key:
            return Response(
                {"detail": "Idempotency-Key header is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = StaffBookingCreateSerializer(
            data=request.data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        actor = request.user
        assert isinstance(actor, User)
        data = serializer.validated_data
        try:
            booking, payment = create_staff_booking(
                trip=data["trip"],
                passenger=data["passenger"],
                booked_by=actor,
                seats=data.get("seats"),
                passenger_count=data.get("passenger_count"),
                from_stop=data.get("from_stop"),
                to_stop=data.get("to_stop"),
                pay_from_wallet=data["pay_from_wallet"],
                idempotency_key=idempotency_key,
            )
        except FareNotConfigured as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except TripNotConfigured as exc:
            return Response(
                {"detail": str(exc), "code": "not_configured"}, status=status.HTTP_409_CONFLICT
            )
        except TripSoldOut as exc:
            return Response(
                {"detail": str(exc), "code": "sold_out"}, status=status.HTTP_409_CONFLICT
            )
        except SeatUnavailable as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except IdempotencyKeyConflict as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)

        return Response(
            StaffBookingSerializer({"booking": booking, "payment": payment}).data,
            status=status.HTTP_201_CREATED,
        )
