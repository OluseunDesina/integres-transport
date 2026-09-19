from django.db.models import QuerySet
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import generics, status
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer

from apps.businesses.models import Business
from apps.core.permissions import HasPermission
from apps.fares.services import FareNotConfigured, get_fare
from apps.identity.models import User
from apps.network.services import find_route_stop_matches

from .models import Schedule, Trip
from .serializers import (
    ScheduleCreateSerializer,
    ScheduleSerializer,
    SchedulingListQuerySerializer,
    TripAssignmentSerializer,
    TripClassSerializer,
    TripCreateSerializer,
    TripListQuerySerializer,
    TripSearchQuerySerializer,
    TripSearchResultSerializer,
    TripSerializer,
    TripStatusSerializer,
)
from .services import (
    TripClassLocked,
    TripClassNotAvailableOnRoute,
    VehicleClassMismatch,
    assign_trip_resources,
    set_trip_class,
    transition_trip_status,
)

_BUSINESS_QUERY_PARAM = OpenApiParameter(
    "business",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single Business's rows. An unknown or "
    "another Client's Business id returns 400.",
)
_ROUTE_QUERY_PARAM = OpenApiParameter(
    "route", str, OpenApiParameter.QUERY, required=False, description="Filter to a single Route."
)
_SCHEDULE_QUERY_PARAM = OpenApiParameter(
    "schedule",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single Schedule.",
)
_SERVICE_DATE_QUERY_PARAM = OpenApiParameter(
    "service_date",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single service_date (YYYY-MM-DD).",
)
_STATUS_QUERY_PARAM = OpenApiParameter(
    "status", str, OpenApiParameter.QUERY, required=False, description="Filter to a single status."
)
_TRIP_CLASS_QUERY_PARAM = OpenApiParameter(
    "trip_class",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to a single service class (premium/exclusive/standard/mini).",
)


_SCHEDULE_SEARCH_QUERY_PARAM = OpenApiParameter(
    "search",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Case-insensitive substring match on the schedule's route "
    "name. A Schedule has no name of its own.",
)

_SCHEDULE_IS_ACTIVE_QUERY_PARAM = OpenApiParameter(
    "is_active",
    bool,
    OpenApiParameter.QUERY,
    required=False,
    description="Filter to active or inactive schedules. Omit for both.",
)


@extend_schema_view(
    get=extend_schema(
        parameters=[
            _BUSINESS_QUERY_PARAM,
            _SCHEDULE_SEARCH_QUERY_PARAM,
            _SCHEDULE_IS_ACTIVE_QUERY_PARAM,
        ]
    ),
    post=extend_schema(request=ScheduleCreateSerializer, responses=ScheduleSerializer),
)
class ScheduleListCreateView(generics.ListCreateAPIView[Schedule]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "scheduling.manage" if self.request.method == "POST" else "scheduling.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Schedule]:
        queryset = Schedule.objects.select_related("route", "business").all()
        # `.dict()`, not the QueryDict itself. DRF's `BooleanField.get_value`
        # treats any mapping with `getlist` as HTML form input, and an HTML
        # form omits an unchecked checkbox — so it substitutes `False` for a
        # *missing* boolean, and `is_active` would silently filter every
        # schedule list to inactive rows on requests that never mentioned it.
        query = SchedulingListQuerySerializer(data=self.request.query_params.dict())
        query.is_valid(raise_exception=True)

        business = query.validated_data.get("business")
        if business is not None:
            queryset = queryset.filter(business=business)

        # Searches the route's name — a Schedule has none of its own.
        # `select_related("route")` above already joins it, so this adds
        # no query.
        search = query.validated_data.get("search", "").strip()
        if search:
            queryset = queryset.filter(route__name__icontains=search)

        is_active = query.validated_data.get("is_active")
        if is_active is not None:
            queryset = queryset.filter(is_active=is_active)

        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Schedule]]:
        return ScheduleCreateSerializer if self.request.method == "POST" else ScheduleSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        schedule = serializer.save()
        return Response(ScheduleSerializer(schedule).data, status=201)


_TRIP_SEARCH_QUERY_PARAM = OpenApiParameter(
    "search",
    str,
    OpenApiParameter.QUERY,
    required=False,
    description="Case-insensitive substring match on the trip's route name. "
    "A Trip has no name of its own.",
)


class ScheduleUpdateView(generics.UpdateAPIView[Schedule]):
    permission_classes = [HasPermission("scheduling.manage")]
    serializer_class = ScheduleSerializer
    http_method_names = ["patch"]

    def get_queryset(self) -> QuerySet[Schedule]:
        return Schedule.objects.all()


@extend_schema_view(
    get=extend_schema(
        parameters=[
            _BUSINESS_QUERY_PARAM,
            _ROUTE_QUERY_PARAM,
            _SCHEDULE_QUERY_PARAM,
            _SERVICE_DATE_QUERY_PARAM,
            _STATUS_QUERY_PARAM,
            _TRIP_CLASS_QUERY_PARAM,
            _TRIP_SEARCH_QUERY_PARAM,
        ]
    ),
    post=extend_schema(request=TripCreateSerializer, responses=TripSerializer),
)
class TripListCreateView(generics.ListCreateAPIView[Trip]):
    def get_permissions(self) -> list[BasePermission]:
        codename = "scheduling.manage" if self.request.method == "POST" else "scheduling.view"
        return [HasPermission(codename)()]

    def get_queryset(self) -> QuerySet[Trip]:
        queryset = Trip.objects.select_related("route", "vehicle", "driver").all()
        query = TripListQuerySerializer(data=self.request.query_params.dict())
        query.is_valid(raise_exception=True)
        business = query.validated_data.get("business")
        route = query.validated_data.get("route")
        schedule = query.validated_data.get("schedule")
        service_date = query.validated_data.get("service_date")
        status_filter = query.validated_data.get("status")
        trip_class = query.validated_data.get("trip_class")
        if trip_class is not None:
            queryset = queryset.filter(trip_class=trip_class)
        if business is not None:
            queryset = queryset.filter(business=business)
        if route is not None:
            queryset = queryset.filter(route=route)
        if schedule is not None:
            queryset = queryset.filter(schedule=schedule)
        if service_date is not None:
            queryset = queryset.filter(service_date=service_date)
        if status_filter is not None:
            queryset = queryset.filter(status=status_filter)

        # `select_related("route")` above already joins it, so this adds
        # no query, and it only ever narrows.
        search = query.validated_data.get("search", "").strip()
        if search:
            queryset = queryset.filter(route__name__icontains=search)

        return queryset

    def get_serializer_class(self) -> type[BaseSerializer[Trip]]:
        return TripCreateSerializer if self.request.method == "POST" else TripSerializer

    def create(self, request: Request, *args: object, **kwargs: object) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        trip = serializer.save()
        return Response(TripSerializer(trip).data, status=201)


@extend_schema(
    parameters=[
        OpenApiParameter(
            "origin",
            str,
            OpenApiParameter.QUERY,
            required=True,
            description="Where the passenger is travelling from — matched "
            "against Stop names (case-insensitive, partial).",
        ),
        OpenApiParameter(
            "destination",
            str,
            OpenApiParameter.QUERY,
            required=True,
            description="Where the passenger is travelling to — matched "
            "against Stop names (case-insensitive, partial).",
        ),
        OpenApiParameter(
            "service_date",
            str,
            OpenApiParameter.QUERY,
            required=True,
            description="The service date to search (YYYY-MM-DD).",
        ),
        _TRIP_CLASS_QUERY_PARAM,
    ],
    responses=TripSearchResultSerializer(many=True),
)
class TripSearchView(generics.GenericAPIView[Trip]):
    """GET /trips/search/ — the passenger-facing Trip search, see
    docs/specs/4-fares-seating-booking-frontend.md §3.3 (reworked:
    origin/destination text instead of a pre-chosen Route — a passenger
    no longer needs to already know which Route connects them).

    A plain `ListAPIView` no longer fits: results come from
    `apps.network.services.find_route_stop_matches` fanning out across
    however many `(route, from_stop, to_stop)` pairs it finds, not one
    queryset — so this builds a plain list of result rows itself and
    hands it to DRF's own pagination machinery, which works on any
    sized, sliceable sequence, not only a queryset.

    Still `IsAuthenticated` + ordinary tenancy scoping only, same
    posture as before and as `apps.network.views.RouteBrowseView`
    (passengers hold no Role/Permission — docs/adr/0003).
    """

    permission_classes = [IsAuthenticated]
    serializer_class = TripSearchResultSerializer

    def get(self, request: Request) -> Response:
        query = TripSearchQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        trip_class = query.validated_data.get("trip_class")

        results: list[dict[str, object]] = []
        matches = find_route_stop_matches(
            origin=query.validated_data["origin"],
            destination=query.validated_data["destination"],
        )
        for match in matches:
            # status and fare_collection_mode are forced here, never read
            # from the query params — a passenger must not be able to
            # widen this to reach a cancelled, completed or
            # pay-as-you-go Trip.
            #
            # Filters on fare_collection_mode, not booking_mode: what
            # makes a trip buyable in advance is that it is prepaid, not
            # that it has assigned seats. Open-seating trips are
            # bookable too (docs/specs/10-booking-modes.md).
            # "business" — TripSearchResultSerializer.get_business_name
            # reads through it; without this it's one extra query per
            # result row. "vehicle__vehicle_type" — TripSerializer.get_vehicle
            # reads through it for the same reason.
            trips = Trip.objects.select_related(
                "route", "vehicle__vehicle_type", "driver", "business"
            ).filter(
                route=match.route,
                service_date=query.validated_data["service_date"],
                status=Trip.Status.SCHEDULED,
                fare_collection_mode=Business.FareCollectionMode.PREPAID,
            )
            # Optional and passenger-supplied, unlike the two forced
            # filters above — narrowing to a class they want is not a
            # way to reach a Trip they should not see.
            if trip_class is not None:
                trips = trips.filter(trip_class=trip_class)
            for trip in trips:
                try:
                    quote = get_fare(trip=trip, from_stop=match.from_stop, to_stop=match.to_stop)
                except FareNotConfigured:
                    # An unpriced trip is excluded from the list rather
                    # than shown with no price — the whole point of this
                    # endpoint post-rework is a price-first result list
                    # (docs/specs/21-passenger-experience.md's own
                    # seat-picker precedent: an unconfigured fare blocks
                    # booking, applied here at the list level since
                    # there is no booking step yet to block).
                    continue
                results.append(
                    {
                        "trip": trip,
                        "from_stop": match.from_stop,
                        "to_stop": match.to_stop,
                        "stops_between": match.stops_between,
                        "fare": {"amount": quote.amount, "currency": quote.currency},
                    }
                )

        page = self.paginate_queryset(results)
        serializer = self.get_serializer(page, many=True)
        return self.get_paginated_response(serializer.data)


@extend_schema(request=TripAssignmentSerializer, responses=TripSerializer)
class TripAssignmentUpdateView(generics.GenericAPIView[Trip]):
    permission_classes = [HasPermission("scheduling.manage")]
    serializer_class = TripAssignmentSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        return Trip.objects.all()

    def patch(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = TripAssignmentSerializer(data=request.data, context={"trip": trip})
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        updated = assign_trip_resources(
            trip=trip,
            vehicle=serializer.validated_data.get("vehicle"),
            driver=serializer.validated_data.get("driver"),
            updated_by=user,
        )
        return Response(TripSerializer(updated).data)


@extend_schema(request=TripStatusSerializer, responses=TripSerializer)
class TripStatusView(generics.GenericAPIView[Trip]):
    permission_classes = [HasPermission("scheduling.manage")]
    serializer_class = TripStatusSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        return Trip.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = TripStatusSerializer(data=request.data, context={"trip": trip})
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        updated = transition_trip_status(
            trip=trip,
            new_status=serializer.validated_data["status"],
            reason=serializer.validated_data.get("reason", ""),
            actor=user,
        )
        return Response(TripSerializer(updated).data)


@extend_schema(request=TripClassSerializer, responses=TripSerializer)
class TripClassView(generics.GenericAPIView[Trip]):
    """POST /trips/{id}/class/ — docs/specs/15-trip-classes.md.

    Its own endpoint rather than a field on the assignment PATCH; see
    TripClassSerializer's docstring for why. Modelled on TripStatusView,
    the other guarded single-field Trip mutation.
    """

    permission_classes = [HasPermission("scheduling.manage")]
    serializer_class = TripClassSerializer

    def get_queryset(self) -> QuerySet[Trip]:
        return Trip.objects.all()

    def post(self, request: Request, pk: str) -> Response:
        trip = get_object_or_404(self.get_queryset(), pk=pk)
        serializer = TripClassSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        assert isinstance(user, User)
        try:
            updated = set_trip_class(
                trip=trip,
                trip_class=serializer.validated_data["trip_class"],
                updated_by=user,
            )
        except TripClassLocked as exc:
            # 409, not 400: the request is well-formed and the class is
            # valid — what refuses it is the state of the Trip, and the
            # operator's next action is a different one entirely
            # (cancel and rebook). Same reasoning as
            # RouteFareMatrixView's own FarePricingModeMismatch branch.
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except (TripClassNotAvailableOnRoute, VehicleClassMismatch) as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(TripSerializer(updated).data)
